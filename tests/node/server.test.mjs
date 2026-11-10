import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, legacyKV, schema } from './fixtures.mjs';
import { openStorage } from '../../deploy/dmit/storage.mjs';
import { createNativeServer } from '../../deploy/dmit/server.mjs';
import { onRequest } from '../../deploy/dmit/build/backend.mjs';

const publicUrl = 'https://sub.example.com';
async function listen(app) {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    return 'http://127.0.0.1:' + app.server.address().port;
}
function upload(base, route, text) {
    return new Promise((resolve, reject) => {
        const req = http.request(base + route, { method: 'POST' }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.write(text.slice(0, 7));
        req.end(text.slice(7));
    });
}

test('health checks bypass handlers; HTTP bridge streams bodies, cookies and cancellation safely', async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const app = await createNativeServer({
        publicUrl,
        assetsDirectory: f.assets,
        env: {},
        async onRequest({ request, waitUntil }) {
            calls++;
            const route = new URL(request.url).pathname;
            if (route === '/echo') return new Response(await request.text());
            if (route === '/cancel') {
                await request.body.cancel();
                return new Response('Too large', { status: 413 });
            }
            if (route === '/cookies') {
                const headers = new Headers();
                headers.append('Set-Cookie', 'first=one; HttpOnly');
                headers.append('Set-Cookie', 'second=two; HttpOnly');
                waitUntil(Promise.resolve());
                return new Response(request.url, { headers });
            }
            return new Response('missing', { status: 404 });
        },
    });
    f.cleanup(() => app.close());
    const base = await listen(app);
    for (let i = 0; i < 100; i++) assert.equal((await fetch(base + '/healthz')).status, 204);
    assert.equal(calls, 0);
    assert.equal((await fetch(base + '/healthz', { method: 'POST' })).status, 405);
    const echo = await upload(base, '/echo', 'A streamed request ' + 'x'.repeat(64_000));
    assert.equal(echo.status, 200);
    assert.equal(echo.body.length, 64_019);
    assert.equal((await upload(base, '/cancel', 'x'.repeat(64_000))).status, 413);
    const cookies = await fetch(base + '/cookies', { headers: { Host: 'untrusted.invalid' } });
    assert.equal(cookies.headers.getSetCookie().length, 2);
    assert.equal(await cookies.text(), publicUrl + '/cookies');
});

