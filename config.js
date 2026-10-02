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

const rawDbUrl = process.env.DATABASE_URL || process.env.PG_CONNECTION_STRING;
const dbUrlConfig = rawDbUrl ? parseDatabaseUrl(rawDbUrl) : {};

export const config = {
    ...baseConfig,
    server: {
        port: envOr('PORT', baseConfig.server?.port, 4890)
    },
    db: {
        host: dbUrlConfig.host || envOr('DB_HOST', baseConfig.db?.host, 'localhost'),
        port: dbUrlConfig.port ? parseInt(dbUrlConfig.port, 10) : envOr('DB_PORT', baseConfig.db?.port, 5432),
        database: dbUrlConfig.database || envOr('DB_NAME', baseConfig.db?.database, 'kdcode'),
        user: dbUrlConfig.user || envOr('DB_USER', baseConfig.db?.user, 'kdcode'),
        password: dbUrlConfig.password || envOr('DB_PASSWORD', baseConfig.db?.password, 'password'),
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
