import pg from 'pg';
import { config } from '../config.js';
import { createMockDbPool } from './db-mock.js';

const { Pool } = pg;
const rawPool = new Pool({
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    max: config.db.poolSize,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000
});

// Guard against uncaught idle client crashes (e.g. Postgres restart or network drops)
rawPool.on('error', (err) => {
    console.error('[krusch-git] PostgreSQL pool idle client error:', err.message);
});

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

