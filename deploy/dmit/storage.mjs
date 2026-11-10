import { DatabaseSync } from 'node:sqlite';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

async function sqliteFiles(directory) {
    try {
        return (await readdir(directory))
            .filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
            .sort()
            .map((name) => path.join(directory, name));
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

function hasTable(db, name) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

// A failed import is rolled back; legacy files remain available for backup/rollback.
async function importLegacy(db, directory, now) {
    if (db.prepare('SELECT 1 FROM node_meta WHERE key = ?').get('legacy-import-v1')) return;
    const kvFiles = await sqliteFiles(path.join(directory, 'kv/miniflare-KVNamespaceObject'));
    const d1Files = await sqliteFiles(path.join(directory, 'd1/miniflare-D1DatabaseObject'));
    let d1Found = false;
    db.exec('BEGIN IMMEDIATE');
    try {
        for (const file of kvFiles) {
            const old = new DatabaseSync(file, { readOnly: true });
            try {
                if (!hasTable(old, '_mf_entries')) continue;
                const insert = db.prepare(
                    'INSERT OR IGNORE INTO node_kv (key, value, expiration, metadata) VALUES (?, ?, ?, ?)'
                );
                for (const row of old.prepare('SELECT * FROM _mf_entries').all()) {
                    if (row.expiration !== null && row.expiration <= now()) continue;
                    if (!/^[a-f0-9]+$/i.test(row.blob_id))
                        throw new Error('Invalid legacy KV blob identifier');
                    const value = await readFile(
                        path.join(directory, 'kv/MISUB_KV/blobs', row.blob_id)
                    );
                    insert.run(row.key, value, row.expiration, row.metadata);
                }
            } finally {
                old.close();
            }
        }
        for (const file of d1Files) {
            const old = new DatabaseSync(file, { readOnly: true });
            try {
                if (!['subscriptions', 'profiles', 'settings'].every((t) => hasTable(old, t)))
                    continue;
                if (d1Found)
                    throw new Error(
                        'Multiple legacy MiSub D1 databases; select one before migration'
                    );
                d1Found = true;
                for (const table of ['subscriptions', 'profiles', 'settings']) {
                    const key = table === 'settings' ? 'key' : 'id';
                    const value = table === 'settings' ? 'value' : 'data';
                    const insert = db.prepare(
                        `INSERT OR IGNORE INTO ${table} (${key}, ${value}, created_at, updated_at) VALUES (?, ?, ?, ?)`
                    );
                    for (const row of old.prepare(`SELECT * FROM ${table}`).all()) {
                        insert.run(row[key], row[value], row.created_at, row.updated_at);
                    }
                }
            } finally {
                old.close();
            }
        }
        db.prepare('INSERT INTO node_meta (key, value) VALUES (?, ?)').run(
            'legacy-import-v1',
            new Date(now()).toISOString()
        );
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

class D1Statement {
    constructor(prepare, sql, values = []) {
        this.prepare = prepare;
        this.sql = sql;
        this.values = values;
    }
    bind(...values) {
        return new D1Statement(this.prepare, this.sql, values);
    }
    async first(column) {
        const row = this.prepare(this.sql).get(...this.values);
        return row ? (column === undefined ? { ...row } : row[column]) : null;
    }
    async all() {
        return {
            success: true,
            results: this.prepare(this.sql)
                .all(...this.values)
                .map((row) => ({ ...row })),
        };
    }
    async run() {
        const result = this.prepare(this.sql).run(...this.values);
        return {
            success: true,
            results: [],
            meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
        };
    }
}

export async function openStorage(directory, schema, { now = Date.now } = {}) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path.join(directory, 'native.sqlite'));
    try {
        db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
        db.exec(schema);
        db.exec(`CREATE TABLE IF NOT EXISTS node_kv (
            key TEXT PRIMARY KEY, value BLOB NOT NULL, expiration INTEGER, metadata TEXT
        ); CREATE TABLE IF NOT EXISTS node_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
        await importLegacy(db, directory, now);
    } catch (error) {
        db.close();
        throw error;
    }

    // Reuse bounded query shapes instead of allocating native statements per request.
    const statements = new Map();
    const prepare = (sql) => {
        let statement = statements.get(sql);
        statements.delete(sql);
        if (!statement) statement = db.prepare(sql);
        statements.set(sql, statement);
        if (statements.size > 64) statements.delete(statements.keys().next().value);
        return statement;
    };
    const kv = {
        async get(key, options = 'text') {
            const row = prepare('SELECT value, expiration FROM node_kv WHERE key = ?').get(key);
            if (!row) return null;
            if (row.expiration !== null && row.expiration <= now()) {
                await this.delete(key);
                return null;
            }
            const type = typeof options === 'string' ? options : options.type || 'text';
            const bytes = Buffer.from(row.value);
            if (type === 'arrayBuffer')
                return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            if (type === 'stream') return new Response(bytes).body;
            const text = bytes.toString('utf8');
            if (type === 'json') return JSON.parse(text);
            if (type !== 'text') throw new Error(`Unsupported KV value type: ${type}`);
            return text;
        },
        async put(key, value, options = {}) {
            let bytes;
            if (typeof value === 'string') bytes = Buffer.from(value);
            else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
                bytes = Buffer.from(
                    value instanceof ArrayBuffer
                        ? value
                        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
                );
            } else throw new TypeError('KV values must be strings or bytes');
            let expiration = null;
            if (options.expirationTtl !== undefined) {
                if (!Number.isFinite(options.expirationTtl) || options.expirationTtl <= 0)
                    throw new Error('Invalid KV TTL');
                expiration = now() + options.expirationTtl * 1000;
            } else if (options.expiration !== undefined) {
                if (!Number.isFinite(options.expiration)) throw new Error('Invalid KV expiration');
                expiration = options.expiration * 1000;
            }
            prepare(
                'INSERT OR REPLACE INTO node_kv (key, value, expiration, metadata) VALUES (?, ?, ?, ?)'
            ).run(
                key,
                bytes,
                expiration,
                options.metadata === undefined ? null : JSON.stringify(options.metadata)
            );
        },
        async delete(key) {
            prepare('DELETE FROM node_kv WHERE key = ?').run(key);
        },
        async list({ prefix = '', cursor = '', limit = 1000 } = {}) {
            if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
                throw new Error('Invalid KV list limit');
            const after = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : '';
            const rows = prepare(
                `SELECT key, expiration, metadata FROM node_kv
                WHERE substr(key, 1, length(?)) = ? AND key > ?
                AND (expiration IS NULL OR expiration > ?) ORDER BY key LIMIT ?`
            ).all(prefix, prefix, after, now(), limit + 1);
            const complete = rows.length <= limit;
            const page = rows.slice(0, limit);
            return {
                keys: page.map((row) => ({
                    name: row.key,
                    ...(row.expiration === null
                        ? {}
                        : { expiration: Math.floor(row.expiration / 1000) }),
                    ...(row.metadata === null ? {} : { metadata: JSON.parse(row.metadata) }),
                })),
                list_complete: complete,
                cursor: complete ? '' : Buffer.from(page.at(-1).key).toString('base64url'),
            };
        },
    };
    return {
        kv,
        d1: { prepare: (sql) => new D1Statement(prepare, sql) },
        close() {
            statements.clear();
            db.close();
        },
    };
}
