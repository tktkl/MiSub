import { lookup as resolve } from 'node:dns/promises';
import { Agent, fetch as fetchUndici } from 'undici';
import {
    isPublicIpAddress,
    validatePublicNetworkUrl,
} from '../../functions/modules/security-utils.js';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ACTIVE = 4;

export function createPublicFetch({
    lookup = resolve,
    createAgent = (options) => new Agent(options),
    fetcher = fetchUndici,
} = {}) {
    let active = 0;
    return async (input, init = {}) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const validation = validatePublicNetworkUrl(url.toString());
        if (!validation.ok) throw Object.assign(new Error(validation.error), { status: 400 });
        if (active >= MAX_ACTIVE)
            throw Object.assign(new Error('Public fetch concurrency limit reached'), {
                status: 429,
            });
        const method = init.method || (input instanceof Request ? input.method : 'GET');
        if (!['GET', 'HEAD'].includes(method))
            throw new Error('Public downloads require GET or HEAD');
        active++;
        let agent;
        let reader;
        try {
            const safeLookup = async (hostname, options, callback) => {
                try {
                    const addresses = await lookup(hostname, { all: true, verbatim: true });
                    if (
                        !addresses.length ||
                        addresses.some(({ address }) => !isPublicIpAddress(address))
                    )
                        throw new Error('Destination resolves to a non-public address');
                    const chosen = addresses.find(({ family }) => family === 4) || addresses[0];
                    if (options.all) callback(null, [chosen]);
                    else callback(null, chosen.address, chosen.family);
                } catch (error) {
                    callback(Object.assign(error, { status: 400 }));
                }
            };
            agent = createAgent({
                connect: { lookup: safeLookup, timeout: 5000 },
                connections: 1,
                pipelining: 1,
                maxResponseSize: MAX_BYTES,
                headersTimeout: 10_000,
                bodyTimeout: 10_000,
            });
            const sourceSignal =
                init.signal || (input instanceof Request ? input.signal : undefined);
            const signal = AbortSignal.any([
                AbortSignal.timeout(10_000),
                ...(sourceSignal ? [sourceSignal] : []),
            ]);
            const headers = new Headers(
                init.headers || (input instanceof Request ? input.headers : undefined)
            );
            headers.delete('Host');
            const response = await fetcher(url.toString(), {
                ...init,
                method,
                headers: Object.fromEntries(headers),
                signal,
                redirect: 'manual',
                dispatcher: agent,
            });
            const resultHeaders = new Headers(response.headers);
            if (
                [204, 205, 304, 301, 302, 303, 307, 308].includes(response.status) ||
                method === 'HEAD'
            ) {
                await response.body?.cancel();
                return new Response(null, { status: response.status, headers: resultHeaders });
            }
            if (Number(resultHeaders.get('Content-Length')) > MAX_BYTES)
                throw Object.assign(new Error('Public response body too large'), { status: 413 });
            reader = response.body?.getReader();
            const chunks = [];
            let size = 0;
            while (reader) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_BYTES)
                    throw Object.assign(new Error('Public response body too large'), {
                        status: 413,
                    });
                chunks.push(value);
            }
            reader?.releaseLock();
            reader = null;
            resultHeaders.delete('Content-Encoding');
            resultHeaders.delete('Transfer-Encoding');
            resultHeaders.set('Content-Length', String(size));
            return new Response(Buffer.concat(chunks, size), {
                status: response.status,
                headers: resultHeaders,
            });
        } catch (error) {
            if (error.cause?.status) error.status = error.cause.status;
            else if (error.cause?.code === 'UND_ERR_RES_EXCEEDED_MAX_SIZE') error.status = 413;
            else if (error.name === 'TimeoutError') error.status = 504;
            throw error;
        } finally {
            try {
                await reader?.cancel().catch(() => {});
                await agent?.destroy();
            } finally {
                active--;
            }
        }
    };
}
