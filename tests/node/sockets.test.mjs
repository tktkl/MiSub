import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { connect } from '../../deploy/dmit/sockets.mjs';
import { probeTcpEndpoint } from '../../functions/modules/utils/tcp-probe.js';

test('native probe opens and closes a real TCP socket and rejects refused connections', async () => {
    const server = createServer((socket) => socket.on('error', () => {}));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const endpoint = { hostname: '127.0.0.1', port: server.address().port };
    try {
        const result = await probeTcpEndpoint(connect, endpoint);
        assert.equal(result.status, 'ok');
        assert.ok(result.latency >= 0);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
    assert.equal((await probeTcpEndpoint(connect, endpoint)).status, 'error');
});
