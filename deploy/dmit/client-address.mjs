import { BlockList, isIP } from 'node:net';
import { readFile } from 'node:fs/promises';

// https://www.cloudflare.com/ips-v4 and /ips-v6, checked 2026-11-10.
const CLOUDFLARE_NETWORKS = [
    '173.245.48.0/20',
    '103.21.244.0/22',
    '103.22.200.0/22',
    '103.31.4.0/22',
    '141.101.64.0/18',
    '108.162.192.0/18',
    '190.93.240.0/20',
    '188.114.96.0/20',
    '197.234.240.0/22',
    '198.41.128.0/17',
    '162.158.0.0/15',
    '104.16.0.0/13',
    '104.24.0.0/14',
    '172.64.0.0/13',
    '131.0.72.0/22',
    '2400:cb00::/32',
    '2606:4700::/32',
    '2803:f800::/32',
    '2405:b500::/32',
    '2405:8100::/32',
    '2a06:98c0::/29',
    '2c0f:f248::/32',
];
const cloudflare = new BlockList();
for (const cidr of CLOUDFLARE_NETWORKS) {
    const [address, prefix] = cidr.split('/');
    cloudflare.addSubnet(address, Number(prefix), isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

function normalize(address = '') {
    return address.startsWith('::ffff:') && isIP(address.slice(7)) === 4
        ? address.slice(7)
        : address;
}

export async function localProxyAddresses() {
    const addresses = ['127.0.0.1', '::1'];
    try {
        // Docker's host-side proxy connects through the default gateway, not arbitrary sibling containers.
        const routes = (await readFile('/proc/net/route', 'utf8')).trim().split('\n').slice(1);
        for (const line of routes) {
            const fields = line.trim().split(/\s+/);
            if (fields[1] === '00000000' && /^[0-9A-F]{8}$/i.test(fields[2])) {
                const gateway = fields[2]
                    .match(/../g)
                    .reverse()
                    .map((hex) => parseInt(hex, 16))
                    .join('.');
                if (gateway !== '0.0.0.0') addresses.push(gateway);
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    return addresses;
}

export function clientAddress(
    incoming,
    { trustProxy = false, proxyAddresses = ['127.0.0.1', '::1'] } = {}
) {
    const peer = normalize(incoming.socket.remoteAddress || '');
    if (!trustProxy || !proxyAddresses.some((address) => normalize(address) === peer))
        return peer || 'unknown';
    // Existing Nginx overwrites X-Real-IP with $remote_addr. Never trust the first X-Forwarded-For item.
    const proxyClient = incoming.headers['x-real-ip'];
    if (typeof proxyClient !== 'string' || !isIP(proxyClient)) return peer || 'unknown';
    const visitor = incoming.headers['cf-connecting-ip'];
    if (
        cloudflare.check(proxyClient, isIP(proxyClient) === 6 ? 'ipv6' : 'ipv4') &&
        typeof visitor === 'string' &&
        isIP(visitor)
    )
        return normalize(visitor);
    return normalize(proxyClient);
}
