import { validatePublicNetworkUrl } from './security-utils.js';

export const PUBLIC_FETCH_MAX_BYTES = 8 * 1024 * 1024;
export const PUBLIC_FETCH_TIMEOUT_MS = 10_000;

function failure(message, status = 400) {
    return Object.assign(new Error(message), { status });
}

export async function fetchPublicNetworkUrl(input, init = {}, options = {}) {
    const timeoutMs = options.timeoutMs ?? PUBLIC_FETCH_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? PUBLIC_FETCH_MAX_BYTES;
    const controller = new AbortController();
    let reader;
    let rejectDeadline;
    const deadline = new Promise((_, reject) => {
        rejectDeadline = reject;
    });
    const abort = () => {
        const error = init.signal?.reason || failure('Public fetch aborted', 504);
        controller.abort(error);
        reader?.cancel(error).catch(() => {});
        rejectDeadline(error);
    };
    const timer = setTimeout(() => {
        const error = failure('Public fetch timed out', 504);
        controller.abort(error);
        reader?.cancel(error).catch(() => {});
        rejectDeadline(error);
    }, timeoutMs);
    init.signal?.addEventListener('abort', abort, { once: true });
    if (init.signal?.aborted) abort();

    const operation = async () => {
        let current = String(input);
        let headers = new Headers(init.headers);
        const fetcher = options.fetcher || globalThis.fetch;
        for (let redirects = 0; redirects <= 3; redirects++) {
            const validation = validatePublicNetworkUrl(current);
            if (!validation.ok) throw failure(validation.error);
            const { cf, ...requestInit } = init;
            const request = new Request(current, {
                ...requestInit,
                headers,
                redirect: 'manual',
                signal: controller.signal,
            });
            const response = cf ? await fetcher(request, { cf }) : await fetcher(request);
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers.get('Location');
                await response.body?.cancel();
                if (!location) throw failure('Redirect has no destination');
                if (redirects === 3) throw failure('Too many redirects');
                const next = new URL(location, current);
                if (new URL(current).protocol === 'https:' && next.protocol !== 'https:')
                    throw failure('HTTPS downgrade is not allowed');
                if (next.origin !== new URL(current).origin) {
                    headers = new Headers(
                        [...headers].filter(([key]) =>
                            ['accept', 'accept-language', 'user-agent'].includes(key.toLowerCase())
                        )
                    );
                }
                current = next.toString();
                continue;
            }
            if (Number(response.headers.get('Content-Length')) > maxBytes) {
                await response.body?.cancel();
                throw failure('Public response body too large', 413);
            }
            if (!response.body) return response;
            reader = response.body.getReader();
            const chunks = [];
            let size = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > maxBytes) {
                    await reader.cancel();
                    throw failure('Public response body too large', 413);
                }
                chunks.push(value);
            }
            reader.releaseLock();
            reader = null;
            const body = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
                body.set(chunk, offset);
                offset += chunk.byteLength;
            }
            const resultHeaders = new Headers(response.headers);
            resultHeaders.delete('Content-Encoding');
            resultHeaders.delete('Transfer-Encoding');
            resultHeaders.set('Content-Length', String(size));
            const result = new Response([204, 205, 304].includes(response.status) ? null : body, {
                status: response.status,
                statusText: response.statusText,
                headers: resultHeaders,
            });
            Object.defineProperty(result, 'url', { value: response.url || current });
            return result;
        }
        throw failure('Too many redirects');
    };
    try {
        return await Promise.race([operation(), deadline]);
    } finally {
        clearTimeout(timer);
        init.signal?.removeEventListener('abort', abort);
    }
}
