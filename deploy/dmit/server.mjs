import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createAssets } from './assets.mjs';

const MAX_BODY_BYTES = 20 * 1024 * 1024;

// Cancelling a Fetch body must drain the upload, not destroy the HTTP response socket.
function requestBody(incoming) {
    let cleanup;
    return new ReadableStream({
        start(controller) {
            let bytes = 0;
            const data = (chunk) => {
                bytes += chunk.length;
                if (bytes > MAX_BODY_BYTES) {
                    const error = Object.assign(new Error('Request body too large'), {
                        status: 413,
                    });
                    cleanup();
                    controller.error(error);
                    incoming.resume();
                    return;
                }
                controller.enqueue(chunk);
                if (controller.desiredSize <= 0) incoming.pause();
            };
            const end = () => {
                cleanup();
                controller.close();
            };
            const error = (err) => {
                cleanup();
                controller.error(err);
            };
            cleanup = () => {
                incoming.off('data', data);
                incoming.off('end', end);
                incoming.off('error', error);
            };
            incoming.on('data', data).once('end', end).once('error', error);
            incoming.pause();
        },
        pull() {
            incoming.resume();
        },
        cancel() {
            cleanup();
            incoming.resume();
        },
    });
}

export async function createNativeServer({ onRequest, env, publicUrl, assetsDirectory }) {
    const origin = new URL(publicUrl);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
        throw new Error('MISUB_PUBLIC_URL must be an HTTP(S) URL without credentials');
    }
    const bindings = { ...env, ASSETS: await createAssets(assetsDirectory) };
    const pending = new Set();
    const server = http.createServer(async (incoming, outgoing) => {
        incoming.on('error', () => {});
        let input;
        try {
            input = new URL(incoming.url, 'http://localhost');
        } catch {
            incoming.resume();
            outgoing.writeHead(400).end();
            return;
        }
        const pathname = input.pathname;
        if (pathname === '/healthz') {
            incoming.resume();
            outgoing
                .writeHead(['GET', 'HEAD'].includes(incoming.method) ? 204 : 405, {
                    'Cache-Control': 'no-store',
                    Allow: 'GET, HEAD',
                })
                .end();
            return;
        }
        if (Number(incoming.headers['content-length']) > MAX_BODY_BYTES) {
            incoming.resume();
            outgoing
                .writeHead(413, { 'Content-Type': 'text/plain', Connection: 'close' })
                .end('Request body too large');
            return;
        }
        const abort = new AbortController();
        outgoing.once('close', () => {
            if (!outgoing.writableFinished) abort.abort();
        });
        let request;
        try {
            // Use the configured external origin for secure cookies and CSRF, not a client-supplied Host.
            const url = new URL(origin);
            url.pathname = input.pathname;
            url.search = input.search;
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) {
                if (value !== undefined)
                    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
            }
            request = new Request(url, {
                method: incoming.method,
                headers,
                signal: abort.signal,
                ...(['GET', 'HEAD'].includes(incoming.method)
                    ? {}
                    : { body: requestBody(incoming), duplex: 'half' }),
            });
            const response = await onRequest({
                request,
                env: bindings,
                waitUntil(promise) {
                    const task = Promise.resolve(promise)
                        .catch((error) => console.error('[Background task]', error))
                        .finally(() => pending.delete(task));
                    pending.add(task);
                },
            });
            outgoing.statusCode = response.status;
            for (const [name, value] of response.headers) {
                if (name !== 'set-cookie') outgoing.setHeader(name, value);
            }
            const cookies = response.headers.getSetCookie();
            if (cookies.length) outgoing.setHeader('Set-Cookie', cookies);
            if (incoming.method === 'HEAD' || !response.body) {
                await response.body?.cancel();
                outgoing.end();
            } else await pipeline(Readable.fromWeb(response.body), outgoing);
        } catch (error) {
            if (!abort.signal.aborted) console.error('[HTTP request]', error);
            if (!outgoing.headersSent && !outgoing.destroyed) {
                outgoing
                    .writeHead(error.status || 500, { 'Content-Type': 'text/plain' })
                    .end('Request failed');
            } else outgoing.destroy();
        } finally {
            if (request?.body && !request.bodyUsed) await request.body.cancel().catch(() => {});
            incoming.resume();
        }
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    return {
        server,
        async close() {
            await new Promise((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            );
            while (pending.size) await Promise.allSettled([...pending]);
        },
    };
}
