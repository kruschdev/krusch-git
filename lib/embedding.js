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
 * Canonicalize an embedding model identifier so tags like
 * `'snowflake-arctic-embed2:latest'` and `'ollama/snowflake-arctic-embed2'`
 * normalize to `'snowflake-arctic-embed2'` while preserving explicit size tags
 * such as `'qwen3-embedding:4b'`.
 * @param {string|null|undefined} model
 * @returns {string}
 */
export function canonicalizeEmbedModel(model) {
    const cleaned = String(model ?? '')
        .trim()
        .toLowerCase()
        .replace(/^(?:(?:ollama|models)\/)+/, '')
        .replace(/:latest$/, '')
        .trim();
    return cleaned || 'snowflake-arctic-embed2';
}

/**
 * Return the canonicalized identifier of the currently active embedding model.
 * @returns {string}
 */
export function getActiveEmbedModel() {
    return canonicalizeEmbedModel(config.ai?.embedModel);
}

/**
 * Validate that an embedding vector is a finite number[] matching the expected schema dimension.
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
    for (let i = 0; i < vector.length; i++) {
        const v = vector[i];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            console.warn(`[${context}] Non-finite vector coordinate at index ${i} (${String(v)}). Rejected.`);
            return null;
        }
    }
    return vector;
}

const EMBEDDING_CACHE_MAX = 256;
const embeddingCache = new Map();
let cacheHits = 0;
let cacheMisses = 0;

function getCachedEmbedding(key) {
    if (!embeddingCache.has(key)) return null;
    const vec = embeddingCache.get(key);
    // Refresh LRU order
    embeddingCache.delete(key);
    embeddingCache.set(key, vec);
    cacheHits++;
    return vec;
}

function setCachedEmbedding(key, vec) {
    if (!vec) return;
    if (embeddingCache.has(key)) {
        embeddingCache.delete(key);
    } else if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
        const oldestKey = embeddingCache.keys().next().value;
        embeddingCache.delete(oldestKey);
    }
    embeddingCache.set(key, vec);
}

export function clearEmbeddingCache() {
    embeddingCache.clear();
    cacheHits = 0;
    cacheMisses = 0;
}

export function getEmbeddingCacheStats() {
    return {
        size: embeddingCache.size,
        maxSize: EMBEDDING_CACHE_MAX,
        hits: cacheHits,
        misses: cacheMisses
    };
}

const QWEN_DOMAIN_INSTRUCTIONS = {
    code: 'Given a technical code or symbol query, retrieve the relevant source code module',
    general: 'Given a web search query, retrieve relevant passages that answer the query',
    law: 'Given a legal or statutory query, retrieve the controlling authority or code section',
    biz: 'Given a corporate contract or business query, retrieve the relevant clause or obligation',
    memory: 'Given an engineering context query, retrieve the relevant architectural decision, invariant, or lesson'
};

function isMrlModel(model) {
    const normalizedModel = canonicalizeEmbedModel(model || config.ai?.embedModel);
    return (
        normalizedModel.startsWith('qwen3-embedding') ||
        normalizedModel.includes('/qwen3-embedding') ||
        normalizedModel.startsWith('nomic-embed-text') ||
        normalizedModel.includes('/nomic-embed-text')
    );
}

function resolveModelWindow(model) {
    const normalizedModel = canonicalizeEmbedModel(model || config.ai?.embedModel || 'snowflake-arctic-embed2');
    if (
        normalizedModel.startsWith('qwen3-embedding') ||
        normalizedModel.includes('/qwen3-embedding') ||
        normalizedModel.startsWith('snowflake-arctic-embed2') ||
        normalizedModel.includes('/snowflake-arctic-embed2')
    ) {
        return { singlePassMaxChars: 6000, chunkSize: 5000, overlap: 350 };
    }
    if (normalizedModel.startsWith('nomic-embed-text') || normalizedModel.includes('/nomic-embed-text')) {
        return { singlePassMaxChars: 4500, chunkSize: 4000, overlap: 300 };
    }
    return { singlePassMaxChars: 1150, chunkSize: 1100, overlap: 150 };
}

function isMockEmbeddingEnv(options = {}) {
    if (options?.bypassMock === true) return false;
    return Boolean(
        process.env.MOCK_EMBEDDINGS === '1' ||
        process.env.CI ||
        process.env.NODE_ENV === 'test' ||
        process.env.NODE_TEST_CONTEXT
    );
}

function isSparseSyntheticVector(vec) {
    if (!vec || typeof vec.length !== 'number' || vec.length === 0) return false;
    const checkLen = Math.min(vec.length, 64);
    let nonZero = 0;
    for (let i = 0; i < checkLen; i++) {
        if (Math.abs(vec[i]) > 1e-7) nonZero++;
    }
    return nonZero < Math.min(12, checkLen);
}

/**
 * Calibrate raw query-to-document cosine similarity across isotropic vs. anisotropic
 * embedding model geometries (`INV-GIT-VEC-01`).
 * @param {number} rawCosine
 * @param {{ model?: string, queryVec?: ArrayLike<number>|null }} [options={}]
 * @returns {number}
 */
