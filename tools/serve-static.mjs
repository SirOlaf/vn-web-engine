import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const defaultRoot = fileURLToPath(new URL('../site/', import.meta.url));
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serve only the production artifact, optionally beneath a GitHub Pages-style prefix. */
export async function createStaticServer({root = defaultRoot, base = '/'} = {}) {
  const directory = await realpath(root);
  if (!/^\/(?:[^?#\\\0]+\/)?$/.test(base) || base.split('/').includes('..'))
    throw new Error('The static base must begin and end with / and contain no traversal');
  return createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, {Allow: 'GET, HEAD'}).end();
        return;
      }
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (base !== '/' && pathname === base.slice(0, -1)) {
        res.writeHead(308, {Location: base}).end();
        return;
      }
      if (!pathname.startsWith(base) || pathname.includes('\0') || pathname.includes('\\')) {
        res.writeHead(404).end();
        return;
      }
      const relative = pathname.slice(base.length) || 'index.html';
      const candidate = path.resolve(directory, relative);
      if (!candidate.startsWith(directory + path.sep)) {
        res.writeHead(404).end();
        return;
      }
      const file = await realpath(candidate);
      if (!file.startsWith(directory + path.sep)) {
        res.writeHead(404).end();
        return;
      }
      const details = await stat(file);
      if (!details.isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream',
        'Content-Length': details.size,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD' || !details.size) {
        res.end();
        return;
      }
      const stream = createReadStream(file);
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500);
      res.end('Request failed');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 8000);
  const base = process.env.STATIC_BASE ?? '/';
  try {
    const server = await createStaticServer({base});
    server.listen(port, host, function () {
      console.log(`VN Web Engine: http://${host}:${this.address().port}${base}`);
    });
  } catch (error) {
    console.error(
      error.code === 'ENOENT' ? 'Static site is missing. Run npm run build first.' : error.message,
    );
    process.exitCode = 1;
  }
}
