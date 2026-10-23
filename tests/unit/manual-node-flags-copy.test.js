import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useManualNodes } from '../../src/composables/useManualNodes.js';
import { useDataStore } from '../../src/stores/useDataStore.js';
import { extractNodeRegion, getRegionEmoji } from '../../functions/modules/utils/geo-utils.js';
import { urlsToClashProxies } from '../../functions/utils/url-to-clash.js';
import { pingNode } from '../../src/utils/ping.js';
import { generateCombinedNodeList } from '../../functions/services/subscription-service.js';
vi.mock('../../src/stores/toast.js', () => ({ useToastStore: () => ({ showToast: vi.fn() }) }));
vi.mock('../../src/utils/ping.js', () => ({ pingNode: vi.fn() }));

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
});

describe('display flags and clean subscription names', () => {
    it.each(['CN-ATRUST', 'CHN 01', 'China 01', '中国大陆 01'])('recognizes %s', (name) => {
        expect(extractNodeRegion(name)).toBe('中国');
        expect(getRegionEmoji(extractNodeRegion(name))).toBe('🇨🇳');
    });
    it('retains explicit opt-in flag injection and metadata without changing default names', () => {
        const url = 'vless://id@example.com:443#CN-ATRUST';
        const [normal] = urlsToClashProxies([url]);
        const [explicit] = urlsToClashProxies([url], { addFlagEmoji: true });
        expect(normal.name).toBe('CN-ATRUST');
        expect(normal.metadata.flag).toBe('🇨🇳');
        expect(explicit.name).toBe('🇨🇳 CN-ATRUST');
    });
    it('defaults only the icon, retaining the unknown region and other mappings', () => {
        expect(extractNodeRegion('OFFICE')).toBe('其他');
        expect(getRegionEmoji('其他')).toBe('🇨🇳');
        expect(getRegionEmoji()).toBe('🇨🇳');
        expect(getRegionEmoji(extractNodeRegion('US-DMIT'))).toBe('🇺🇸');
    });
    it('does not add automatic flags to generated node names', async () => {
        const nodes = ['CN-ATRUST', 'OFFICE', 'US-DMIT'].map((name, i) => ({
            id: `n${i}`,
            name,
            url: `vless://id@example.com:443#${name}`,
            enabled: true,
        }));
        const output = await generateCombinedNodeList(
            {},
            { enableFlagEmoji: true },
            'Shadowrocket',
            nodes,
            '',
            { enableManualNodes: false },
            false
        );
        expect(
            output
                .trim()
                .split('\n')
                .map((url) => decodeURIComponent(url.split('#')[1]))
        ).toEqual(nodes.map((node) => node.name));
    });
});

describe('duplicate manual node', () => {
    it('creates a separate id and deep copy, keeping protocol parameters and grouping', () => {
        const markDirty = vi.fn();
        const store = useDataStore();
        const nodes = useManualNodes(markDirty);
        const original = {
            id: 'original',
            name: 'US-DMIT',
            url: 'vless://id@example.com:443?security=reality&chain=ENTRY#US-DMIT',
            enabled: false,
            group: 'US',
            colorTag: 'red',
            nested: { value: 1 },
        };
        nodes.addNode(original);
        markDirty.mockClear();
        nodes.duplicateNode('original');
        const copy = store.subscriptions.find((n) => n.id !== 'original');
        expect(copy.id).toMatch(/^node_/);
        expect(copy).toMatchObject({
            name: 'US-DMIT copy',
            url: original.url,
            group: 'US',
            enabled: false,
            colorTag: 'red',
        });
        copy.nested.value = 2;
        expect(store.subscriptions.find((n) => n.id === 'original').nested.value).toBe(1);
        expect(markDirty).toHaveBeenCalledOnce();
        nodes.duplicateNode(copy.id);
        expect(new Set(store.subscriptions.map((n) => n.id)).size).toBe(3);
        expect(store.subscriptions.some((n) => n.name === 'US-DMIT copy copy')).toBe(true);
    });
});

describe('probe result lifecycle', () => {
    it('discards results for endpoints edited during a probe', async () => {
        const nodes = useManualNodes(vi.fn());
        const node = { id: 'n', name: 'test', url: 'vless://id@example.com:443', enabled: true };
        nodes.addNode(node);
        let finish;
        pingNode.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
        const pending = nodes.pingNodeId('n');
        nodes.updateNode({ ...node, url: 'vless://id@changed.example.com:443' });
        finish({ status: 'ok', latency: 1 });
        await pending;
        expect(nodes.pingResults.value.n).toBeUndefined();
        expect(nodes.pingingNodes.value.has('n')).toBe(false);
    });
});
