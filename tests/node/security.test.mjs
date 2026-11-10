import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixtures.mjs';

test(
    'anonymous subscriptions stay responsive and isolated; sessions revoke and forged IP headers cannot evade login throttling',
    { timeout: 10_000 },
    async (t) => {
        const f = await fixture(t);
        const child = spawn(
            process.execPath,
            [fileURLToPath(new URL('./fixtures/security-server.mjs', import.meta.url)), f.assets],
            { stdio: ['ignore', 'pipe', 'pipe'] }
        );
        let errors = '';
        child.stderr.on('data', (chunk) => {
            errors = (errors + chunk).slice(-4000);
        });
        const exited = once(child, 'exit');
        f.cleanup(async () => {
            child.kill('SIGKILL');
            await exited;
        });
        const lines = createInterface({ input: child.stdout });
        const { base } = await Promise.race([
            once(lines, 'line').then(([line]) => JSON.parse(line)),
            exited.then(([code]) => {
                throw new Error('Fixture exited: ' + code + ' ' + errors);
            }),
        ]);
        lines.close();
        const download = async (query = '') => {
            const response = await fetch(base + '/test-group/test-profile' + query, {
                headers: { 'User-Agent': 'Shadowrocket/2.2.90' },
                signal: AbortSignal.timeout(1000),
            });
            assert.equal(response.status, 200);
            return {
                content: Buffer.from(await response.text(), 'base64').toString(),
                cache: response.headers.get('X-Cache-Status'),
            };
        };
        const original = await download();
        const custom = await download(
            '?' + new URLSearchParams({ refresh: '1', rename: 'Review@Client' })
        );
        assert.match(custom.content, /Client/);
        const ordinary = await download();
        assert.equal(ordinary.cache, 'HIT');
        assert.equal(ordinary.content, original.content);
        const malicious = await download(
            '?' + new URLSearchParams({ refresh: '1', rename: '^(.+)+Z$@x' })
        );
        assert.equal(malicious.content, original.content);
        assert.equal(
            (await fetch(base + '/healthz', { signal: AbortSignal.timeout(500) })).status,
            204
        );

        const login = await fetch(base + '/api/login', {
            method: 'POST',
            headers: { Origin: 'https://sub.example.com', 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: 'test-admin-password' }),
        });
        assert.equal(login.status, 200);
        const cookie = login.headers.getSetCookie()[0].split(';')[0];
        const auth = { Cookie: cookie, Origin: 'https://sub.example.com' };
        assert.equal((await fetch(base + '/api/settings', { headers: auth })).status, 200);
        assert.equal(
            (
                await fetch(base + '/api/settings/sessions/revoke', {
                    method: 'POST',
                    headers: { ...auth, Origin: 'https://other.example' },
                })
            ).status,
            403
        );
        assert.equal((await fetch(base + '/api/settings', { headers: auth })).status, 200);
        const revoked = await fetch(base + '/api/settings/sessions/revoke', {
            method: 'POST',
            headers: auth,
        });
        assert.equal(revoked.status, 200);
        assert.match(revoked.headers.get('Set-Cookie'), /Max-Age=0/);
        assert.equal((await fetch(base + '/api/settings', { headers: auth })).status, 401);

        for (let index = 0; index < 6; index++) {
            const response = await fetch(base + '/api/login', {
                method: 'POST',
                headers: {
                    Origin: 'https://sub.example.com',
                    'Content-Type': 'application/json',
                    'CF-Connecting-IP': `198.51.100.${index}`,
                    'X-Real-IP': `198.51.100.${index}`,
                    'X-Forwarded-For': `198.51.100.${index}`,
                },
                body: JSON.stringify({ password: 'wrong' }),
            });
            assert.equal(response.status, index < 5 ? 401 : 429);
            if (index === 5) assert.ok(Number(response.headers.get('Retry-After')) > 0);
            await response.arrayBuffer();
        }
        assert.equal((await download()).content, original.content);
    }
);
