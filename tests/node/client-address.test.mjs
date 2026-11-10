import test from 'node:test';
import assert from 'node:assert/strict';
import { clientAddress } from '../../deploy/dmit/client-address.mjs';

const incoming = (peer, headers) => ({ socket: { remoteAddress: peer }, headers });
const trusted = { trustProxy: true, proxyAddresses: ['172.18.0.1'] };

test('proxy headers are ignored by default and from untrusted neighboring containers', () => {
    const headers = {
        'x-real-ip': '104.16.1.1',
        'cf-connecting-ip': '198.51.100.7',
        'x-forwarded-for': '192.0.2.1',
    };
    assert.equal(clientAddress(incoming('127.0.0.1', headers)), '127.0.0.1');
    assert.equal(clientAddress(incoming('172.18.0.9', headers), trusted), '172.18.0.9');
});

test('existing Nginx X-Real-IP is authoritative and Cloudflare visitor headers require a Cloudflare peer', () => {
    assert.equal(
        clientAddress(
            incoming('172.18.0.1', {
                'x-real-ip': '203.0.113.7',
                'cf-connecting-ip': '198.51.100.7',
            }),
            trusted
        ),
        '203.0.113.7'
    );
    assert.equal(
        clientAddress(
            incoming('172.18.0.1', {
                'x-real-ip': '104.16.1.1',
                'cf-connecting-ip': '198.51.100.7',
            }),
            trusted
        ),
        '198.51.100.7'
    );
    assert.equal(
        clientAddress(
            incoming('172.18.0.1', {
                'x-real-ip': '2606:4700::1',
                'cf-connecting-ip': '2001:db8::7',
            }),
            trusted
        ),
        '2001:db8::7'
    );
    assert.equal(
        clientAddress(
            incoming('172.18.0.1', {
                'x-real-ip': 'invalid, 104.16.1.1',
                'cf-connecting-ip': '198.51.100.7',
            }),
            trusted
        ),
        '172.18.0.1'
    );
});
