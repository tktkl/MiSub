// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPublicNetworkUrl } from '../../functions/modules/public-network.js';

afterEach(() => vi.unstubAllGlobals());
describe('bounded public downloads', () => {
    it('blocks private redirect targets before following them', async () => {
        const fetcher = vi.fn(
            async () =>
                new Response(null, {
                    status: 302,
                    headers: { Location: 'https://127.0.0.1/private' },
                })
        );
        await expect(
            fetchPublicNetworkUrl('https://source.example/template', {}, { fetcher })
        ).rejects.toMatchObject({ status: 400 });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('strips credentials when a redirect changes origins', async () => {
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 302,
                    headers: { Location: 'https://other.example/template' },
                })
            )
            .mockResolvedValueOnce(new Response('safe'));
        const response = await fetchPublicNetworkUrl(
            'https://source.example/template',
            {
                headers: {
                    Authorization: 'Bearer test',
                    Cookie: 'test=secret',
                    'X-API-Key': 'test',
                    'User-Agent': 'MiSub',
                },
            },
            { fetcher }
        );
        expect(await response.text()).toBe('safe');
        const request = fetcher.mock.calls[1][0];
        expect(request.headers.has('Authorization')).toBe(false);
        expect(request.headers.has('Cookie')).toBe(false);
        expect(request.headers.has('X-API-Key')).toBe(false);
        expect(request.headers.get('User-Agent')).toBe('MiSub');
    });

    it('caps redirects and rejects oversized declared responses', async () => {
        const fetcher = vi.fn(
            async () =>
                new Response(null, {
                    status: 302,
                    headers: { Location: 'https://source.example/again' },
                })
        );
        await expect(
            fetchPublicNetworkUrl('https://source.example/', {}, { fetcher })
        ).rejects.toThrow(/Too many redirects/);
        expect(fetcher).toHaveBeenCalledTimes(4);
        await expect(
            fetchPublicNetworkUrl(
                'https://source.example/',
                {},
                {
                    maxBytes: 4,
                    fetcher: async () =>
                        new Response('12345', { headers: { 'Content-Length': '5' } }),
                }
            )
        ).rejects.toMatchObject({ status: 413 });
    });

    it('enforces the body limit on streamed responses without Content-Length', async () => {
        const canceled = vi.fn();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(3));
                controller.enqueue(new Uint8Array(3));
            },
            cancel: canceled,
        });
        await expect(
            fetchPublicNetworkUrl(
                'https://source.example/',
                {},
                { maxBytes: 4, fetcher: async () => new Response(stream) }
            )
        ).rejects.toMatchObject({ status: 413 });
        expect(canceled).toHaveBeenCalled();
    });

    it('aborts a stalled body rather than only timing the response headers', async () => {
        const canceled = vi.fn();
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(1));
            },
            cancel: canceled,
        });
        await expect(
            fetchPublicNetworkUrl(
                'https://source.example/',
                {},
                { timeoutMs: 15, fetcher: async () => new Response(stream) }
            )
        ).rejects.toMatchObject({ status: 504 });
        expect(canceled).toHaveBeenCalled();
    });
});
