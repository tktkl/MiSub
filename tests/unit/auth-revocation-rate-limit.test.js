// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    authMiddleware,
    createSessionToken,
    getAuthSessionDiagnostic,
    handleLogin,
    handleRevokeSessions,
    initializeSessionCredentials,
} from '../../functions/modules/auth-middleware.js';
import { getCookieSecret, setAdminPassword } from '../../functions/modules/utils.js';

function environment() {
    const values = new Map();
    const kv = {
        get: async (key) => values.get(key) ?? null,
        put: async (key, value) => {
            values.set(key, value);
        },
        delete: async (key) => {
            values.delete(key);
        },
    };
    return {
        MISUB_KV: kv,
        ADMIN_PASSWORD: 'test-admin-password',
        COOKIE_SECRET: 'test-session-secret',
    };
}
const sessionRequest = (token) =>
    new Request('https://example.com/api/settings', {
        headers: { Cookie: `auth_session=${token}` },
    });
const loginRequest = (password, headers = {}) =>
    new Request('https://example.com/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ password }),
    });
afterEach(() => vi.restoreAllMocks());

describe('credential-bound revocable admin sessions', () => {
    it('invalidates sessions on password or environment-secret changes', async () => {
        const env = environment();
        await env.MISUB_KV.put('SYSTEM_COOKIE_SECRET', 'old-persisted-secret');
        const token = await createSessionToken(env);
        expect(await authMiddleware(sessionRequest(token), env)).toBe(true);
        expect(await getCookieSecret({ ...env, COOKIE_SECRET: 'new-session-secret' })).toBe(
            'new-session-secret'
        );
        expect(
            await authMiddleware(sessionRequest(token), {
                ...env,
                ADMIN_PASSWORD: 'new-admin-password',
            })
        ).toBe(false);
        expect(
            await authMiddleware(sessionRequest(token), {
                ...env,
                COOKIE_SECRET: 'new-session-secret',
            })
        ).toBe(false);
    });

    it('keeps sessions across unchanged restarts and prevents resurrection after rotating credentials back', async () => {
        const env = environment();
        await initializeSessionCredentials(env);
        const token = await createSessionToken(env);
        await initializeSessionCredentials({ ...env });
        expect(await authMiddleware(sessionRequest(token), env)).toBe(true);
        await initializeSessionCredentials({ ...env, ADMIN_PASSWORD: 'rotated-password' });
        await initializeSessionCredentials(env);
        expect(await authMiddleware(sessionRequest(token), env)).toBe(false);
    });

    it('revokes all devices without changing subscription or administrator credentials', async () => {
        const env = environment();
        const token = await createSessionToken(env);
        const response = await handleRevokeSessions(
            new Request('https://example.com/api/settings/sessions/revoke', { method: 'POST' }),
            env
        );
        expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
        expect(await authMiddleware(sessionRequest(token), env)).toBe(false);
        expect(await authMiddleware(sessionRequest(await createSessionToken(env)), env)).toBe(true);
    });

    it('revokes sessions when a KV password changes, even if the old password is restored', async () => {
        const env = environment();
        delete env.ADMIN_PASSWORD;
        await setAdminPassword(env, 'first-password');
        const token = await createSessionToken(env);
        await setAdminPassword(env, 'second-password');
        await setAdminPassword(env, 'first-password');
        expect(await authMiddleware(sessionRequest(token), env)).toBe(false);
    });

    it('rejects signed timestamps from the future', async () => {
        const env = environment();
        const diagnostic = await getAuthSessionDiagnostic(
            sessionRequest(await createSessionToken(env, Date.now() + 120_000)),
            env
        );
        expect(diagnostic.isAuthenticated).toBe(false);
    });

    it('does not accept blank or invisible characters as a new password', async () => {
        const env = environment();
        delete env.ADMIN_PASSWORD;
        await expect(setAdminPassword(env, '      ')).rejects.toThrow(/6/);
        await expect(setAdminPassword(env, '\u200B'.repeat(8))).rejects.toThrow(/6/);
    });
});

describe('application login failure throttling', () => {
    it('limits simultaneous attempts before asynchronous password checks complete', async () => {
        const env = environment();
        const responses = await Promise.all(
            Array.from({ length: 20 }, () => handleLogin(loginRequest('wrong'), env))
        );
        expect(responses.filter((response) => response.status === 401)).toHaveLength(5);
        expect(responses.filter((response) => response.status === 429)).toHaveLength(15);
    });

    it('counts failures inside the fifteen-minute window rather than accumulating indefinitely', async () => {
        const clock = vi.spyOn(Date, 'now');
        const env = environment();
        for (let index = 0; index < 5; index++) {
            clock.mockReturnValue(1_790_000_000_000 + index * 4 * 60_000);
            expect((await handleLogin(loginRequest('wrong'), env)).status).toBe(401);
        }
        expect((await handleLogin(loginRequest(env.ADMIN_PASSWORD), env)).status).toBe(200);
    });

    it('releases attempt slots after malformed request bodies', async () => {
        const env = environment();
        for (let index = 0; index < 2; index++) {
            expect(
                (
                    await handleLogin(
                        new Request('https://example.com/api/login', { method: 'POST', body: '{' }),
                        env
                    )
                ).status
            ).toBe(400);
        }
        expect((await handleLogin(loginRequest(env.ADMIN_PASSWORD), env)).status).toBe(200);
    });

    it('blocks repeated failures, ignores forged forwarding headers, and isolates other clients', async () => {
        const env = environment();
        const client = { clientIp: '203.0.113.7' };
        for (let index = 0; index < 5; index++) {
            const response = await handleLogin(
                loginRequest('wrong', { 'CF-Connecting-IP': `192.0.2.${index}` }),
                env,
                client
            );
            expect(response.status).toBe(401);
        }
        const limited = await handleLogin(loginRequest(env.ADMIN_PASSWORD), env, client);
        expect(limited.status).toBe(429);
        expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
        expect(
            (await handleLogin(loginRequest(env.ADMIN_PASSWORD), env, { clientIp: '203.0.113.8' }))
                .status
        ).toBe(200);
    });

    it('increases backoff after another failure and resets failures after a successful login', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000);
        const env = environment();
        for (let index = 0; index < 5; index++) await handleLogin(loginRequest('wrong'), env);
        expect((await handleLogin(loginRequest('wrong'), env)).headers.get('Retry-After')).toBe(
            '30'
        );
        clock.mockReturnValue(1_790_000_030_001);
        expect((await handleLogin(loginRequest('wrong'), env)).status).toBe(401);
        expect((await handleLogin(loginRequest('wrong'), env)).headers.get('Retry-After')).toBe(
            '60'
        );
        clock.mockReturnValue(1_790_000_090_002);
        expect((await handleLogin(loginRequest(env.ADMIN_PASSWORD), env)).status).toBe(200);
        expect((await handleLogin(loginRequest('wrong'), env)).status).toBe(401);
    });
});
