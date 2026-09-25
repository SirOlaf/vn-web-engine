import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';

test('CHAOS;HEAD NOAH server opens a configured game root and serves only game inputs', async () => {
  const gameRoot = await mkdtemp(path.join(tmpdir(), 'noah-server-'));
  const data = path.join(gameRoot, 'Data');
  await mkdir(data);
  await writeFile(path.join(gameRoot, 'Game.exe'), Uint8Array.of(1, 2, 3));
  await writeFile(path.join(data, 'script.cpk'), Uint8Array.of(4, 5, 6));
  await writeFile(path.join(data, 'mes00.CPK'), Uint8Array.of(7));
  await writeFile(path.join(data, 'notes.txt'), 'not an archive');
  await symlink('script.cpk', path.join(data, 'linked.cpk'));
  const server = spawn(process.execPath, ['tools/serve.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: {...process.env, HOST: '127.0.0.1', PORT: '0', NOAH_DATA_ROOT: gameRoot},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  try {
    const origin = await Promise.race([
      new Promise((resolve, reject) => {
        server.stdout.setEncoding('utf8');
        server.stdout.on('data', (chunk) => {
          output += chunk;
          const match = /Game: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
          if (match) resolve(match[1]);
        });
        server.on('error', reject);
        server.on('exit', (code) => reject(new Error(`Server exited before ready: ${code}`)));
      }),
      delay(5000, undefined, {ref: false}).then(() => {
        throw new Error('Server did not become ready');
      }),
    ]);

    const archives = await fetch(`${origin}/api/archives`);
    assert.equal(archives.status, 200);
    assert.deepEqual(await archives.json(), [
      {name: 'mes00.CPK', size: 1, url: '/data/mes00.CPK'},
      {name: 'script.cpk', size: 3, url: '/data/script.cpk'},
    ]);
    const executable = await fetch(`${origin}/api/executable`);
    assert.equal(executable.status, 200);
    assert.deepEqual(await executable.json(), {
      name: 'Game.exe',
      size: 3,
      url: '/game/Game.exe',
    });

    const partial = await fetch(`${origin}/data/script.cpk`, {headers: {Range: 'bytes=1-2'}});
    assert.equal(partial.status, 206);
    assert.deepEqual(new Uint8Array(await partial.arrayBuffer()), Uint8Array.of(5, 6));
    const exe = await fetch(`${origin}/game/Game.exe`);
    assert.equal(exe.status, 200);
    assert.deepEqual(new Uint8Array(await exe.arrayBuffer()), Uint8Array.of(1, 2, 3));
    assert.equal((await fetch(`${origin}/data/mes00.CPK`, {method: 'HEAD'})).status, 200);

    for (const relative of ['/data/notes.txt', '/data/linked.cpk', '/data/../Game.exe'])
      assert.equal((await fetch(`${origin}${relative}`, {method: 'HEAD'})).status, 404);
  } finally {
    server.kill();
    if (server.exitCode === null) await once(server, 'exit');
    await rm(gameRoot, {recursive: true, force: true});
  }
});
