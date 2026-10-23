import { afterEach, describe, expect, it, vi } from 'vitest';
import { pingNode } from '../../src/utils/ping.js';
import { api } from '../../src/lib/http.js';
vi.mock('../../src/lib/http.js', () => ({ api: { post: vi.fn() } }));
afterEach(() => {
    vi.resetAllMocks();
});
describe('probe client', () => {
    it('calls authenticated saved-node API and uses its measured time', async () => {
        api.post.mockResolvedValue({ status: 'ok', code: 'probeOk', latency: 0.4 });
        const result = await pingNode('n1', 'vless://saved');
        expect(api.post).toHaveBeenCalledWith(
            '/api/nodes/probe',
            { id: 'n1', url: 'vless://saved' },
            expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
        expect(result).toMatchObject({ status: 'ok', latency: 0.4 });
    });
    it.each([new TypeError('fetch failed'), { name: 'APIError', message: 'Unauthorized' }])(
        'does not count transport or auth errors as successes',
        async (error) => {
            api.post.mockRejectedValue(error);
            expect(await pingNode('n', 'ss://saved')).toMatchObject({
                status: 'error',
                latency: -1,
            });
        }
    );
    it.each([
        null,
        {},
        { status: 'ok', code: 'probeOk', latency: -1 },
        { status: 'ok', code: 'probeFailed', latency: 20 },
    ])('rejects invalid successful measurements', async (response) => {
        api.post.mockResolvedValue(response);
        expect((await pingNode('n', 'ss://saved')).status).toBe('error');
    });
});
