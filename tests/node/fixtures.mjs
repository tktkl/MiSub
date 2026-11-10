import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export const schema = await readFile(new URL('../../schema.sql', import.meta.url), 'utf8');

export async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'misub-native-test-'));
    const data = path.join(root, 'data');
    const assets = path.join(root, 'dist');
    await mkdir(data);
    await mkdir(assets);
    await mkdir(path.join(assets, 'assets'));
    await writeFile(path.join(assets, 'index.html'), '<!doctype html><title>MiSub test</title>');
    await writeFile(path.join(assets, 'assets/app.js'), 'console.log("asset")');
    const cleanups = [];
    t.after(async () => {
        for (const cleanup of cleanups.reverse()) await cleanup();
        await rm(root, { recursive: true, force: true });
    });
    return { root, data, assets, cleanup: (fn) => cleanups.push(fn) };
}

export async function legacyKV(directory, entries) {
    const sqliteDir = path.join(directory, 'kv/miniflare-KVNamespaceObject');
    const blobDir = path.join(directory, 'kv/MISUB_KV/blobs');
    await mkdir(sqliteDir, { recursive: true });
    await mkdir(blobDir, { recursive: true });
    const file = path.join(sqliteDir, 'legacy.sqlite');
    const old = new DatabaseSync(file);
    old.exec(
        'CREATE TABLE _mf_entries (key TEXT PRIMARY KEY, blob_id TEXT NOT NULL, expiration INTEGER, metadata TEXT)'
    );
    const blobs = {};
    try {
        for (const [key, entry] of Object.entries(entries)) {
            const id = createHash('sha256').update(key).digest('hex');
            const value =
                typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
            blobs[key] = path.join(blobDir, id);
            await writeFile(blobs[key], value);
            old.prepare('INSERT INTO _mf_entries VALUES (?, ?, ?, ?)').run(
                key,
                id,
                entry.expiration ?? null,
                entry.metadata ? JSON.stringify(entry.metadata) : null
            );
        }
    } finally {
        old.close();
    }
    return { file, blobs };
}
