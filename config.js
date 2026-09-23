import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env variables into process.env
dotenv.config({ path: join(__dirname, '.env'), quiet: true });

const configPath = join(__dirname, 'config.json');
let baseConfig = {};

try {
    if (fs.existsSync(configPath)) {
        baseConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
} catch (e) {
    console.warn("Could not load config.json:", e.message);
}

function envOr(envKey, fileValue, defaultValue) {
    if (process.env[envKey] !== undefined && process.env[envKey] !== '') {
        return process.env[envKey];
    }
    if (fileValue !== undefined) {
        return fileValue;
    }
    return defaultValue;
}

function parseDatabaseUrl(urlStr) {
    try {
        const u = new URL(urlStr);
        return {
            host: u.hostname || undefined,
            port: u.port ? parseInt(u.port, 10) : undefined,
            database: u.pathname ? u.pathname.replace(/^\//, '') : undefined,
            user: u.username || undefined,
            password: u.password || undefined
        };
    } catch (_) {
        return {};
    }
}

const dbUrlConfig = process.env.DATABASE_URL ? parseDatabaseUrl(process.env.DATABASE_URL) : {};

export const config = {
    ...baseConfig,
    server: {
        port: envOr('PORT', baseConfig.server?.port, 4890)
    },
    db: {
        host: envOr('DB_HOST', dbUrlConfig.host || baseConfig.db?.host || 'localhost', 'localhost'),
        port: envOr('DB_PORT', dbUrlConfig.port || baseConfig.db?.port || 5432, 5432),
        database: envOr('DB_NAME', dbUrlConfig.database || baseConfig.db?.database || 'kdcode', 'kdcode'),
        user: envOr('DB_USER', dbUrlConfig.user || baseConfig.db?.user || 'kdcode', 'kdcode'),
        password: envOr('DB_PASSWORD', dbUrlConfig.password || baseConfig.db?.password || 'password', 'password'),
        poolSize: baseConfig.db?.poolSize || 10
    },
    ai: {
        embedModel: envOr('EMBED_MODEL', baseConfig.ai?.embedModel, 'bge-large'),
        ollamaUrl: envOr('OLLAMA_URL', baseConfig.ai?.ollamaUrl, 'http://localhost:11434')
    }
};

export function updateConfig(newValues) {
    if (newValues.ai) {
        baseConfig.ai = { ...baseConfig.ai, ...newValues.ai };
        config.ai.embedModel = baseConfig.ai.embedModel;
    }
    fs.writeFileSync(configPath, JSON.stringify(baseConfig, null, 2), 'utf-8');
}

export default config;
