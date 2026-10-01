/**
 * Shared Ollama embedding client for PG-Git.
 * Centralizes the embedding logic and implements round-robin
 * load balancing across the fleet.
 */

import crypto from 'node:crypto';
import { config } from '../config.js';
import { ollamaQueue, PRIORITY } from './llm-queue.js';

// Re-export for downstream consumers (e.g. krusch-context-mcp)
// to avoid fragile monorepo-relative paths
export { ollamaQueue, PRIORITY };

const TEXT_EXTENSIONS = new Set([
    '.js', '.ts', '.jsx', '.tsx', '.json', '.md', '.txt',
    '.html', '.css', '.yml', '.yaml', '.sql', '.py', '.sh',
    '.toml', '.env', '.dockerfile', '.graphql', '.vue', '.svelte'
]);

export const EMBEDDING_DIM = 1024;

/**
 * Generate a deterministic unit vector from text hash for headless CI or offline test evaluation.
 * @param {string} text
 * @param {number} dim
 * @returns {number[]}
 */
export function generateDeterministicVector(text, dim = EMBEDDING_DIM) {
    if (!text || typeof text !== 'string') return new Array(dim).fill(0);
    const hash = crypto.createHash('sha256').update(text).digest();
    const vec = new Array(dim);
    let norm = 0;
    for (let i = 0; i < dim; i++) {
        const b1 = hash[(i * 2) % hash.length];
        const b2 = hash[(i * 2 + 1) % hash.length];
        const val = (((b1 << 8) | b2) / 65535) * 2 - 1;
        vec[i] = val;
        norm += val * val;
    }
    const magnitude = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) {
        vec[i] = Number((vec[i] / magnitude).toFixed(6));
    }
    return vec;
}

/**
 * Validate that an embedding vector is non-empty and matches the expected schema dimension.
 * @param {number[]|null} vector
 * @param {string} context
 * @param {number} expectedDim
 * @returns {number[]|null}
 */
export function validateVectorDimension(vector, context = 'Embedding', expectedDim = EMBEDDING_DIM) {
    if (!vector || !Array.isArray(vector)) return null;
    if (vector.length !== expectedDim) {
        console.warn(`[${context}] Dimension mismatch: expected ${expectedDim}, got ${vector.length}. Rejected.`);
        return null;
    }
    return vector;
}

/**
 * Generate a vector embedding for a text string via Ollama.
 * Utilizes the centralized Ollama Priority Queue for concurrency management.
 * @param {string} text - The text to embed.
 * @param {number} priority - The queue priority level.
 * @returns {Promise<number[]|null>} The embedding vector, or null on failure.
 */
export async function getEmbedding(text, priority = PRIORITY.LOW) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return null;
    }

    // Fast bypass for headless CI runners and offline test environments
    if (process.env.MOCK_EMBEDDINGS === '1' || process.env.CI || process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) {
        return generateDeterministicVector(text, EMBEDDING_DIM);
    }

    try {
        return await ollamaQueue.enqueue(async (endpoint) => {
            const controller = new AbortController();
            // Interactive agent queries get a fast timeout (8s) so agents don't freeze on fleet drops
            const timeoutMs = priority <= PRIORITY.HIGH ? 8000 : 60000;
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                // console.log(`[Embed] Requesting ${config.ai.embedModel}`);
                const res = await fetch(`${endpoint}/api/embeddings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        model: config.ai.embedModel, 
                        prompt: text,
                        truncate: true
                    }),
                    signal: controller.signal
                });
                
                if (res.ok) {
                    const data = await res.json();
                    return validateVectorDimension(data.embedding, 'Ollama Embed', EMBEDDING_DIM);
                } else {
                    const errText = await res.text();
                    throw new Error(`Status ${res.status}: ${errText}`);
                }
            } finally {
                clearTimeout(timeoutId);
            }
        }, priority);
    } catch (e) {
        console.error(`[Embed] ${e.message}`);
        return null;
    }
}

/**
 * Check if a file extension is a text type we should embed.
 * @param {string} ext - The lowercase file extension (e.g. '.js').
 * @returns {boolean}
 */
export function isEmbeddable(ext) {
    return TEXT_EXTENSIONS.has(ext);
}

/** Maximum character length to send to Ollama for embedding (bge-large has 512 token limit -> safely ~2k chars). */
export const MAX_EMBED_CHARS = 2000;

/**
 * Calculates an L2-normalized centroid for an array of vectors.
 * @param {number[][]} vectors 
 * @returns {number[]|null} 
 */
function calculateCentroid(vectors) {
    if (!vectors || vectors.length === 0) return null;
    if (vectors.length === 1) return vectors[0];
    
    const len = vectors[0].length;
    let centroid = new Array(len).fill(0);
    
    for (const vec of vectors) {
        for (let i = 0; i < len; i++) {
            centroid[i] += vec[i];
        }
    }
    
    let sqSum = 0;
    for (let i = 0; i < len; i++) {
        sqSum += centroid[i] * centroid[i];
    }
    
    const norm = Math.sqrt(sqSum);
    if (norm === 0) return centroid;
    
    for (let i = 0; i < len; i++) {
        centroid[i] = centroid[i] / norm;
    }
    
    return centroid;
}

/**
 * Splits text into overlapping chunks, embeds each in parallel batches, and returns the L2-normalized centroid.
 * Chunk size (1200 chars) stays safely within bge-large's 512-token context window even for dense code, reducing API calls.
 * @param {string} text - The full text to embed.
 * @param {number} priority - The queue priority level.
 * @returns {Promise<number[]|null>} The centroid embedding vector, or null on failure.
 */
export async function getChunkedCentroidEmbedding(text, priority = PRIORITY.LOW) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return null;
    }

    if (process.env.MOCK_EMBEDDINGS === '1' || process.env.CI || process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) {
        return generateDeterministicVector(text, EMBEDDING_DIM);
    }

    const CHUNK_SIZE = 950;
    const OVERLAP = 150;
    const BATCH_SIZE = ollamaQueue.concurrency; // Parallelize across fleet nodes
    
    if (text.length <= CHUNK_SIZE) {
        return await getEmbedding(text, priority);
    }
    
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        chunks.push(text.substring(start, start + CHUNK_SIZE));
        start += (CHUNK_SIZE - OVERLAP);
    }
    
    // Cap at 50 chunks (~15k chars of unique content) to prevent API spam on massive files
    const maxChunks = Math.min(chunks.length, 50);
    const vectors = [];
    
    // Process chunks in parallel batches (one per fleet node) for ~3x throughput
    for (let i = 0; i < maxChunks; i += BATCH_SIZE) {
        const batch = chunks.slice(i, Math.min(i + BATCH_SIZE, maxChunks));
        const results = await Promise.all(
            batch.map(chunk => getEmbedding(chunk, priority))
        );
        for (const vec of results) {
            if (vec) vectors.push(vec);
        }
    }
    
    return calculateCentroid(vectors);
}
