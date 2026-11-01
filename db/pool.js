import { existsSync } from 'node:fs';
import pg from 'pg';
import { config } from '../config.js';
import { createMockDbPool } from './db-mock.js';

async function resolveCreatePgPool() {
    const siblingPgUrl = new URL('../../../lib/pg.js', import.meta.url);
    if (existsSync(siblingPgUrl)) {
        try {
            const mod = await import(siblingPgUrl.href);
            if (typeof mod.createPgPool === 'function') {
                return mod.createPgPool;
            }
        } catch {
            // Fall through to @krusch/toolkit/pg or standalone CI fallback
        }
    }
    try {
        const mod = await import('@krusch/toolkit/pg');
        if (typeof mod.createPgPool === 'function') {
            return mod.createPgPool;
        }
    } catch {
        // Standalone CI fallback when sibling toolkit is unavailable
    }
    return function standaloneCreatePgPool(dbCfg = {}, options = {}) {
        const PoolCtor = options.PoolClass || pg['Pool'];
        const directUrl = typeof dbCfg === 'string'
            ? dbCfg.trim()
            : String(dbCfg.url || dbCfg.connectionString || '').trim();
        const poolOpts = directUrl
            ? { connectionString: directUrl }
            : {
                host: dbCfg.host,
                port: dbCfg.port,
                database: dbCfg.database,
                user: dbCfg.user,
                password: dbCfg.password
            };
        const instance = Reflect.construct(PoolCtor, [{
            ...poolOpts,
            max: options.max ?? 15,
            connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000,
            idleTimeoutMillis: options.idleTimeoutMillis ?? 30000
        }]);
        instance.on('error', (err) => {
            if (options.logger?.error) {
                options.logger.error('Unexpected error on idle PostgreSQL client', err);
            } else {
                console.error('[krusch-git] PostgreSQL pool idle client error:', err.message);
            }
        });
        return {
            pool: instance,
            query: (sql, params) => instance.query(sql, params),
            close: () => instance.end()
        };
    };
}

const createPgPool = await resolveCreatePgPool();
const poolLogger = {
    info() {},
    debug() {},
    warn() {},
    error(_msg, err) {
        // Guard against uncaught idle client crashes (e.g. Postgres restart or network drops)
        console.error('[krusch-git] PostgreSQL pool idle client error:', err?.message || err);
    }
};

const { pool: rawPool } = createPgPool(
    {
        connectionString: config.db.connectionString || config.db.url,
        host: config.db.host,
        port: config.db.port,
        database: config.db.database,
        user: config.db.user,
        password: config.db.password
    },
    {
        serviceName: 'krusch-git',
        max: config.db.poolSize ?? 15,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        PoolClass: pg.Pool,
        logger: poolLogger
    }
);

const mockPool = createMockDbPool();
const isTestOrCi = process.env.NODE_ENV === 'test' || process.env.CI === 'true' || process.env.KRUSCH_EPHEMERAL === '1';
let useMockFallback = process.env.KRUSCH_EPHEMERAL === '1' || process.env.KRUSCH_GIT_MOCK_DB === '1';

function shouldFallbackToMock(err) {
    if (!isTestOrCi || !err) return false;
    const code = String(err.code || '');
    const msg = String(err.message || '');
    return (
        code === '28P01' ||
        code === '28000' ||
        code === '3D000' ||
        code === 'ECONNREFUSED' ||
        code === 'ENOTFOUND' ||
        msg.includes('password authentication failed') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('does not exist')
    );
}

export async function query(text, params) {
    if (useMockFallback) {
        return mockPool.query(text, params);
    }
    try {
        return await rawPool.query(text, params);
    } catch (err) {
        if (shouldFallbackToMock(err)) {
            useMockFallback = true;
            return mockPool.query(text, params);
        }
        throw err;
    }
}

export const pool = {
    query: (text, params) => query(text, params),
    connect: async () => {
        if (useMockFallback) return mockPool.connect();
        try {
            return await rawPool.connect();
        } catch (err) {
            if (shouldFallbackToMock(err)) {
                useMockFallback = true;
                return mockPool.connect();
            }
            throw err;
        }
    },
    on: (...args) => rawPool.on(...args),
    end: async () => {
        await rawPool.end().catch(() => {});
    }
};

