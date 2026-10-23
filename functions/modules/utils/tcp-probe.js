/** TCP connect timing only: no proxy authentication, TLS, or egress request. */
export async function probeTcpEndpoint(connect, endpoint, timeoutMs = 3000) {
    let socket;
    let timer;
    const start = performance.now();
    try {
        socket = connect(endpoint);
        // Closing an unsuccessful connection may reject closed as well as opened.
        socket.closed.catch(() => {});
        const opened = socket.opened.then(() => ({
            status: 'ok',
            latency: Math.round((performance.now() - start) * 10) / 10,
            code: 'probeOk',
        }));
        const deadline = new Promise((resolve) => {
            timer = setTimeout(
                () => resolve({ status: 'timeout', latency: -1, code: 'probeTimeout' }),
                timeoutMs
            );
        });
        return await Promise.race([opened, deadline]);
    } catch {
        return { status: 'error', latency: -1, code: 'probeFailed' };
    } finally {
        clearTimeout(timer);
        try {
            Promise.resolve(socket?.close()).catch(() => {});
        } catch {
            /* Already closed/refused. */
        }
    }
}
