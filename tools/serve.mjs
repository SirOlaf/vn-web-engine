import {createServer} from 'node:http';
import {readdir, stat, realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url)),
  data = fileURLToPath(new URL('../../Data/', import.meta.url));
const installation = fileURLToPath(new URL('../../', import.meta.url));
const host = process.env.HOST ?? '127.0.0.1',
  port = Number(process.env.PORT ?? 8000);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
};
createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/api/executable') {
      const info = await stat(path.join(installation, 'Game.exe'));
      res
        .writeHead(200, {'Content-Type': 'application/json'})
        .end(
          req.method === 'HEAD'
            ? undefined
            : JSON.stringify({name: 'Game.exe', size: info.size, url: '/game/Game.exe'}),
        );
      return;
    }
    if (pathname === '/api/archives') {
      const files = [];
      for (const name of (await readdir(data)).filter((n) => n.endsWith('.cpk')).sort())
        files.push({
          name,
          size: (await stat(path.join(data, name))).size,
          url: `/data/${encodeURIComponent(name)}`,
        });
      res
        .writeHead(200, {'Content-Type': 'application/json'})
        .end(req.method === 'HEAD' ? undefined : JSON.stringify(files));
      return;
    }
    let base = root,
      relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (pathname.startsWith('/data/')) {
      base = data;
      relative = pathname.slice(6);
      if (!/^[\w-]+\.cpk$/.test(relative)) {
        res.writeHead(404).end();
        return;
      }
    } else if (pathname === '/game/Game.exe') {
      base = installation;
      relative = 'Game.exe';
    } else if (!(
      relative === 'index.html' ||
      ['style.css', 'game.css', 'assets.html'].includes(relative) ||
      relative.startsWith('dist/')
    )) {
      res.writeHead(404).end();
      return;
    }
    const file = await realpath(path.resolve(base, relative));
    if (!file.startsWith(path.resolve(base) + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const info = await stat(file);
    if (!info.isFile()) {
      res.writeHead(404).end();
      return;
    }
    const headers = {
      'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    let start = 0,
      end = info.size - 1,
      status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      start = match ? Number(match[1]) : -1;
      end = match && match[2] ? Number(match[2]) : end;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start > end ||
        end >= info.size
      ) {
        res.writeHead(416, {'Content-Range': `bytes */${info.size}`}).end();
        return;
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
    headers['Content-Length'] = Math.max(0, end - start + 1);
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || !info.size) {
      res.end();
      return;
    }
    const stream = createReadStream(file, {start, end});
    res.on('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500);
    res.end('Request failed');
  }
}).listen(port, host, () => console.log(`Game: http://${host}:${port}`));