test('native backend rejects legacy sessions and preserves current sessions, CRUD, subscriptions and assets across restart', async (t) => {
    const f = await fixture(t);
    const secret = 'test-persistent-cookie-secret';
    const password = 'test-admin-password';
    const nodes = [
        {
            id: 'ss-node',
            name: 'SS test',
            enabled: true,
            nodeCount: 1,
            url:
                'ss://' +
                Buffer.from('aes-128-gcm:test').toString('base64url') +
                '@192.0.2.1:8388#SS',
        },
        {
            id: 'vless-node',
            name: 'VLESS test',
            enabled: true,
            nodeCount: 1,
            url: 'vless://00000000-0000-4000-8000-000000000001@192.0.2.2:443?encryption=none#VLESS',
        },
    ];
    await legacyKV(f.data, {
        SYSTEM_COOKIE_SECRET: { value: secret },
        worker_settings_v1: {
            value: {
                mytoken: 'node-token',
                profileToken: 'group-token',
                storageType: 'kv',
                enablePublicPage: false,
                transformConfigMode: 'builtin',
            },
        },
        misub_subscriptions_v1: { value: nodes },
        misub_profiles_v1: {
            value: [
                {
                    id: 'profile-check',
                    name: 'Test profile',
                    enabled: true,
                    isPublic: false,
                    subscriptions: [],
                    manualNodes: ['ss-node', 'vless-node'],
                },
            ],
        },
    });
    let storage, app, base;
    async function start() {
        storage = await openStorage(f.data, schema);
        app = await createNativeServer({
            onRequest,
            publicUrl,
            assetsDirectory: f.assets,
            env: {
                MISUB_KV: storage.kv,
                MISUB_DB: storage.d1,
                ADMIN_PASSWORD: password,
                COOKIE_SECRET: secret,
                CORS_ORIGINS: publicUrl,
            },
        });
        base = await listen(app);
    }
    await start();
    f.cleanup(async () => {
        await app.close();
        storage.close();
    });
    const api = async (route, cookie = '', data) => {
        const response = await fetch(base + route, {
            method: data === undefined ? 'GET' : 'POST',
            headers: {
                Origin: publicUrl,
                ...(cookie ? { Cookie: cookie } : {}),
                ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            body: data === undefined ? undefined : JSON.stringify(data),
        });
        return { response, data: await response.json() };
    };
    assert.equal((await api('/api/data')).data.authenticated, false);
    assert.equal((await api('/api/misubs', '', { misubs: [], profiles: [] })).response.status, 401);
    const timestamp = String(Date.now() - 86_400_000);
    const oldCookie =
        'auth_session=' +
        timestamp +
        '.' +
        createHmac('sha256', secret).update(timestamp).digest('hex');
    assert.equal((await api('/api/data', oldCookie)).data.authenticated, false);
    const login = await api('/api/login', '', { password });
    assert.equal(login.data.success, true);
    const setCookie = login.response.headers.getSetCookie()[0];
    assert.match(setCookie, /Secure;/);
    assert.match(setCookie, /HttpOnly;/);
    const cookie = setCookie.split(';')[0];
    for (const route of ['/migrate_to_d1', '/migrate_legacy_d1', '/migrate', '/cron/trigger']) {
        for (const method of ['GET', 'HEAD']) {
            const response = await fetch(base + '/api' + route, {
                method,
                headers: { Cookie: cookie, Origin: 'https://other-site.example' },
            });
            assert.equal(response.status, 405);
            assert.equal(response.headers.get('Allow'), 'POST');
            await response.arrayBuffer();
        }
        const crossSite = await fetch(base + '/api' + route, {
            method: 'POST',
            headers: { Cookie: cookie, Origin: 'https://other-site.example' },
        });
        assert.equal(crossSite.status, 403);
        await crossSite.arrayBuffer();
    }
    assert.equal(await storage.kv.get('cron_last_execution'), null);
    assert.equal((await api('/api/kv_test', cookie)).data.writeTest.match, true);
    assert.equal(
        (await api('/api/settings', cookie, { FileName: 'Native persisted' })).response.status,
        200
    );
    const current = (await api('/api/data', cookie)).data;
    assert.equal(current.config.FileName, 'Native persisted');
    current.misubs[0].name = 'Saved native name';
    const saved = await api('/api/misubs', cookie, {
        misubs: current.misubs,
        profiles: current.profiles,
    });
    assert.notEqual(saved.data.success, false);
    const exported = await fetch(base + '/group-token/profile-check', {
        headers: { 'User-Agent': 'Shadowrocket/2.2.90' },
    });
    assert.equal(exported.status, 200);
    const decoded = Buffer.from(await exported.text(), 'base64').toString();
    assert.match(decoded, /ss:\/\//);
    assert.match(decoded, /vless:\/\//);
    const html = await fetch(base + '/login');
    assert.match(await html.text(), /MiSub test/);
    assert.match(html.headers.get('Cache-Control'), /no-store/);
    const asset = await fetch(base + '/assets/app.js');
    assert.match(asset.headers.get('Content-Type'), /javascript/);
    assert.match(await asset.text(), /asset/);
    assert.equal((await fetch(base + '/assets/missing.js')).status, 404);
    await writeFile(path.join(f.root, 'outside.txt'), 'private outside root');
    await symlink(path.join(f.root, 'outside.txt'), path.join(f.assets, 'outside.txt'));
    assert.equal((await fetch(base + '/outside.txt')).status, 404);
    await app.close();
    storage.close();
    await start();
    const restarted = (await api('/api/data', cookie)).data;
    assert.equal(restarted.misubs[0].name, 'Saved native name');
    assert.equal(restarted.config.FileName, 'Native persisted');
});
