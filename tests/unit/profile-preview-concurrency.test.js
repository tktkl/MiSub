// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicFetch } from '../../deploy/dmit/public-fetch.mjs';
import { handleProfileMode } from '../../functions/modules/subscription/profile-handler.js';
import { SettingsCache } from '../../functions/storage-adapter.js';

afterEach(() => {
    vi.useRealTimers();
    SettingsCache.clear();
});

describe('profile preview with native download limits', () => {
    it.each([5, 9])('returns every healthy source in a %i-source group', async (count) => {
        vi.useFakeTimers();
        const sources = Array.from({ length: count }, (_, index) => ({
            id: `source-${index}`,
            name: `Source ${index}`,
            enabled: true,
            url: `https://source${index}.example/sub`,
        }));
        const values = new Map([
            ['worker_settings_v1', JSON.stringify({ storageType: 'kv' })],
            ['misub_subscriptions_v1', JSON.stringify(sources)],
            [
                'misub_profiles_v1',
                JSON.stringify([
                    {
                        id: 'group',
                        enabled: true,
                        subscriptions: sources.map((source) => source.id),
                        manualNodes: [],
                    },
                ]),
            ],
        ]);
        const fetched = [];
        const env = {
            MISUB_KV: {
                get: async (key) => values.get(key) ?? null,
                put: async (key, value) => {
                    values.set(key, value);
                },
                delete: async (key) => {
                    values.delete(key);
                },
            },
            PUBLIC_FETCH: createPublicFetch({
                createAgent: () => ({ destroy: async () => {} }),
                fetcher: async (url) => {
                    fetched.push(url);
                    await new Promise((resolve) => setTimeout(resolve, 4000));
                    return new Response(
                        `trojan://test-password@node.example:443#${new URL(url).hostname}`
                    );
                },
            }),
        };
        const preview = handleProfileMode(
            new Request('https://example.com/api/subscription_nodes'),
            env,
            'group',
            'Test/1.0'
        );
        await vi.runAllTimersAsync();
        const result = await preview;
        expect(result.subscriptions.every((source) => source.success)).toBe(true);
        expect(result.totalCount).toBe(count);
        expect(new Set(fetched).size).toBe(count);
    });
});
