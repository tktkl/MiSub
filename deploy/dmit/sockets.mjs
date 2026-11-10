import { createConnection } from 'node:net';

// The probe needs connection timing only; no protocol or payload emulation.
export function connect({ hostname, port }) {
    const socket = createConnection({ host: hostname, port });
    let resolveOpened, rejectOpened, resolveClosed;
    let connected = false;
    const opened = new Promise((resolve, reject) => {
        resolveOpened = resolve;
        rejectOpened = reject;
    });
    const closed = new Promise((resolve) => {
        resolveClosed = resolve;
    });
    socket.once('connect', () => {
        connected = true;
        resolveOpened();
    });
    socket.on('error', rejectOpened);
    socket.once('close', () => {
        if (!connected) rejectOpened(new Error('Connection closed before opening'));
        resolveClosed();
    });
    return {
        opened,
        closed,
        close() {
            socket.destroy();
            return closed;
        },
    };
}
