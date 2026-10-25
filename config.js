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

export function parseDatabaseUrl(urlStr, { strict = false } = {}) {
    try {
        const u = new URL(urlStr);
        return {
            host: u.hostname || undefined,
            port: u.port ? parseInt(u.port, 10) : undefined,
            database: u.pathname ? u.pathname.replace(/^\//, '') : undefined,
            user: u.username || undefined,
            password: u.password || undefined
        };
    } catch (err) {
        console.error('Invalid DATABASE_URL:', err.message);
        if (strict) {
            throw err;
        }
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
        user: dbUrlConfig.user || envOr('DB_USER', baseConfig.db?.user, undefined),
        password: dbUrlConfig.password || envOr('DB_PASSWORD', baseConfig.db?.password, undefined),
        poolSize: baseConfig.db?.poolSize || 10
    },
    ai: {
        embedModel: envOr('EMBED_MODEL', baseConfig.ai?.embedModel, 'snowflake-arctic-embed2'),
        ollamaUrl: envOr('OLLAMA_URL', baseConfig.ai?.ollamaUrl, 'http://localhost:11434')
    }
};

export function validateDbConfig(dbCfg = config.db) {
    if (!dbCfg.user) {
        throw new Error('Missing required DB_USER (or user in DATABASE_URL)');
    }
    if (!dbCfg.password) {
        throw new Error('Missing required DB_PASSWORD (or password in DATABASE_URL)');
    }
    return true;
}

export function updateConfig(newValues) {
    if (newValues.ai) {
        baseConfig.ai = { ...baseConfig.ai, ...newValues.ai };
        config.ai.embedModel = baseConfig.ai.embedModel;
    }
    fs.writeFileSync(configPath, JSON.stringify(baseConfig, null, 2), 'utf-8');
}

export default config;
