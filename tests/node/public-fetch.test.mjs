import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { Agent } from 'undici';
import { createPublicFetch } from '../../deploy/dmit/build/public-fetch.mjs';
import { fetchPublicNetworkUrl } from '../../functions/modules/public-network.js';

async function server(t, handler) {
    const app = http.createServer(handler);
    app.listen(0, '127.0.0.1');
    await once(app, 'listening');
    t.after(
        () =>
            new Promise((resolve) => {
                app.close(resolve);
                app.closeAllConnections();
            })
    );
    return app;
}

// A test-only connector routes an example public hostname to our own fixture server.
const loopbackAgent = (options) =>
    new Agent({
        ...options,
        connect: {
            ...options.connect,
            lookup(_host, options, callback) {
                if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
                else callback(null, '127.0.0.1', 4);
            },
        },
    });

test('native downloads reject private DNS answers before opening a socket', async (t) => {
    let hits = 0;
    const app = await server(t, (_request, response) => {
        hits++;
        response.end('private');
    });
    for (const addresses of [
        [{ address: '127.0.0.1', family: 4 }],
        [
            { address: '8.8.8.8', family: 4 },
            { address: '10.0.0.1', family: 4 },
        ],
        [{ address: '::ffff:127.0.0.1', family: 6 }],
    ]) {
        const download = createPublicFetch({ lookup: async () => addresses });
        await assert.rejects(download(`http://source.example:${app.address().port}/private`), {
            status: 400,
        });
    }
    assert.equal(hits, 0);
});

test('the validated DNS answer is supplied to the socket lookup without a second resolution', async () => {
    let resolutions = 0;
    let connectionOptions;
    const download = createPublicFetch({
        lookup: async () => {
            resolutions++;
            return resolutions === 1
                ? [{ address: '8.8.8.8', family: 4 }]
                : [{ address: '127.0.0.1', family: 4 }];
        },
        createAgent: (options) => {
            connectionOptions = options;
            return { destroy: async () => {} };
        },
        fetcher: async () => {
            const address = await new Promise((resolve, reject) =>
                connectionOptions.connect.lookup(
                    'source.example',
                    { all: true },
                    (error, addresses) => (error ? reject(error) : resolve(addresses))
                )
            );
            assert.deepEqual(address, [{ address: '8.8.8.8', family: 4 }]);
            return new Response('public');
        },
    });
    assert.equal(await (await download('https://source.example/')).text(), 'public');
    assert.equal(resolutions, 1);
});

test('public-to-private redirects are blocked and gzip downloads are decoded by Undici', async (t) => {
    let privateHits = 0;
    const compressed = gzipSync('template contents');
    const app = await server(t, (request, response) => {
        if (request.url === '/redirect')
            response
                .writeHead(302, { Location: `http://127.0.0.1:${app.address().port}/private` })
                .end();
        else if (request.url === '/private') {
            privateHits++;
            response.end('private');
        } else
            response
                .writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.length })
                .end(compressed);
    });
    const download = createPublicFetch({ createAgent: loopbackAgent });
    const url = `http://source.example:${app.address().port}`;
    await assert.rejects(fetchPublicNetworkUrl(url + '/redirect', {}, { fetcher: download }), {
        status: 400,
    });
    assert.equal(privateHits, 0);
    const response = await fetchPublicNetworkUrl(url + '/gzip', {}, { fetcher: download });
    assert.equal(await response.text(), 'template contents');
    assert.equal(response.headers.get('Content-Encoding'), null);
});

test('stalled upstream bodies are canceled within the complete download deadline', async (t) => {
    const app = await server(t, (_request, response) => {
        response.writeHead(200);
        response.write('partial');
    });
    const download = createPublicFetch({ createAgent: loopbackAgent });
    await assert.rejects(
        fetchPublicNetworkUrl(
            `http://source.example:${app.address().port}/`,
            {},
            { fetcher: download, timeoutMs: 40 }
        ),
        { status: 504 }
    );
});

test('compressed responses cannot exceed the decompressed size budget', async (t) => {
    const compressed = gzipSync(Buffer.alloc(8 * 1024 * 1024 + 1, 65));
    const app = await server(t, (_request, response) =>
        response
            .writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.length })
            .end(compressed)
    );
    const download = createPublicFetch({ createAgent: loopbackAgent });
    await assert.rejects(download(`http://source.example:${app.address().port}/`), { status: 413 });
});

test('download concurrency is bounded and slots are released after cancellation', async () => {
    let immediate = false;
    const download = createPublicFetch({
        createAgent: () => ({ destroy: async () => {} }),
        fetcher: async (_url, { signal }) =>
            immediate
                ? new Response('ok')
                : await new Promise((_, reject) =>
                      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
                  ),
    });
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const pending = controllers.map((controller) =>
        download('https://source.example/', { signal: controller.signal })
    );
    const settled = Promise.allSettled(pending);
    await assert.rejects(download('https://source.example/'), { status: 429 });
    controllers.forEach((controller) => controller.abort());
    await settled;
    immediate = true;
    assert.equal(await (await download('https://source.example/')).text(), 'ok');
});
