import { query } from './pool.js';

export async function createRepository(name, description = '') {
    try {
        const res = await query(
            `INSERT INTO repositories (name, description) VALUES ($1, $2) RETURNING *`,
            [name, description]
        );
        return res.rows[0];
    } catch (err) {
        if (err && err.code === '23505') {
            console.warn('createRepository warning: Repository name already exists');
            const duplicateErr = new Error('Repository already exists');
            duplicateErr.code = '23505';
            duplicateErr.status = 400;
            throw duplicateErr;
        }
        console.error('createRepository error:', err?.message || 'Database error');
        throw err;
    }
}

export async function getRepositories() {
    try {
        const res = await query(`SELECT * FROM repositories ORDER BY created_at DESC`);
        return res.rows;
    } catch (err) {
        console.error('getRepositories error:', err);
        throw err;
    }
}

export async function getRepository(id) {
    try {
        const res = await query(`SELECT * FROM repositories WHERE id = $1`, [id]);
        return res.rows[0];
    } catch (err) {
        console.error('getRepository error:', err);
        throw err;
    }
}

