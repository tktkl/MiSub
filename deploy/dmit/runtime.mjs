import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { openStorage } from './storage.mjs';
import { createNativeServer } from './server.mjs';
import { onRequest, initializeSessionCredentials } from './build/backend.mjs';
import { createPublicFetch } from './build/public-fetch.mjs';
import { localProxyAddresses } from './client-address.mjs';

process.umask(0o077);
const root = path.resolve(import.meta.dirname, '../..');
const publicUrl = process.env.MISUB_PUBLIC_URL;
if (
    !publicUrl?.trim() ||
    !process.env.ADMIN_PASSWORD?.trim() ||
    !process.env.COOKIE_SECRET?.trim()
) {
    throw new Error('MISUB_PUBLIC_URL, ADMIN_PASSWORD and COOKIE_SECRET are required');
}
const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const schema = await readFile(path.join(root, 'schema.sql'), 'utf8');
const storage = await openStorage(process.env.MISUB_DATA_DIR || '/data', schema);
const bindings = {
    MISUB_KV: storage.kv,
    MISUB_DB: storage.d1,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    COOKIE_SECRET: process.env.COOKIE_SECRET,
    MISUB_PUBLIC_URL: publicUrl,
    CORS_ORIGINS: new URL(publicUrl).origin,
    ENABLE_AUTH_DIAGNOSTICS: 'false',
    PUBLIC_FETCH: createPublicFetch(),
};
await initializeSessionCredentials(bindings);
const app = await createNativeServer({
    onRequest,
    publicUrl,
    assetsDirectory: path.join(root, 'dist'),
    trustProxy: process.env.MISUB_TRUST_PROXY === 'true',
    proxyAddresses: await localProxyAddresses(),
    env: bindings,
});

let stopping = false;
async function stop(code) {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(code || 1), 10_000);
    deadline.unref();
    try {
        await app.close();
        storage.close();
        clearTimeout(deadline);
        process.exitCode = code;
    } catch (error) {
        console.error('[Shutdown]', error);
        process.exit(1);
    }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop(0));
app.server.on('error', (error) => {
    console.error('[Server]', error);
    void stop(1);
});
app.server.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`MiSub native Node.js server ready on port ${port}`);
});
