const states = new WeakMap();
const fallback = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_CLIENTS = 2048;
const MAX_FAILURES = 5;
let auditWindow = { since: 0, count: 0 };

function store(env) {
    const binding = env?.MISUB_KV || env;
    if (!binding || typeof binding !== 'object') return fallback;
    if (!states.has(binding)) states.set(binding, new Map());
    return states.get(binding);
}

export function loginClient(request, context = {}) {
    // Native HTTP supplies this out of band. CF-Connecting-IP is trusted only in CF's runtime.
    return (
        context.clientIp || (request.cf ? request.headers.get('CF-Connecting-IP') : '') || 'unknown'
    );
}

export function beginLoginAttempt(env, client) {
    const clients = store(env);
    const now = Date.now();
    for (const [key, entry] of clients) {
        if (!entry.pending && now - entry.lastFailure >= WINDOW_MS && entry.blockedUntil <= now)
            clients.delete(key);
    }
    const key = clients.has(client) || clients.size < MAX_CLIENTS ? client : 'overflow';
    const entry = clients.get(key) || {
        failures: [],
        pending: 0,
        blockedUntil: 0,
        lastFailure: now,
    };
    const seconds = Math.max(0, Math.ceil((entry.blockedUntil - now) / 1000));
    if (seconds || entry.pending >= MAX_FAILURES) return { key, seconds: seconds || 1 };
    entry.pending++;
    clients.set(key, entry);
    return { key, seconds: 0 };
}

export function finishLoginAttempt(env, key) {
    const clients = store(env);
    const entry = clients.get(key);
    if (!entry) return;
    entry.pending = Math.max(0, entry.pending - 1);
    if (!entry.pending && !entry.failures.length) clients.delete(key);
}

export function recordLoginFailure(env, key) {
    const clients = store(env);
    const now = Date.now();
    const entry = clients.get(key) || { failures: [], pending: 0, blockedUntil: 0 };
    entry.failures = [...entry.failures.filter((time) => now - time < WINDOW_MS), now].slice(-10);
    entry.lastFailure = now;
    if (entry.failures.length >= MAX_FAILURES)
        entry.blockedUntil =
            now +
            Math.min(15 * 60, 30 * 2 ** Math.min(entry.failures.length - MAX_FAILURES, 5)) * 1000;
    clients.set(key, entry);
}

export function recordLoginSuccess(env, key) {
    const entry = store(env).get(key);
    if (entry) {
        entry.failures = [];
        entry.blockedUntil = 0;
    }
}

export function auditLogin(event, client) {
    const now = Date.now();
    if (now - auditWindow.since >= 60_000) auditWindow = { since: now, count: 0 };
    if (auditWindow.count++ < 20)
        console.info('[AuthAudit]', { event, client, time: new Date(now).toISOString() });
}