export function calibrateQuerySimilarity(rawCosine, options = {}) {
    if (!Number.isFinite(rawCosine) || rawCosine <= 0) return 0;
    if (rawCosine >= 1) return 1;
    if (options?.queryVec && isSparseSyntheticVector(options.queryVec)) {
        return rawCosine;
    }
    const base = canonicalizeEmbedModel(options?.model || config.ai?.embedModel);
    if (
        base.startsWith('snowflake-arctic-embed2') ||
        base.includes('/snowflake-arctic-embed2') ||
        base.startsWith('qwen3-embedding') ||
        base.includes('/qwen3-embedding')
    ) {
        if (rawCosine <= 0.12) {
            return rawCosine * 3.0;
        }
        if (rawCosine <= 0.38) {
            return 0.36 + ((rawCosine - 0.12) / 0.26) * 0.32;
        }
        if (rawCosine <= 0.60) {
            return 0.68 + ((rawCosine - 0.38) / 0.22) * 0.16;
        }
        return 0.84 + ((rawCosine - 0.60) / 0.40) * 0.16;
    }
    return rawCosine;
}

/**
 * Format a compact `[repo :: file_path]\n` context header so deeper chunks in
 * multi-chunk files retain repository and module provenance (`INV-GIT-VEC-01`).
 * @param {string|null|undefined} repoName
 * @param {string|null|undefined} relativePath
 * @returns {string}
 */
export function formatChunkHeader(repoName, relativePath) {
    const rel = String(relativePath || '').trim();
    if (!rel) return '';
    const repo = String(repoName || '').trim();
    return repo ? `[${repo} :: ${rel}]\n` : `[${rel}]\n`;
}

/**
 * Format text for asymmetric query vs. document embedding spaces.
 * Documents are never prefixed; queries receive model-appropriate retrieval instructions.
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.mode='document'] - 'query' or 'document'
 * @param {string} [options.model] - Override model identifier
 * @param {string} [options.domain='code'] - Domain task selector for qwen3-embedding*
 * @param {string} [options.instruction] - Explicit custom instruction override
 * @returns {string}
 */
export function formatEmbeddingInput(text, options = {}) {
    if (typeof text !== 'string') return '';
    const mode = options?.mode || 'document';
    if (mode !== 'query') {
        return text;
    }

    const model = canonicalizeEmbedModel(options?.model || config.ai?.embedModel || 'snowflake-arctic-embed2');
    if (options?.instruction && typeof options.instruction === 'string') {
        if (model.startsWith('qwen3-embedding') || model.includes('/qwen3-embedding')) {
            const prefix = `Instruct: ${options.instruction}\nQuery:`;
            return text.startsWith(prefix) ? text : `${prefix}${text}`;
        }
        return text.startsWith(options.instruction) ? text : `${options.instruction}${text}`;
    }

    if (model.startsWith('bge-large') || model.includes('/bge-large')) {
        const prefix = 'Represent this sentence for searching relevant passages: ';
        return text.startsWith(prefix) ? text : `${prefix}${text}`;
    }
    if (model.startsWith('snowflake-arctic-embed2') || model.includes('/snowflake-arctic-embed2')) {
        const prefix = 'query: ';
        return text.startsWith(prefix) ? text : `${prefix}${text}`;
    }
    if (model.startsWith('nomic-embed-text') || model.includes('/nomic-embed-text')) {
        const prefix = 'search_query: ';
        return text.startsWith(prefix) ? text : `${prefix}${text}`;
    }
    if (model.startsWith('qwen3-embedding') || model.includes('/qwen3-embedding')) {
        const domain = options?.domain && QWEN_DOMAIN_INSTRUCTIONS[options.domain] ? options.domain : 'code';
        const prefix = `Instruct: ${QWEN_DOMAIN_INSTRUCTIONS[domain]}\nQuery:`;
        return text.startsWith(prefix) ? text : `${prefix}${text}`;
    }
    return text;
}

