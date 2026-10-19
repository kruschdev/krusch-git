import fs from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations() {
    const client = await pool.connect();
    try {
        console.log('Connecting to PostgreSQL database...');
        await client.query("SET max_parallel_maintenance_workers = 0; SET max_parallel_workers_per_gather = 0; SET maintenance_work_mem = '32MB';");
        const schemaPath = join(__dirname, 'schema.sql');
        const schema = await fs.readFile(schemaPath, 'utf8');
        console.log('Executing schema.sql...');
        await client.query(schema);

        // Execute incremental migrations if present
        const migrationsDir = join(__dirname, 'migrations');
        try {
            const files = (await fs.readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
            for (const file of files) {
                console.log(`Executing migration ${file}...`);
                const migrationSql = await fs.readFile(join(migrationsDir, file), 'utf8');
                await client.query(migrationSql);
            }
        } catch (err) {
            console.error('Incremental migration error:', err.message);
            throw err;
        }

        console.log('Migration successful.');
    } finally {
        client.release();
    }
}

const isMain = process.argv[1] && (fileURLToPath(import.meta.url) === process.argv[1]);
if (isMain) {
    runMigrations()
        .catch(err => {
            console.error('Migration failed:', err.message);
            process.exitCode = 1;
        })
        .finally(async () => {
            await pool.end();
        });
}

