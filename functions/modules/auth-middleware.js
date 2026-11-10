/**
 * 认证中间件模块
 * 处理用户认证和会话管理
 */

import {
    COOKIE_NAME,
    SESSION_DURATION,
    SESSION_RENEW_THRESHOLD,
    KV_KEY_SETTINGS,
} from './config.js';
import {
    getCookieSecret,
    getAdminPassword,
    getAuthDebugInfo,
    JSON_BODY_LIMITS,
    RequestBodyTooLargeError,
    readJsonWithLimit,
    normalizeAdminPassword as normalizeSecret,
} from './utils.js';
import { StorageFactory } from '../storage-adapter.js';
import {
    auditLogin,
    loginClient,
    beginLoginAttempt,
    finishLoginAttempt,
    recordLoginFailure,
    recordLoginSuccess,
} from './login-protection.js';

function buildRequestMeta(request, env) {
    return {
        url: request?.url,
        method: request?.method,
        contentType: request?.headers?.get('Content-Type'),
        contentLength: request?.headers?.get('Content-Length'),
        userAgent: request?.headers?.get('User-Agent'),
        origin: request?.headers?.get('Origin'),
        referer: request?.headers?.get('Referer'),
        cfRay: request?.headers?.get('CF-Ray'),
        hasKv: !!StorageFactory.resolveKV(env),
        hasD1: !!env?.MISUB_DB,
    };
}

async function isUsingDefaultAdminPassword(env) {
    const debugInfo = await getAuthDebugInfo(env);
    return debugInfo?.adminPassword?.isDefaultFallback === true;
}

async function sessionDigest(secret, data) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
        ''
    );
}

async function sessionSigningKey(env) {
    const secret = await getCookieSecret(env);
    const password = normalizeSecret(await getAdminPassword(env));
    const version =
        (await StorageFactory.resolveKV(env)?.get('SYSTEM_SESSION_VERSION')) || 'initial';
    return sessionDigest(secret, JSON.stringify(['MiSub/admin-session/v2', password, version]));
}

export async function initializeSessionCredentials(env) {
    const kv = StorageFactory.resolveKV(env);
    if (!kv) throw new Error('Session revocation requires persistent storage');
    if (normalizeSecret(await getAdminPassword(env)).length < 6)
        throw new Error('ADMIN_PASSWORD must contain at least 6 effective characters');
    const fingerprint = await sessionDigest(
        await getCookieSecret(env),
        JSON.stringify(['MiSub/credentials/v1', normalizeSecret(await getAdminPassword(env))])
    );
    if ((await kv.get('SYSTEM_SESSION_CREDENTIALS')) !== fingerprint) {
        await kv.put('SYSTEM_SESSION_VERSION', crypto.randomUUID());
        await kv.put('SYSTEM_SESSION_CREDENTIALS', fingerprint);
    }
}

export async function createSessionToken(env, issuedAt = Date.now()) {
    return createSignedToken(await sessionSigningKey(env), `v2:${issuedAt}`);
}

export async function handleRevokeSessions(request, env) {
    if (request.method !== 'POST')
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
    const kv = StorageFactory.resolveKV(env);
    if (!kv) return new Response('Persistent session storage unavailable', { status: 503 });
    const loginPath = await getAdminLoginPath(env);
    await kv.put('SYSTEM_SESSION_VERSION', crypto.randomUUID());
    return handleLogout(request, { loginPath });
}

// Only include this path in authenticated management responses.
export async function getAdminLoginPath(env) {
    const storage = StorageFactory.createAdapter(env, await StorageFactory.getStorageType(env));
    const settings = await storage.get(KV_KEY_SETTINGS);
    const path =
        typeof settings?.customLoginPath === 'string'
            ? settings.customLoginPath.trim().replace(/^\/+/, '')
            : '';
    return path ? `/${path}` : '/login';
}

