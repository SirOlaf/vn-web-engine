import {createServer} from 'node:http';
import {lstat, readFile, readdir, stat, realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url)),
  data = fileURLToPath(new URL('../../Data/', import.meta.url));
const aokana = path.resolve(
  process.env.AOKANA_DATA_ROOT ?? path.join(root, 'targetgame', 'aokana'),
);
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
const aokanaRuntimeName = (name) =>
  name === 'BGI.gdb' || (/^[^./\\][^/\\]*\.arc$/i.test(name) && !name.includes('\0'));
async function aokanaRuntimeFiles() {
  const files = [];
  for (const entry of (await readdir(aokana, {withFileTypes: true}))
    .filter((entry) => entry.isFile() && aokanaRuntimeName(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const details = await stat(path.join(aokana, entry.name));
    files.push({
      name: entry.name,
      size: details.size,
      lastModifiedMs: details.mtimeMs,
      url: `/aokana-data/${encodeURIComponent(entry.name)}`,
    });
  }
  return files;
}
function cursorError(req, res, status, code, message) {
  res
    .writeHead(status, {'Content-Type': 'application/json; charset=utf-8'})
    .end(req.method === 'HEAD' ? undefined : JSON.stringify({error: code, message}));
}
async function serveAokanaCursor(req, res) {
  let entries;
  try {
    entries = await readdir(aokana, {withFileTypes: true});
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    cursorError(req, res, 404, 'missing-executable', 'No Aokana executable found');
    return;
  }
  const executables = entries.filter((entry) => entry.isFile() && /\.exe$/i.test(entry.name));
  if (executables.length === 0) {
    cursorError(req, res, 404, 'missing-executable', 'No Aokana executable found');
    return;
  }
  if (executables.length !== 1) {
    cursorError(req, res, 409, 'ambiguous-executable', 'More than one Aokana executable found');
    return;
  }
  const name = executables[0].name;
  const file = path.join(aokana, name);
  if (!(await lstat(file)).isFile()) {
    cursorError(req, res, 404, 'missing-executable', 'No regular Aokana executable found');
    return;
  }
  const realBase = await realpath(aokana);
  if (!(await realpath(file)).startsWith(realBase + path.sep)) {
    cursorError(req, res, 403, 'executable-outside-root', 'Executable is outside the game root');
    return;
  }
  if ((await stat(file)).size > 512 * 1024 * 1024) {
    cursorError(req, res, 413, 'executable-too-large', 'Executable exceeds the PE reader limit');
    return;
  }
  let PeCursorReader;
  try {
    ({PeCursorReader} = await import('../dist/formats/pe/cursor.js'));
  } catch {
    cursorError(
      req,
      res,
      503,
      'cursor-reader-unavailable',
      'Build the project before serving Aokana',
    );
    return;
  }
  let cursor;
  try {
    cursor = new PeCursorReader(new Uint8Array(await readFile(file))).read(106);
  } catch (error) {
    if (error.code === 'ENOENT') {
      cursorError(req, res, 404, 'missing-executable', 'Aokana executable disappeared');
      return;
    }
    const ambiguous = error instanceof Error && /ambiguous/i.test(error.message);
    cursorError(
      req,
      res,
      ambiguous ? 409 : 422,
      ambiguous ? 'ambiguous-cursor' : 'invalid-cursor-resource',
      ambiguous ? 'Cursor group 106 is ambiguous' : 'Executable cursor resources are malformed',
    );
    return;
  }
  if (cursor === undefined) {
    cursorError(req, res, 404, 'missing-cursor', 'Cursor group 106 was not found');
    return;
  }
  if (cursor.kind !== 'static') {
    cursorError(req, res, 422, 'non-static-cursor', 'Cursor group 106 is not static');
    return;
  }
  res
    .writeHead(200, {
      'Content-Type': 'image/x-icon',
      'Content-Length': cursor.bytes.byteLength,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Aokana-Executable-Name': encodeURIComponent(name),
    })
    .end(req.method === 'HEAD' ? undefined : cursor.bytes);
}
createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/api/aokana/archives' || pathname === '/api/aokana/files') {
      const files = await aokanaRuntimeFiles();
      res
        .writeHead(200, {'Content-Type': 'application/json'})
        .end(req.method === 'HEAD' ? undefined : JSON.stringify(files));
      return;
    }
    if (pathname === '/api/aokana/cursor') {
      await serveAokanaCursor(req, res);
      return;
    }
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
    if (pathname.startsWith('/aokana-data/')) {
      base = aokana;
      relative = pathname.slice('/aokana-data/'.length);
      if (!aokanaRuntimeName(relative)) {
        res.writeHead(404).end();
        return;
      }
      if (!(await lstat(path.join(base, relative))).isFile()) {
        res.writeHead(404).end();
        return;
      }
    } else if (pathname.startsWith('/data/')) {
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
      [
        'style.css',
        'game.css',
        'assets.html',
        'aokana.html',
        'aokana.css',
        'aokana-assets.html',
        'aokana-assets.css',
      ].includes(relative) ||
      relative.startsWith('dist/')
    )) {
      res.writeHead(404).end();
      return;
    }
    const file = await realpath(path.resolve(base, relative));
    const realBase = await realpath(base);
    if (!file.startsWith(realBase + path.sep)) {
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
}).listen(port, host, function () {
  console.log(`Game: http://${host}:${this.address().port}`);
});