async function fetchLegacySingleEmbedding(endpoint, model, inputText, signal, validationContext) {
    let currentPrompt = inputText;
    for (let attempt = 0; attempt < 4; attempt++) {
        const res = await fetch(`${endpoint}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                prompt: currentPrompt,
                truncate: true,
                keep_alive: -1,
                ...(isMrlModel(model) ? { dimensions: EMBEDDING_DIM } : {})
            }),
            signal
        });

        if (res.ok) {
            const data = await res.json();
            const rawVec = Array.isArray(data.embeddings?.[0]) ? data.embeddings[0] : data.embedding;
            return validateVectorDimension(rawVec, validationContext, EMBEDDING_DIM);
        }
        const errText = await res.text();
        if (errText.includes('exceeds the context length') && currentPrompt.length > 100 && attempt < 3) {
            currentPrompt = currentPrompt.slice(0, Math.floor(currentPrompt.length / 2));
            continue;
        }
        throw new Error(`Status ${res.status}: ${errText}`);
    }
    return null;
}

/**
 * Generate a vector embedding for a text string via Ollama `/api/embed` (with 404 fallback to `/api/embeddings`).
 * Utilizes the centralized Ollama Priority Queue for concurrency management
 * and a bounded in-memory LRU cache isolated by provider, canonicalized model, dimensions, and mode.
 * @param {string} text - The text to embed.
 * @param {number} [priority=PRIORITY.LOW] - The queue priority level.
 * @param {object} [options={}] - Formatting and model options (`{ mode, model, domain, instruction }`).
 * @returns {Promise<number[]|null>} The embedding vector, or null on failure.
 */
export async function getEmbedding(text, priority = PRIORITY.LOW, options = {}) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return null;
    }

    const model = options?.model || config.ai.embedModel;
    const canonicalModel = canonicalizeEmbedModel(model);
    const mode = options?.mode === 'query' ? 'query' : 'document';
    const normalized = text.trim();
    const baseScope = `ollama:${canonicalModel}:${EMBEDDING_DIM}`;
    const cacheKey = normalized.length <= 2000
        ? (mode === 'query' ? `${baseScope}:${mode}:${normalized}` : `${baseScope}:document:${normalized}`)
        : null;

    if (cacheKey) {
        const cached = getCachedEmbedding(cacheKey);
        if (cached) return cached;
    }
    cacheMisses++;

    const formattedText = formatEmbeddingInput(text, { ...options, model, mode });

    // Fast bypass for headless CI runners and offline test environments
    if (isMockEmbeddingEnv(options)) {
        const vec = generateDeterministicVector(formattedText, EMBEDDING_DIM);
        if (cacheKey) setCachedEmbedding(cacheKey, vec);
        return vec;
    }

    try {
        const resultVec = await ollamaQueue.enqueue(async (endpoint) => {
            const controller = new AbortController();
            // Interactive agent queries get a fast timeout (8s) so agents don't freeze on fleet drops
            const timeoutMs = priority <= PRIORITY.HIGH ? 8000 : 60000;
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                let currentInput = formattedText;
                for (let attempt = 0; attempt < 4; attempt++) {
                    const res = await fetch(`${endpoint}/api/embed`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model,
                            input: currentInput,
                            prompt: currentInput,
                            truncate: true,
                            keep_alive: -1,
                            ...(isMrlModel(model) ? { dimensions: EMBEDDING_DIM } : {})
                        }),
                        signal: controller.signal
                    });

                    if (res.ok) {
                        const data = await res.json();
                        const rawVec = Array.isArray(data.embeddings?.[0]) ? data.embeddings[0] : data.embedding;
                        return validateVectorDimension(rawVec, 'Ollama Embed', EMBEDDING_DIM);
                    }
                    if (res.status === 404) {
                        return await fetchLegacySingleEmbedding(endpoint, model, currentInput, controller.signal, 'Ollama Embed');
                    }
                    const errText = await res.text();
                    if (errText.includes('exceeds the context length') && currentInput.length > 100 && attempt < 3) {
                        currentInput = currentInput.slice(0, Math.floor(currentInput.length / 2));
                        continue;
                    }
                    throw new Error(`Status ${res.status}: ${errText}`);
                }
                return null;
            } finally {
                clearTimeout(timeoutId);
            }
        }, priority);
        if (cacheKey && resultVec) {
            setCachedEmbedding(cacheKey, resultVec);
        }
        return resultVec;
    } catch (e) {
        console.error(`[Embed] ${e.message}`);
        return null;
    }
}

/**
 * Generate vector embeddings for an array of texts using batched Ollama `/api/embed` calls.
 * Preserves input alignment (`Array<number[]|null>` matching `texts.length`) and falls back to
 * per-item `/api/embeddings` if the host returns HTTP 404.
 * @param {string[]} texts
 * @param {number} [priority=PRIORITY.LOW]
 * @param {object} [options={}]
 * @returns {Promise<Array<number[]|null>>}
 */
export async function getEmbeddingsBatch(texts, priority = PRIORITY.LOW, options = {}) {
    if (!Array.isArray(texts) || texts.length === 0) {
        return [];
    }

    const model = options?.model || config.ai.embedModel;
    const mode = options?.mode === 'query' ? 'query' : 'document';

    if (isMockEmbeddingEnv(options)) {
        return texts.map((t) => {
            if (typeof t !== 'string' || !t.trim()) return null;
            const formatted = formatEmbeddingInput(t, { ...options, model, mode });
            return generateDeterministicVector(formatted, EMBEDDING_DIM);
        });
    }

    const results = new Array(texts.length).fill(null);
    const validEntries = [];
    for (let idx = 0; idx < texts.length; idx++) {
        const t = texts[idx];
        if (typeof t === 'string' && t.trim().length > 0) {
            validEntries.push({
                index: idx,
                formatted: formatEmbeddingInput(t, { ...options, model, mode })
            });
        }
    }

    if (validEntries.length === 0) {
        return results;
    }

    const batchSize = Math.max(1, Number(options?.batchSize) || 24);
    const slices = [];
    for (let i = 0; i < validEntries.length; i += batchSize) {
        slices.push(validEntries.slice(i, i + batchSize));
    }

    await Promise.all(
        slices.map(async (slice) => {
            try {
                const sliceVectors = await ollamaQueue.enqueue(async (endpoint) => {
                    const controller = new AbortController();
                    const timeoutMs = priority <= PRIORITY.HIGH ? 15000 : 60000;
                    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                    try {
                        let currentBatch = slice.map((item) => item.formatted);
                        for (let attempt = 0; attempt < 4; attempt++) {
                            const res = await fetch(`${endpoint}/api/embed`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    model,
                                    input: currentBatch,
                                    truncate: true,
                                    keep_alive: -1,
                                    ...(isMrlModel(model) ? { dimensions: EMBEDDING_DIM } : {})
                                }),
                                signal: controller.signal
                            });

                            if (res.ok) {
                                const data = await res.json();
                                const rawEmbeddings = Array.isArray(data.embeddings)
                                    ? data.embeddings
                                    : (Array.isArray(data.embedding) ? [data.embedding] : []);
                                return slice.map((_, idx) =>
                                    validateVectorDimension(rawEmbeddings[idx] ?? null, 'Ollama Batch Embed', EMBEDDING_DIM)
                                );
                            }

                            if (res.status === 404) {
                                const fallbackVectors = [];
                                for (const itemText of currentBatch) {
                                    const vec = await fetchLegacySingleEmbedding(
                                        endpoint,
                                        model,
                                        itemText,
                                        controller.signal,
                                        'Ollama Batch Embed'
                                    );
                                    fallbackVectors.push(vec);
                                }
                                return fallbackVectors;
                            }

                            const errText = await res.text();
                            if (errText.includes('exceeds the context length') && attempt < 3 && currentBatch.some((s) => s.length > 100)) {
                                currentBatch = currentBatch.map((s) => (s.length > 100 ? s.slice(0, Math.floor(s.length / 2)) : s));
                                continue;
                            }
                            throw new Error(`Status ${res.status}: ${errText}`);
                        }
                        return new Array(slice.length).fill(null);
                    } finally {
                        clearTimeout(timeoutId);
                    }
                }, priority);

                if (Array.isArray(sliceVectors)) {
                    for (let j = 0; j < slice.length; j++) {
                        results[slice[j].index] = sliceVectors[j] ?? null;
                    }
                }
            } catch (e) {
                console.error(`[EmbedBatch] ${e.message}`);
            }
        })
    );

    return results;
}

/**
 * Check if a file extension is a text type we should embed.
 * @param {string} ext - The lowercase file extension (e.g. '.js').
 * @returns {boolean}
 */
export function isEmbeddable(ext) {
    return TEXT_EXTENSIONS.has(ext);
}

/** Maximum single-pass character length for the configured embedding model (INV-03: <=1150 for 512-tok bge-large*, 6000 for >=8k models). */
export const MAX_EMBED_CHARS = resolveModelWindow(config.ai?.embedModel).singlePassMaxChars;

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
 * Splits text into model-aware overlapping chunks, embeds them via batched `/api/embed`,
 * and returns the L2-normalized centroid vector.
 * When `options.contextHeader` is provided (e.g. `[repo :: path]\n`), prepends it to
 * each chunk window so deeper slices retain file/module identity (`INV-GIT-VEC-01`).
 * @param {string} text - The full text to embed.
 * @param {number} [priority=PRIORITY.LOW] - The queue priority level.
 * @param {object} [options={}] - Optional model/batch/contextHeader overrides.
 * @returns {Promise<number[]|null>} The centroid embedding vector, or null on failure.
 */
export async function getChunkedCentroidEmbedding(text, priority = PRIORITY.LOW, options = {}) {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return null;
    }

    const header = typeof options?.contextHeader === 'string' ? options.contextHeader : '';
    const withHeader = (slice) => (header && !slice.startsWith(header) ? `${header}${slice}` : slice);

    if (isMockEmbeddingEnv(options)) {
        return generateDeterministicVector(header ? withHeader(text) : text, EMBEDDING_DIM);
    }

    const model = options?.model || config.ai.embedModel;
    const { chunkSize: CHUNK_SIZE, overlap: OVERLAP } = resolveModelWindow(model);

    const singlePassText = withHeader(text);
    if (singlePassText.length <= CHUNK_SIZE) {
        return await getEmbedding(singlePassText, priority, { ...options, model });
    }

    const bodyChunkSize = header.length > 0 && header.length < CHUNK_SIZE - OVERLAP
        ? CHUNK_SIZE - header.length
        : CHUNK_SIZE;
    const chunks = [];
    const step = Math.max(1, bodyChunkSize - OVERLAP);
    let start = 0;
    while (start < text.length) {
        chunks.push(withHeader(text.substring(start, start + bodyChunkSize)));
        if (start + bodyChunkSize >= text.length) break;
        start += step;
    }

    // Cap at 50 chunks to bound latency on massive files; 24-chunk files embed in 1 batched /api/embed GPU call
    const cappedChunks = chunks.slice(0, 50);
    const batchResults = await getEmbeddingsBatch(cappedChunks, priority, {
        ...options,
        model,
        batchSize: 24
    });

    const vectors = batchResults.filter(Boolean);
    return calculateCentroid(vectors);
}
