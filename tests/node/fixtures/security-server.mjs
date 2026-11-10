import { createNativeServer } from '../../../deploy/dmit/server.mjs';
import { onRequest, initializeSessionCredentials } from '../../../deploy/dmit/build/backend.mjs';
import { createPublicFetch } from '../../../deploy/dmit/build/public-fetch.mjs';

console.log = console.info = console.warn = () => {};
const store = new Map();
const kv = {
    async get(key) {
        return store.get(key) ?? null;
    },
    async put(key, value) {
        store.set(key, value);
    },
    async delete(key) {
        store.delete(key);
    },
    async list({ prefix = '' } = {}) {
        return {
            keys: [...store.keys()]
                .filter((key) => key.startsWith(prefix))
                .map((name) => ({ name })),
            list_complete: true,
        };
    },
};
const env = {
    MISUB_KV: kv,
    ADMIN_PASSWORD: 'test-admin-password',
    COOKIE_SECRET: 'test-session-secret',
    PUBLIC_FETCH: createPublicFetch(),
};
await kv.put(
    'worker_settings_v1',
    JSON.stringify({
        storageType: 'kv',
        mytoken: 'test-token',
        profileToken: 'test-group',
        enableAccessLog: false,
        enableTrafficNode: false,
        transformConfigMode: 'builtin',
        customLoginPath: 'test-login',
    })
);
await kv.put(
    'misub_subscriptions_v1',
    JSON.stringify(
        ['Review Long Node Name With Enough Characters', 'Review Tokyo'].map((name, index) => ({
            id: 'node-' + index,
            name,
            enabled: true,
            url: `trojan://test-password@192.0.2.${index + 1}:443#${encodeURIComponent(name)}`,
        }))
    )
);
await kv.put(
    'misub_profiles_v1',
    JSON.stringify([
        {
            id: 'test-profile',
            name: 'Private profile',
            enabled: true,
            isPublic: false,
            subscriptions: [],
            manualNodes: ['node-0', 'node-1'],
        },
    ])
);
await initializeSessionCredentials(env);
const app = await createNativeServer({
    onRequest,
    env,
    publicUrl: 'https://sub.example.com',
    assetsDirectory: process.argv[2],
});
app.server.listen(0, '127.0.0.1', () =>
    process.stdout.write(
        JSON.stringify({ base: 'http://127.0.0.1:' + app.server.address().port }) + '\n'
    )
);
