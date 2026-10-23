import { StorageFactory } from '../../storage-adapter.js';
import {
    createJsonResponse,
    createErrorResponse,
    readJsonWithLimit,
    JSON_BODY_LIMITS,
} from '../utils.js';
import { parseNodeInfo } from '../utils/geo-utils.js';
import { isLocalProxyEndpoint } from '../../utils/node-utils.js';
import { connect } from 'cloudflare:sockets';
import { probeTcpEndpoint } from '../utils/tcp-probe.js';

const TCP_PROTOCOLS = new Set([
    'ss',
    'ssr',
    'vless',
    'vmess',
    'trojan',
    'socks',
    'socks5',
    'snell',
    'anytls',
    'naive+http',
    'naive+https',
]);
let activeProbes = 0;
const failure = (code) => createJsonResponse({ status: 'error', latency: -1, code });

// Called only after the API router's admin authentication and CSRF checks.
export async function handleNodeProbeRequest(request, env) {
    if (request.method !== 'POST') return createErrorResponse('Method Not Allowed', 405);
    const body = await readJsonWithLimit(request, JSON_BODY_LIMITS.normal);
    if (typeof body?.id !== 'string' || !body.id || typeof body.url !== 'string') {
        return createErrorResponse('Node id and current URL required', 400);
    }
    const storage = StorageFactory.createAdapter(env, await StorageFactory.getStorageType(env));
    const node = await storage.getSubscriptionById(body.id);
    // Never accept a free-form destination from the request. Detect unsaved edits too.
    if (!node || node.url !== body.url) return failure('probeSavedRequired');
    const { protocol, server, port } = parseNodeInfo(node.url);
    if (!TCP_PROTOCOLS.has(protocol)) return failure('probeUnsupported');
    const hostname = String(server || '').replace(/^\[|\]$/g, '');
    const portNumber = Number(port);
    if (
        !hostname ||
        !/^\d+$/.test(String(port)) ||
        !Number.isInteger(portNumber) ||
        portNumber < 1 ||
        portNumber > 65535 ||
        isLocalProxyEndpoint({ server: hostname })
    ) {
        return failure('probeInvalid');
    }
    if (activeProbes >= 10) return failure('probeBusy');
    activeProbes++;
    try {
        return createJsonResponse(await probeTcpEndpoint(connect, { hostname, port: portNumber }));
    } finally {
        activeProbes--;
    }
}
