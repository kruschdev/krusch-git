import fs from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
    try {
        console.log('Connecting to PostgreSQL database...');
        const schemaPath = join(__dirname, 'schema.sql');
        const schema = await fs.readFile(schemaPath, 'utf8');
        console.log('Executing schema.sql...');
        await pool.query(schema);

        // Execute incremental migrations if present
        const migrationsDir = join(__dirname, 'migrations');
        try {
            const files = (await fs.readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
            for (const file of files) {
                console.log(`Executing migration ${file}...`);
                const migrationSql = await fs.readFile(join(migrationsDir, file), 'utf8');
                await pool.query(migrationSql);
            }
        } catch (_) {}

        console.log('Migration successful.');
    } catch (err) {
        console.error('Migration failed:', err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main();
