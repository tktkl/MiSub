import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createI18n } from '../../src/i18n/index.js';
import SystemSettings from '../../src/components/settings/sections/SystemSettings.vue';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/stores/toast.js', () => ({ useToastStore: () => ({ showToast }) }));

const mountSettings = () =>
    mount(SystemSettings, {
        props: { settings: { storageType: 'kv', customLoginPath: 'unsaved-login' } },
        global: { plugins: [createI18n({ initialLocale: 'en-US' })], stubs: { Switch: true } },
    });
const button = (wrapper, text) =>
    wrapper.findAll('button').find((item) => item.text().includes(text));

beforeEach(() => {
    window.history.replaceState(null, '', '/dashboard/settings?focus=security#password');
    sessionStorage.setItem('misub:login-path', '/outdated-login');
    vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    success: true,
                    reauthenticate: true,
                    loginPath: '/saved-login',
                })
            )
        )
    );
    vi.spyOn(window.location, 'replace').mockImplementation(() => {});
    showToast.mockClear();
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    sessionStorage.clear();
});

describe('administrator reauthentication navigation', () => {
    it('opens the saved login route after revocation rather than reloading the protected route', async () => {
        const wrapper = mountSettings();
        await button(wrapper, 'Sign out all devices').trigger('click');
        await flushPromises();
        expect(fetch).toHaveBeenCalledWith('/api/settings/sessions/revoke', { method: 'POST' });
        expect(window.location.replace).toHaveBeenCalledWith(
            `${window.location.origin}/saved-login`
        );
        expect(sessionStorage.getItem('misub:login-path')).toBe('/saved-login');
        wrapper.unmount();
    });

    it('opens the saved login route after changing the password', async () => {
        const wrapper = mountSettings();
        for (const input of wrapper.findAll('input[type="password"]'))
            await input.setValue('new-password');
        await button(wrapper, 'Change admin password').trigger('click');
        await flushPromises();
        expect(window.location.replace).toHaveBeenCalledWith(
            `${window.location.origin}/saved-login`
        );
        wrapper.unmount();
    });

    it('keeps the page available if revocation fails', async () => {
        fetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ error: 'Try again' }), { status: 503 })
        );
        const wrapper = mountSettings();
        await button(wrapper, 'Sign out all devices').trigger('click');
        await flushPromises();
        expect(window.location.replace).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith('Try again', 'error');
        expect(button(wrapper, 'Sign out all devices').attributes('disabled')).toBeUndefined();
        wrapper.unmount();
    });
});
