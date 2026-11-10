import { describe, expect, it } from 'vitest';
import {
    applyRequestTransforms,
    parseRequestTransforms,
} from '../../functions/modules/subscription/request-transforms.js';
import { generateCacheKey } from '../../functions/services/node-cache-service.js';

const node = (name) => `trojan://test-password@192.0.2.1:443#${encodeURIComponent(name)}`;
const apply = (names, params) =>
    applyRequestTransforms(
        names.map(node).join('\n'),
        parseRequestTransforms(new URLSearchParams(params))
    );

describe('untrusted subscription transformation parameters', () => {
    it('treats nested regex quantifiers literally and preserves connections', () => {
        const name = 'Review Long Node Name With Enough Characters';
        expect(apply([name], { rename: '^(.+)+Z$@x' })).toContain(node(name));
        expect(apply(['literal (a+)+$'], { rename: '(a+)+$@$&' })).toContain(node('literal $&'));
    });

    it('applies literal filters and bounded replacements independently for each download', () => {
        const result = apply(['HK-A', 'JP-B', 'US-C'], {
            include: 'hk|jp',
            exclude: 'JP',
            rename: 'HK@Hong Kong',
        });
        expect(result.trim()).toBe(node('Hong Kong-A'));
        expect(apply(['HK-A'], { exclude: 'HK' })).toBe('');
    });

    it('rejects oversized parameters and too many rules', () => {
        expect(() =>
            parseRequestTransforms(new URLSearchParams({ rename: 'x'.repeat(1025) }))
        ).toThrow(/too long/);
        expect(() =>
            parseRequestTransforms(new URLSearchParams({ rename: Array(17).fill('a@b').join('|') }))
        ).toThrow(/Too many/);
    });

    it('caps expanded names and does not change the no-override output', () => {
        const output = apply(['A'.repeat(200)], { rename: 'A@' + 'B'.repeat(500) });
        expect(decodeURIComponent(output.trim().split('#')[1])).toHaveLength(1024);
        expect(
            applyRequestTransforms(
                'exact original output',
                parseRequestTransforms(new URLSearchParams())
            )
        ).toBe('exact original output');
    });

    it('ignores aggregate cache keys previously written by request overrides', () => {
        expect(generateCacheKey('profile', 'shared')).not.toBe('node_cache_profile_shared');
        expect(generateCacheKey('subscription', 'source')).toBe('node_cache_subscription_source');
    });
});