/**
 * 创建 HMAC 签名的令牌
 * @param {string} key - 签名密钥
 * @param {string} data - 要签名的数据
 * @returns {Promise<string>} 签名后的令牌
 */
export async function createSignedToken(key, data) {
    if (!key || !data) throw new Error('Key and data are required for signing.');
    const encoder = new TextEncoder();
    const keyData = encoder.encode(key);
    const dataToSign = encoder.encode(data);
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataToSign);
    return `${data}.${Array.from(new Uint8Array(signature))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')}`;
}

/**
 * 验证 HMAC 签名令牌
 * @param {string} key - 验证密钥
 * @param {string} token - 要验证的令牌
 * @returns {Promise<string|null>} 验证成功返回数据，失败返回 null
 */
export async function verifySignedToken(key, token) {
    if (!key || !token) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [data, signatureHex] = parts;
    if (!/^[a-f0-9]{64}$/i.test(signatureHex) || data.length > 256) return null;

    try {
        const encoder = new TextEncoder();
        const keyData = encoder.encode(key);
        const dataToVerify = encoder.encode(data);

        // Convert hex to Uint8Array
        const sigBytes = new Uint8Array(signatureHex.length / 2);
        for (let i = 0; i < signatureHex.length; i += 2) {
            sigBytes[i / 2] = parseInt(signatureHex.substring(i, i + 2), 16);
        }

        // Import key for verification
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            keyData,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['verify']
        );

        // Use native timing-safe verification
        const isValid = await crypto.subtle.verify('HMAC', cryptoKey, sigBytes, dataToVerify);

        return isValid ? data : null;
    } catch (e) {
        console.error('[Auth] Token verify error:', e);
        return null;
    }
}

/**
 * 获取认证会话调试信息（不包含敏感值）
 * @param {Request} request
 * @param {Object} env
 * @returns {Promise<Object>}
 */
export async function getAuthSessionDiagnostic(request, env) {
    return (await inspectAuthSession(request, env)).diagnostic;
}

async function inspectAuthSession(request, env) {
    const result = {
        isAuthenticated: false,
        reason: 'unknown',
        cookieHeaderPresent: false,
        authSessionCookieCount: 0,
        token: {
            exists: false,
            decodeMode: 'none',
            length: 0,
            partCount: 0,
        },
        verify: {
            success: false,
            hasTimestamp: false,
            isExpired: null,
            sessionAgeMs: null,
        },
        shouldRenew: false,
    };

    const cookieHeader = request.headers.get('Cookie') || '';
    result.cookieHeaderPresent = cookieHeader.length > 0;

    const matchedCookies = cookieHeader
        .split(';')
        .map((c) => c.trim())
        .filter((c) => c.startsWith(`${COOKIE_NAME}=`));

    result.authSessionCookieCount = matchedCookies.length;
    if (matchedCookies.length === 0) {
        result.reason = 'no_cookie';
        return { diagnostic: result };
    }

    const rawToken = matchedCookies[matchedCookies.length - 1].slice(COOKIE_NAME.length + 1);
    if (!rawToken) {
        result.reason = 'empty_token';
        return { diagnostic: result };
    }

    let token = rawToken;
    try {
        token = decodeURIComponent(rawToken);
        result.token.decodeMode = 'decodeURIComponent';
    } catch (_) {
        result.token.decodeMode = 'raw';
    }

    token = String(token || '').replace(/^"|"$/g, '');
    result.token.exists = token.length > 0;
    result.token.length = token.length;
    result.token.partCount = token ? token.split('.').length : 0;

    if (!token) {
        result.reason = 'empty_token';
        return { diagnostic: result };
    }

    const signingKey = await sessionSigningKey(env);
    const verifiedData = await verifySignedToken(signingKey, token);
    if (!verifiedData) {
        result.reason = 'invalid_signature_or_secret';
        return { diagnostic: result };
    }

    result.verify.success = true;
    const ts = /^v2:\d{13}$/.test(verifiedData) ? Number(verifiedData.slice(3)) : NaN;
    const hasTimestamp = Number.isFinite(ts) && ts <= Date.now() + 60_000;
    result.verify.hasTimestamp = hasTimestamp;

    if (!hasTimestamp) {
        result.reason = 'invalid_timestamp';
        return { diagnostic: result };
    }

    const sessionAgeMs = Date.now() - ts;
    const isExpired = sessionAgeMs >= SESSION_DURATION;
    result.verify.isExpired = isExpired;
    result.verify.sessionAgeMs = sessionAgeMs;
    if (isExpired) {
        result.reason = 'expired';
        return { diagnostic: result };
    }

    result.isAuthenticated = true;
    result.shouldRenew = sessionAgeMs >= SESSION_RENEW_THRESHOLD;
    result.reason = 'ok';
    return { diagnostic: result, signingKey };
}

