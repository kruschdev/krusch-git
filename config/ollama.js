import fs from 'fs';
import path from 'path';

const DEFAULT_SUMMARY_MODEL = 'qwen2.5-coder:7b';
const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';
const DEFAULT_CONCURRENCY = 2;

export function loadResolvedFastCodingModel() {
    try {
        const resolvedPath = path.resolve(
            path.dirname(new URL(import.meta.url).pathname),
            '../../../configs/resolved_models.json'
        );
        if (fs.existsSync(resolvedPath)) {
            const resolved = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
            if (typeof resolved?.mappings?.fast_coding_model === 'string' && resolved.mappings.fast_coding_model.trim()) {
                return resolved.mappings.fast_coding_model.trim();
            }
        }
    } catch (err) {
        console.warn(`[Config] Optional resolved_models.json read failed: ${err.message}`);
    }
    return null;
}

export function resolveSummaryModel(env = process.env) {
    const configured = env.OLLAMA_SUMMARY_MODEL?.trim() || loadResolvedFastCodingModel() || DEFAULT_SUMMARY_MODEL;
    if (!configured || typeof configured !== 'string') {
        throw new Error('Invalid OLLAMA_SUMMARY_MODEL configuration: model name must be a non-empty string');
    }
    return configured;
}

export const HOST = (process.env.OLLAMA_SUMMARY_HOST || process.env.OLLAMA_URL || DEFAULT_OLLAMA_HOST).trim();
export const MODEL = resolveSummaryModel();
export const CONCURRENCY = Math.max(1, parseInt(process.env.OLLAMA_CONCURRENCY || String(DEFAULT_CONCURRENCY), 10) || DEFAULT_CONCURRENCY);
