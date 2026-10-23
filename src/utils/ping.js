import { t } from '@/i18n/index.js';
import { api } from '../lib/http.js';

/** Measure the saved endpoint from MiSub, never with a browser HTTPS request. */
export async function pingNode(id, url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const result = await api.post(
            '/api/nodes/probe',
            { id, url },
            { signal: controller.signal }
        );
        const codes = [
            'probeSavedRequired',
            'probeUnsupported',
            'probeInvalid',
            'probeFailed',
            'probeTimeout',
            'probeBusy',
            'probeOk',
        ];
        if (
            !result ||
            !['ok', 'timeout', 'error'].includes(result.status) ||
            !codes.includes(result.code) ||
            (result.status === 'ok' &&
                (result.code !== 'probeOk' ||
                    !Number.isFinite(result.latency) ||
                    result.latency < 0))
        ) {
            throw new Error('Invalid probe response');
        }
        return { ...result, message: t(`manualNodes.${result.code}`) };
    } catch (error) {
        // API, authentication and transport errors are failures, never a measured RTT.
        return {
            status: 'error',
            latency: -1,
            message: error?.name === 'APIError' ? error.message : t('manualNodes.probeFailed'),
        };
    } finally {
        clearTimeout(timer);
    }
}
