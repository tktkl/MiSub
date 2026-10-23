import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import NodeCard from '../../src/components/modals/NodePreview/components/NodeCard.vue';

describe('preview flag display', () => {
    it('renders recognized and default flags beside region metadata without changing headings or copied URLs', async () => {
        const nodes = [
            {
                name: 'CN-ATRUST',
                region: '中国',
                protocol: 'socks5',
                server: 'example.com',
                port: 443,
                url: 'socks5://user:pass@example.com:443#CN-ATRUST',
            },
            {
                name: 'OFFICE',
                region: '其他',
                protocol: 'ss',
                server: 'example.com',
                port: 443,
                url: 'ss://auth@example.com:443#OFFICE',
            },
            {
                name: 'US-DMIT',
                region: '美国',
                protocol: 'vless',
                server: 'example.com',
                port: 443,
                url: 'vless://id@example.com:443#US-DMIT',
            },
        ];
        const wrapper = mount(NodeCard, {
            props: { nodes, parseNodeInfo: (n) => n, getProtocolStyle: () => '' },
        });
        expect(wrapper.findAll('h4').map((heading) => heading.text())).toEqual(
            [...nodes, ...nodes].map((node) => node.name)
        );
        expect(wrapper.findAll('span[aria-hidden="true"]').map((icon) => icon.text())).toEqual([
            '🇨🇳',
            '🇨🇳',
            '🇺🇸',
        ]);
        await wrapper.findAll('button').at(-1).trigger('click');
        expect(wrapper.emitted('copy')[0][0].url).toBe(nodes[2].url);
        wrapper.unmount();
    });
});