/**
 * Renew an authenticated browser session once it reaches the renewal threshold.
 * The original token timestamp is replaced, making SESSION_DURATION an idle timeout.
 * @param {Request} request
 * @param {Object} env
 * @param {Response} response
 * @returns {Promise<Response>}
 */
export async function renewAuthSession(request, env, response) {
    const { diagnostic: authDiagnostic, signingKey } = await inspectAuthSession(request, env);
    if (!authDiagnostic?.isAuthenticated || !authDiagnostic.shouldRenew) {
        return response;
    }

    // A concurrent revocation must also invalidate this renewal. Reuse the exact
    // credential/version snapshot that verified the incoming cookie.
    const token = await createSignedToken(signingKey, `v2:${Date.now()}`);
    const isSecure = request.url.startsWith('https');
    const cookieString = `${COOKIE_NAME}=${token}; Path=/; HttpOnly; ${isSecure ? 'Secure;' : ''} SameSite=Lax; Max-Age=${SESSION_DURATION / 1000}`;
    const renewedResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
    });
    renewedResponse.headers.append('Set-Cookie', cookieString);
    return renewedResponse;
}

/**
 * 获取登录密码诊断信息（不返回明文密码）
 * @param {Request} request
 * @param {Object} env
 * @returns {Promise<Object>}
 */
export async function getLoginPasswordDiagnostic(request, env) {
    const debugInfo = await getAuthDebugInfo(env);
    const result = {
        success: false,
        matched: false,
        reason: 'unknown',
        runtime: {
            adminPasswordSource: debugInfo?.adminPassword?.source || 'unknown',
        },
        input: {
            provided: false,
            normalizedLength: 0,
        },
        expected: {
            normalizedLength: 0,
        },
    };

    let payload;
    try {
        payload = await readJsonWithLimit(request, JSON_BODY_LIMITS.auth);
    } catch (_) {
        result.reason = 'invalid_json';
        return result;
    }

    const inputPassword = normalizeSecret(payload?.password);
    const currentPassword = normalizeSecret(await getAdminPassword(env));

    result.input.provided = typeof payload?.password === 'string';
    result.input.normalizedLength = inputPassword.length;
    result.expected.normalizedLength = currentPassword.length;

    if (!result.input.provided) {
        result.reason = 'missing_password';
        return result;
    }

    result.matched = inputPassword === currentPassword;
    result.success = true;
    result.reason = result.matched ? 'matched' : 'mismatch';
    return result;
}

/**
 * 认证中间件 - 检查用户是否已登录
 * @param {Request} request - HTTP 请求对象
 * @param {Object} env - Cloudflare 环境对象
 * @returns {Promise<boolean>} 是否认证通过
 */
export async function authMiddleware(request, env) {
    const logMeta = buildRequestMeta(request, env);
    try {
        const diagnostic = await getAuthSessionDiagnostic(request, env);
        return diagnostic.isAuthenticated;
    } catch (e) {
        console.error('[Auth] 鉴权失败', { ...logMeta, error: e?.message });
        return false;
    }
}

