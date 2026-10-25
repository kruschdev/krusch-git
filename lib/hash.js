import crypto from 'crypto';

/**
 * Compute Git-compatible SHA-1 blob content hash.
 * @param {Buffer|string} buffer
 * @returns {string}
 */
export function hashContent(buffer) {
    const header = `blob ${buffer.length}\0`;
    return crypto.createHash('sha1').update(header).update(buffer).digest('hex');
}
