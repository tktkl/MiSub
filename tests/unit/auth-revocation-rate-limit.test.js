// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    authMiddleware,
    createSessionToken,
    getAuthSessionDiagnostic,
    handleLogin,
    handleRevokeSessions,
    initializeSessionCredentials,
    renewAuthSession,
} from '../../functions/modules/auth-middleware.js';
import { getCookieSecret, setAdminPassword } from '../../functions/modules/utils.js';
import { handleUpdatePassword } from '../../functions/modules/api-handler.js';
import { SettingsCache } from '../../functions/storage-adapter.js';
import {
    beginLoginAttempt,
    finishLoginAttempt,
    recordLoginFailure,
} from '../../functions/modules/login-protection.js';

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
afterEach(() => {
    vi.restoreAllMocks();
    SettingsCache.clear();
});

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

    it.each(['sessions', 'password'])(
        'keeps an in-flight renewal revoked after %s rotation',
        async (rotation) => {
            const env = environment();
            delete env.ADMIN_PASSWORD;
            await setAdminPassword(env, 'first-password');
            const oldToken = await createSessionToken(env, Date.now() - 8 * 24 * 60 * 60 * 1000);
            let verified;
            let release;
            const reachedVerification = new Promise((resolve) => {
                verified = resolve;
            });
            const resume = new Promise((resolve) => {
                release = resolve;
            });
            const verify = crypto.subtle.verify.bind(crypto.subtle);
            vi.spyOn(crypto.subtle, 'verify').mockImplementationOnce(async (...args) => {
                const valid = await verify(...args);
                verified();
                await resume;
                return valid;
            });

            const renewal = renewAuthSession(sessionRequest(oldToken), env, new Response('ok'));
            try {
                await reachedVerification;
                if (rotation === 'sessions') {
                    await handleRevokeSessions(
                        new Request('https://example.com/api/settings/sessions/revoke', {
                            method: 'POST',
                        }),
                        env
                    );
                } else {
                    await setAdminPassword(env, 'second-password');
                }
            } finally {
                release();
            }
            const response = await renewal;
            const renewed = response.headers
                .get('Set-Cookie')
                .split(';')[0]
                .slice('auth_session='.length);
            expect(await authMiddleware(sessionRequest(oldToken), env)).toBe(false);
            expect(await authMiddleware(sessionRequest(renewed), env)).toBe(false);
            expect(await authMiddleware(sessionRequest(await createSessionToken(env)), env)).toBe(
                true
            );
            const diagnostic = await getAuthSessionDiagnostic(
                sessionRequest(await createSessionToken(env)),
                env
            );
            expect(diagnostic).not.toHaveProperty('signingKey');
        }
    );

    it.each(["''abcdef''", '""abcdef""', "'  abcdef  '", '\u200B"abcdef"\u200B'])(
        'accepts the chosen password unchanged after a successful update: %s',
        async (password) => {
            const env = environment();
            delete env.ADMIN_PASSWORD;
            await setAdminPassword(env, 'old-password');
            const oldToken = await createSessionToken(env);
            await env.MISUB_KV.put(
                'worker_settings_v1',
                JSON.stringify({ customLoginPath: 'saved-login' })
            );
            const response = await handleUpdatePassword(loginRequest(password), env);
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
                reauthenticate: true,
                loginPath: '/saved-login',
            });
            expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
            expect((await handleLogin(loginRequest(password), env)).status).toBe(200);
            expect(await authMiddleware(sessionRequest(oldToken), env)).toBe(false);
            expect((await handleLogin(loginRequest('old-password'), env)).status).toBe(401);
        }
    );

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
    it('keeps unrelated logins independent when the client table fills up', async () => {
        const env = environment();
        for (let index = 0; index < 2048; index++) {
            const attempt = beginLoginAttempt(env, `2001:db8::${index.toString(16)}`);
            recordLoginFailure(env, attempt.key);
            finishLoginAttempt(env, attempt.key);
        }
        const offender = { clientIp: '2001:db8:1::1' };
        for (let index = 0; index < 5; index++) {
            expect((await handleLogin(loginRequest('wrong'), env, offender)).status).toBe(401);
        }
        expect((await handleLogin(loginRequest('wrong'), env, offender)).status).toBe(429);
        expect(
            (await handleLogin(loginRequest(env.ADMIN_PASSWORD), env, { clientIp: '203.0.113.80' }))
                .status
        ).toBe(200);
        expect((await handleLogin(loginRequest('wrong'), env, offender)).status).toBe(429);
    });

    it("releases full in-flight capacity without inheriting another client's failures", async () => {
        const env = environment();
        const attempts = Array.from({ length: 2048 }, (_, index) =>
            beginLoginAttempt(env, `2001:db8::${index.toString(16)}`)
        );
        expect(attempts.every((attempt) => attempt.seconds === 0)).toBe(true);
        expect(beginLoginAttempt(env, '203.0.113.80').seconds).toBe(1);
        finishLoginAttempt(env, attempts[0].key);
        expect(
            (await handleLogin(loginRequest(env.ADMIN_PASSWORD), env, { clientIp: '203.0.113.80' }))
                .status
        ).toBe(200);
        for (const attempt of attempts.slice(1)) finishLoginAttempt(env, attempt.key);
    });
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
