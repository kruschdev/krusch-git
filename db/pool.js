import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;
export const pool = new Pool({
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
pool.on('error', (err) => {
    console.error('[krusch-git] PostgreSQL pool idle client error:', err.message);
});

export const query = (text, params) => pool.query(text, params);
