import { get } from 'node:http';

const request = get(
    { host: '127.0.0.1', port: Number(process.env.PORT || 8787), path: '/healthz' },
    (response) => {
        response.resume();
        response.once('end', () => process.exit(response.statusCode === 204 ? 0 : 1));
    }
);
request.setTimeout(3000, () => request.destroy(new Error('Health check timed out')));
request.once('error', () => process.exit(1));
