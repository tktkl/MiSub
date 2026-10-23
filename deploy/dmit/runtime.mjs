import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Miniflare } from 'miniflare';

const root = path.resolve(import.meta.dirname, '../..');
const dataDirectory = process.env.MISUB_DATA_DIR || '/data';
const publicUrl = process.env.MISUB_PUBLIC_URL;
if (!publicUrl || !process.env.ADMIN_PASSWORD || !process.env.COOKIE_SECRET) {
    throw new Error('MISUB_PUBLIC_URL, ADMIN_PASSWORD and COOKIE_SECRET are required');
}
await mkdir(dataDirectory, { recursive: true });

// 运行本 fork 编译的 Pages Functions；所有存储落在本机挂载目录。
const runtime = new Miniflare({
    name: 'misub',
    host: '0.0.0.0',
    port: Number(process.env.PORT || 8787),
    modules: true,
    scriptPath: path.join(root, 'deploy/dmit/build/index.js'),
    compatibilityDate: '2024-04-01',
    compatibilityFlags: ['nodejs_compat'],
    upstream: publicUrl,
    cf: false,
    kvNamespaces: ['MISUB_KV'],
    kvPersist: path.join(dataDirectory, 'kv'),
    d1Databases: { MISUB_DB: 'misub-local-db' },
    d1Persist: path.join(dataDirectory, 'd1'),
    cachePersist: path.join(dataDirectory, 'cache'),
    bindings: {
        ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
        COOKIE_SECRET: process.env.COOKIE_SECRET,
        MISUB_PUBLIC_URL: publicUrl,
        CORS_ORIGINS: new URL(publicUrl).origin,
        ENABLE_AUTH_DIAGNOSTICS: 'false',
    },
    assets: {
        directory: path.join(root, 'dist'),
        binding: 'ASSETS',
        routerConfig: {
            has_user_worker: true,
            invoke_user_worker_ahead_of_assets: true,
        },
        assetConfig: { not_found_handling: 'single-page-application' },
    },
});

await runtime.ready;
const database = await runtime.getD1Database('MISUB_DB');
const schema = await readFile(path.join(root, 'schema.sql'), 'utf8');
for (const statement of schema.split(';').map((sql) => sql.trim()).filter(Boolean)) {
    await database.prepare(statement).run();
}
console.log(`MiSub ready at ${publicUrl}, local storage: ${dataDirectory}`);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        if (stopping) return;
        stopping = true;
        await runtime.dispose();
        process.exit(0);
    });
}
