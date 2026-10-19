/**
 * @module llm-queue
 * Priority queue for Ollama fleet inference requests.
 * Prevents homelab fleet from being overwhelmed by batch tasks while prioritizing real-time agents.
 */

import { config } from '../config.js';

export const PRIORITY = {
    CRITICAL: 0, // Real-time UI / active IDE session
    HIGH: 1,     // Interactive agent
    MEDIUM: 2,   // Background agent processing
    LOW: 3       // Bulk embeddings / offline tasks
};

export class PriorityQueue {
    constructor(concurrencyOrOptions = 3) {
        if (typeof concurrencyOrOptions === 'object' && concurrencyOrOptions !== null) {
            const eps = Array.isArray(concurrencyOrOptions.endpoints) && concurrencyOrOptions.endpoints.length > 0
                ? concurrencyOrOptions.endpoints
                : this.initEndpoints();
            this.endpoints = eps;
            this.concurrency = concurrencyOrOptions.concurrency || concurrencyOrOptions.concurrencyPerNode || 1;
            this.strictConcurrency = Boolean(concurrencyOrOptions.concurrencyPerNode);
        } else {
            this.concurrency = Number(concurrencyOrOptions) || 3;
            this.endpoints = this.initEndpoints();
            this.strictConcurrency = false;
        }
        this.active = 0;
        this.seq = 0;
        this.queue = [];
        this.rrIndex = 0;
        /** @type {Map<string, { successes: number, failures: number, lastFailAt: number }>} */
        this.stats = new Map();
        this.COOLDOWN_MS = 30_000; // Skip failed endpoints for 30s
        for (const ep of this.endpoints) {
            this.stats.set(ep, { successes: 0, failures: 0, lastFailAt: 0 });
        }
    }

    initEndpoints() {
        // Multi-Family 5-GPU Fleet Policy (AGENTS.md Rule #5):
        // krusch (192.168.1.13:11434 / localhost:11434) is the dedicated bge-large OLLAMA_EMBED_HOST.
        if (process.env.OLLAMA_NODES) {
            const nodes = process.env.OLLAMA_NODES.split(',').map(s => s.trim()).filter(Boolean);
            if (nodes.length > 0) return nodes;
        }
        const primaryUrl = (
            process.env.OLLAMA_EMBED_HOST ||
            process.env.OLLAMA_URL ||
            config?.ai?.ollamaUrl ||
            'http://127.0.0.1:11434'
        ).trim().replace(/\/+$/, '');
        return [primaryUrl];
    }

    /**
     * Get the next endpoint, preferring healthy ones (circuit breaker).
     * Falls back to round-robin if all endpoints are in cooldown.
     * @returns {string}
     */
    getNextEndpoint() {
        const now = Date.now();
        // Try up to endpoints.length times to find a healthy one
        for (let i = 0; i < this.endpoints.length; i++) {
            const idx = (this.rrIndex + i) % this.endpoints.length;
            const ep = this.endpoints[idx];
            const stat = this.stats.get(ep);
            if (!stat || (now - stat.lastFailAt) > this.COOLDOWN_MS) {
                this.rrIndex = (idx + 1) % this.endpoints.length;
                return ep;
            }
        }
        // All in cooldown — fall back to plain round-robin
        const ep = this.endpoints[this.rrIndex];
        this.rrIndex = (this.rrIndex + 1) % this.endpoints.length;
        return ep;
    }

    /** Record a success for an endpoint. */
    recordSuccess(endpoint) {
        const s = this.stats.get(endpoint);
        if (s) { s.successes++; s.lastFailAt = 0; }
    }

    /** Record a failure for an endpoint (triggers cooldown). */
    recordFailure(endpoint) {
        const s = this.stats.get(endpoint);
        if (s) { s.failures++; s.lastFailAt = Date.now(); }
    }

    /**
     * Get fleet health stats for logging/observability.
     * @returns {{ endpoint: string, successes: number, failures: number, healthy: boolean }[]}
     */
    health() {
        const now = Date.now();
        return this.endpoints.map(ep => {
            const s = this.stats.get(ep) || { successes: 0, failures: 0, lastFailAt: 0 };
            return { endpoint: ep, successes: s.successes, failures: s.failures, healthy: (now - s.lastFailAt) > this.COOLDOWN_MS };
        });
    }

    /**
     * Enqueue a task to run against an Ollama endpoint.
     * @param {function(string): Promise<any>} taskFn - The async function to run, receives endpoint URL.
     * @param {number} priority - Lower number = higher priority.
     */
    enqueue(taskFn, priority = PRIORITY.MEDIUM) {
        return new Promise((resolve, reject) => {
            const taskId = Math.random().toString(36).substring(2, 9);
            const queuedAt = Date.now();
            const seq = ++this.seq;
            if (priority <= PRIORITY.HIGH) {
                console.error(`[OllamaQueue] 📥 Enqueued task ${taskId} (Priority: ${priority}, Active: ${this.active}, Pending: ${this.queue.length})`);
            }
            
            this.queue.push({ taskFn, priority, resolve, reject, taskId, queuedAt, seq });
            // Re-sort queue so lowest priority number is first, with FIFO tie-breaking
            this.queue.sort((a, b) => (a.priority - b.priority) || (a.seq - b.seq));
            this.process();
        });
    }

    async process() {
        if (this.queue.length === 0) return;
        
        const nextItem = this.queue[0];
        // Allow CRITICAL/HIGH tasks to bypass normal concurrency limit by 1 unless strictConcurrency is set
        const effectiveConcurrency = (!this.strictConcurrency && nextItem.priority <= PRIORITY.HIGH)
            ? this.concurrency + 1
            : this.concurrency;
        
        if (this.active >= effectiveConcurrency) return;
        
        try {
            this.active++;
            const item = this.queue.shift();
            
            if (item.priority <= PRIORITY.HIGH) {
                console.error(`[OllamaQueue] 🚀 Starting task ${item.taskId} (Priority: ${item.priority}, Wait time: ${Date.now() - item.queuedAt}ms)`);
            }
            
            let attempts = 0;
            const maxAttempts = this.endpoints.length;
            let success = false;
            let lastErr = null;
            
            while (attempts < maxAttempts && !success) {
                const endpoint = this.getNextEndpoint();
                try {
                    const result = await item.taskFn(endpoint);
                    this.recordSuccess(endpoint);
                    item.resolve(result);
                    success = true;
                } catch (err) {
                    this.recordFailure(endpoint);
                    // Only log the first failure per endpoint to reduce noise
                    const stat = this.stats.get(endpoint);
                    if (stat && stat.failures <= 3) {
                        console.warn(`[OllamaQueue] Endpoint ${endpoint} failed: ${err.message}. Retrying...`);
                    }
                    lastErr = err;
                    attempts++;
                }
            }
            
            if (!success) {
                item.reject(new Error(`[OllamaQueue] All fleet nodes failed. Last error: ${lastErr?.message}`));
            }
            
            if (item.priority <= PRIORITY.HIGH) {
                console.error(`[OllamaQueue] ✅ Completed task ${item.taskId} (Success: ${success}, Total time: ${Date.now() - item.queuedAt}ms)`);
            }
        } finally {
            this.active--;
            // Automatically process the next task
            this.process();
        }
    }
}

export { PriorityQueue as OllamaQueue };

// Default concurrency allows 3 parallel requests (e.g. 1 per fleet node)
export const ollamaQueue = new PriorityQueue(process.env.OLLAMA_MAX_CONCURRENCY ? parseInt(process.env.OLLAMA_MAX_CONCURRENCY, 10) : 3);

