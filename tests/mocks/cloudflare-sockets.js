// Workerd-only module; unit tests must supply a connection double.
export function connect() {
    throw new Error('Mock cloudflare:sockets.connect in unit tests');
}