/**
 * 处理用户登录
 * @param {Request} request - HTTP 请求对象
 * @param {Object} env - Cloudflare 环境对象
 * @returns {Promise<Response>} 登录响应
 */
export async function handleLogin(request, env, context = {}) {
    if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    const client = loginClient(request, context);
    const limit = beginLoginAttempt(env, client);
    if (limit.seconds) {
        auditLogin('login_throttled', client);
        return new Response(
            JSON.stringify({ error: '登录尝试过多，请稍后重试', retryAfterSeconds: limit.seconds }),
            {
                status: 429,
                headers: {
                    'Content-Type': 'application/json',
                    'Retry-After': String(limit.seconds),
                    'Cache-Control': 'no-store',
                },
            }
        );
    }
    try {
        return await processLoginAttempt(request, env, client, limit.key);
    } finally {
        finishLoginAttempt(env, limit.key);
    }
}

async function processLoginAttempt(request, env, client, limitKey) {
    const logMeta = buildRequestMeta(request, env);
    let payload;
    try {
        payload = await readJsonWithLimit(request, JSON_BODY_LIMITS.auth);
    } catch (e) {
        recordLoginFailure(env, limitKey);
        auditLogin('login_invalid_request', client);
        if (e instanceof RequestBodyTooLargeError) {
            return new Response(JSON.stringify({ error: e.message }), {
                status: e.status,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        return new Response(JSON.stringify({ error: '请求体解析失败' }), { status: 400 });
    }

    try {
        const { password } = payload || {};
        const inputPassword = typeof password === 'string' ? normalizeSecret(password) : null;
        const currentPassword = normalizeSecret(await getAdminPassword(env));
        const isPasswordMatched = inputPassword === currentPassword;

        if (isPasswordMatched) {
            recordLoginSuccess(env, limitKey);
            auditLogin('login_success', client);
            const token = await createSessionToken(env);
            const isSecure = request.url.startsWith('https');
            const cookieString = `${COOKIE_NAME}=${token}; Path=/; HttpOnly; ${isSecure ? 'Secure;' : ''} SameSite=Lax; Max-Age=${SESSION_DURATION / 1000}`;
            const responseBody = { success: true };
            if (await isUsingDefaultAdminPassword(env)) {
                responseBody.securityWarning = {
                    type: 'default_admin_password',
                    shouldChangePassword: true,
                    message: '当前正在使用默认管理员密码 admin，请登录后立即修改。',
                };
            }
            return new Response(JSON.stringify(responseBody), {
                headers: {
                    'Content-Type': 'application/json',
                    'Set-Cookie': cookieString,
                },
            });
        }
        recordLoginFailure(env, limitKey);
        auditLogin('login_failed', client);
        return new Response(JSON.stringify({ error: '密码错误' }), { status: 401 });
    } catch (e) {
        console.error('[API Error /login] Login handler failed', { ...logMeta, error: e?.message });
        return new Response(JSON.stringify({ error: '登录处理失败' }), { status: 500 });
    }
}

/**
 * 处理用户登出
 * @returns {Promise<Response>} 登出响应
 */
export async function handleLogout(request, details = {}) {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const isSecure = typeof request?.url === 'string' && request.url.startsWith('https');
    const secureFlag = isSecure ? 'Secure;' : '';
    headers.append(
        'Set-Cookie',
        `${COOKIE_NAME}=; Path=/; HttpOnly; ${secureFlag} SameSite=Strict; Max-Age=0`
    );
    return new Response(JSON.stringify({ success: true, ...details }), { headers });
}

/**
 * 获取认证失败的响应
 * @param {string} message - 错误消息
 * @returns {Response} 401 响应
 */
export function createUnauthorizedResponse(message = 'Unauthorized') {
    return new Response(JSON.stringify({ error: message }), { status: 401 });
}
