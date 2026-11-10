import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml',
    '.webmanifest': 'application/manifest+json',
};

export async function createAssets(directory) {
    const root = await realpath(directory);
    const inside = (file) => file.startsWith(root + path.sep);
    async function find(file) {
        try {
            const resolved = await realpath(file);
            if (!inside(resolved)) return null;
            const info = await stat(resolved);
            return info.isFile() ? { file: resolved, size: info.size } : null;
        } catch (error) {
            if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
            throw error;
        }
    }
    if (!(await find(path.join(root, 'index.html'))))
        throw new Error('Frontend build is missing index.html');
    return {
        async fetch(request) {
            if (!['GET', 'HEAD'].includes(request.method)) {
                return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
            }
            let pathname;
            try {
                pathname = decodeURIComponent(new URL(request.url).pathname);
            } catch {
                return new Response(null, { status: 400 });
            }
            if (pathname.includes('\0') || pathname.includes('\\'))
                return new Response(null, { status: 400 });
            const file = path.resolve(root, '.' + pathname);
            if (file !== root && !inside(file)) return new Response(null, { status: 404 });
            let asset = await find(file === root ? path.join(root, 'index.html') : file);
            if (!asset && !path.extname(pathname) && !pathname.startsWith('/assets/')) {
                asset = await find(path.join(root, 'index.html'));
            }
            if (!asset) return new Response(null, { status: 404 });
            return new Response(
                request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(asset.file)),
                {
                    headers: {
                        'Content-Type':
                            MIME[path.extname(asset.file)] || 'application/octet-stream',
                        'Content-Length': String(asset.size),
                        'Cache-Control':
                            path.extname(asset.file) === '.html'
                                ? 'no-store'
                                : 'public, max-age=3600',
                        'X-Content-Type-Options': 'nosniff',
                    },
                }
            );
        },
    };
}
