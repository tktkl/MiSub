import { describe, expect, it, vi } from 'vitest';
import { handleApiRequest } from '../../functions/modules/api-router.js';

function createKv() {
    return {
        get: vi.fn(async () => {
            return null;
        }),
        put: vi.fn(),
        delete: vi.fn(),
    };
}

describe.each(['/migrate_to_d1', '/migrate_legacy_d1', '/migrate', '/cron/trigger'])(
    'POST-only management operation %s',
    (route) => {
        it.each(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE'])(
            'rejects %s before storage or authentication side effects',
            async (method) => {
                const kv = createKv();
                const response = await handleApiRequest(
                    new Request(`https://example.com/api${route}`, { method }),
                    { MISUB_KV: kv, COOKIE_SECRET: 'test-secret' }
                );
                expect(response.status).toBe(405);
                expect(response.headers.get('Allow')).toBe('POST');
                expect(kv.get).not.toHaveBeenCalled();
                expect(kv.put).not.toHaveBeenCalled();
                expect(kv.delete).not.toHaveBeenCalled();
            }
        );

        it('keeps POST protected by admin authentication', async () => {
            const response = await handleApiRequest(
                new Request(`https://example.com/api${route}`, { method: 'POST' }),
                { MISUB_KV: createKv(), COOKIE_SECRET: 'test-secret' }
            );
            expect(response.status).toBe(401);
        });
    }
);
