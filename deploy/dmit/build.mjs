import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

await build({
    absWorkingDir: fileURLToPath(new URL('../../', import.meta.url)),
    entryPoints: ['functions/[[path]].js'],
    outfile: 'deploy/dmit/build/backend.mjs',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { 'cloudflare:sockets': fileURLToPath(new URL('./sockets.mjs', import.meta.url)) },
    logLevel: 'info',
});
