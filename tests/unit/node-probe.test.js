import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeTcpEndpoint } from '../../functions/modules/utils/tcp-probe.js';
import { handleNodeProbeRequest } from '../../functions/modules/handlers/node-probe-handler.js';
import { StorageFactory } from '../../functions/storage-adapter.js';

vi.mock('cloudflare:sockets', () => ({ connect: vi.fn() }));
import { connect } from 'cloudflare:sockets';

const endpoint = { hostname: 'example.com', port: 443 };
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function socket(opened) {
    return { opened, closed: Promise.resolve(), close: vi.fn(() => Promise.resolve()) };
}

describe('TCP timing', () => {
    it('measures only successful opens and always closes the socket', async () => {
        const connection = socket(Promise.resolve());
        const connect = vi.fn(() => connection);
        const result = await probeTcpEndpoint(connect, endpoint);
        expect(connect).toHaveBeenCalledWith(endpoint);
        expect(result.status).toBe('ok');
        expect(result.latency).toBeGreaterThanOrEqual(0);
        expect(connection.close).toHaveBeenCalledOnce();
    });
    it('never treats refused connections or connector errors as success', async () => {
        const connection = socket(Promise.reject(new Error('refused')));
        expect(await probeTcpEndpoint(() => connection, endpoint)).toMatchObject({
            status: 'error',
            latency: -1,
        });
        expect(connection.close).toHaveBeenCalledOnce();
        expect(
            await probeTcpEndpoint(() => {
                throw new Error('invalid');
            }, endpoint)
        ).toMatchObject({ status: 'error' });
    });
    it('bounds the wait and closes pending connections even if close never resolves', async () => {
        vi.useFakeTimers();
        const connection = socket(new Promise(() => {}));
        connection.close.mockReturnValue(new Promise(() => {}));
        const probe = probeTcpEndpoint(() => connection, endpoint, 3000);
        await vi.advanceTimersByTimeAsync(3000);
        expect(await probe).toMatchObject({ status: 'timeout', latency: -1 });
        expect(connection.close).toHaveBeenCalledOnce();
    });
});

describe('saved node probe restrictions', () => {
    const call = (data, node) => {
        vi.spyOn(StorageFactory, 'getStorageType').mockResolvedValue('KV');
        vi.spyOn(StorageFactory, 'createAdapter').mockReturnValue({
            getSubscriptionById: vi.fn(async () => node),
        });
        return handleNodeProbeRequest(
            new Request('https://example.com/api/nodes/probe', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(data),
            }),
            {}
        );
    };
    it.each([
        'ss://YWVzLTEyOC1nY206cGFzcw@example.com:443#SS',
        `ss://${btoa('aes-128-gcm:pass@example.com:443')}#SS`,
        'vless://id@example.com:443?security=reality#VLESS',
    ])('probes parsed SS/VLESS endpoint %s', async (url) => {
        connect.mockReturnValue(socket(Promise.resolve()));
        const response = await call({ id: 'n', url }, { url });
        expect(await response.json()).toMatchObject({ status: 'ok', code: 'probeOk' });
        expect(connect).toHaveBeenCalledWith(endpoint);
    });
    it('requires a saved id and exact URL, ignoring arbitrary host and port', async () => {
        const response = await call(
            { id: 'missing', url: 'ss://new', host: 'example.com', port: 443 },
            undefined
        );
        expect(await response.json()).toMatchObject({
            status: 'error',
            code: 'probeSavedRequired',
        });
    });
    it('refuses stale URLs instead of measuring the old destination', async () => {
        const response = await call(
            { id: 'n', url: 'vless://id@new.example:443' },
            { url: 'vless://id@old.example:443' }
        );
        expect(await response.json()).toMatchObject({ code: 'probeSavedRequired' });
    });
    it.each([
        'hy2://pass@example.com:443',
        'tuic://id:pass@example.com:443',
        'ss://abc@127.0.0.1:443',
        'vless://id@example.com:99999',
    ])('does not probe invalid or non-TCP endpoint %s', async (url) => {
        const response = await call({ id: 'n', url }, { url });
        expect((await response.json()).status).toBe('error');
    });
});
