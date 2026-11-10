import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, legacyKV, schema } from './fixtures.mjs';
import { openStorage } from '../../deploy/dmit/storage.mjs';

test('imports legacy KV/D1 once, preserves credentials and metadata, and persists later changes', async (t) => {
    const f = await fixture(t);
    const time = Date.now();
    const legacy = await legacyKV(f.data, {
        SYSTEM_COOKIE_SECRET: { value: 'existing-cookie-secret' },
        worker_settings_v1: { value: { storageType: 'kv', mytoken: 'private-token' } },
        misub_subscriptions_v1: { value: [{ id: 'old-node' }] },
        'cache:valid': { value: 'cached', expiration: time + 60_000, metadata: { version: 1 } },
        'cache:expired': { value: 'expired', expiration: time - 1 },
    });
    const original = await readFile(legacy.file);
    const d1dir = path.join(f.data, 'd1/miniflare-D1DatabaseObject');
    await mkdir(d1dir, { recursive: true });
    const old = new DatabaseSync(path.join(d1dir, 'legacy.sqlite'));
    old.exec(schema);
    old.prepare('INSERT INTO subscriptions (id, data) VALUES (?, ?)').run(
        'd1-node',
        '{"name":"from D1"}'
    );
    old.close();
    let storage = await openStorage(f.data, schema, { now: () => time });
    let closed = false;
    f.cleanup(() => {
        if (!closed) storage.close();
    });
    assert.equal(await storage.kv.get('SYSTEM_COOKIE_SECRET'), 'existing-cookie-secret');
    assert.deepEqual(await storage.kv.get('worker_settings_v1', 'json'), {
        storageType: 'kv',
        mytoken: 'private-token',
    });
    assert.equal(await storage.kv.get('cache:expired'), null);
    assert.deepEqual((await storage.kv.list({ prefix: 'cache:' })).keys, [
        {
            name: 'cache:valid',
            expiration: Math.floor((time + 60_000) / 1000),
            metadata: { version: 1 },
        },
    ]);
    assert.deepEqual(
        await storage.d1
            .prepare('SELECT data FROM subscriptions WHERE id = ?')
            .bind('d1-node')
            .first(),
        { data: '{"name":"from D1"}' }
    );
    await storage.kv.put('misub_subscriptions_v1', '[{"id":"new-node"}]');
    storage.close();
    closed = true;
    storage = await openStorage(f.data, schema);
    closed = false;
    assert.deepEqual(await storage.kv.get('misub_subscriptions_v1', 'json'), [{ id: 'new-node' }]);
    assert.deepEqual(await readFile(legacy.file), original);
});

test('a missing legacy blob rolls back the import and can be retried after repair', async (t) => {
    const f = await fixture(t);
    const legacy = await legacyKV(f.data, { first: { value: 'one' }, missing: { value: 'two' } });
    await rm(legacy.blobs.missing);
    await assert.rejects(openStorage(f.data, schema), { code: 'ENOENT' });
    const db = new DatabaseSync(path.join(f.data, 'native.sqlite'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM node_kv').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM node_meta').get().n, 0);
    db.close();
    await writeFile(legacy.blobs.missing, 'two');
    const storage = await openStorage(f.data, schema);
    f.cleanup(() => storage.close());
    assert.equal(await storage.kv.get('missing'), 'two');
});

test('native KV expiration, literal prefixes, cursor pagination and binary values', async (t) => {
    const f = await fixture(t);
    let time = 1_800_000_000_000;
    const storage = await openStorage(f.data, schema, { now: () => time });
    f.cleanup(() => storage.close());
    await storage.kv.put('prefix_%:a', 'a', { expirationTtl: 60, metadata: { source: 'test' } });
    await storage.kv.put('prefix_%:b', 'b');
    await storage.kv.put('prefix-anything', 'unrelated');
    const page = await storage.kv.list({ prefix: 'prefix_%:', limit: 1 });
    assert.equal(page.list_complete, false);
    assert.equal(page.keys[0].name, 'prefix_%:a');
    assert.deepEqual(
        (await storage.kv.list({ prefix: 'prefix_%:', limit: 1, cursor: page.cursor })).keys,
        [{ name: 'prefix_%:b' }]
    );
    time += 60_000;
    assert.equal(await storage.kv.get('prefix_%:a'), null);
    assert.equal((await storage.kv.list({ prefix: 'prefix_%:' })).keys.length, 1);
    await storage.kv.put('bytes', new Uint8Array([0, 128, 255]));
    assert.deepEqual(
        new Uint8Array(await storage.kv.get('bytes', 'arrayBuffer')),
        new Uint8Array([0, 128, 255])
    );
    const insert = storage.d1.prepare('INSERT INTO subscriptions (id, data) VALUES (?, ?)');
    await insert.bind('one', '{}').run();
    await insert.bind('two', '{}').run();
    assert.equal(
        (await storage.d1.prepare('SELECT id FROM subscriptions ORDER BY id').all()).results.length,
        2
    );
});
