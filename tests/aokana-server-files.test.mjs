import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';

test('Aokana data manifest and ranged file route expose only runtime inputs', async () => {
  const gameRoot = await mkdtemp(path.join(tmpdir(), 'aokana-server-'));
  await writeFile(path.join(gameRoot, 'system.arc'), Uint8Array.of(1, 2, 3));
  await writeFile(path.join(gameRoot, 'BGI.gdb'), Uint8Array.of(4));
  await writeFile(path.join(gameRoot, 'BGIError.txt'), 'log');
  await writeFile(path.join(gameRoot, 'Game.exe'), Uint8Array.of(5, 6));
  await writeFile(path.join(gameRoot, '._Game.exe'), 'filesystem metadata');
  await symlink('Game.exe', path.join(gameRoot, 'disguised.arc'));
  const server = spawn(process.execPath, ['tools/serve.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: {...process.env, HOST: '127.0.0.1', PORT: '0', AOKANA_DATA_ROOT: gameRoot},
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

    const manifestResponse = await fetch(`${origin}/api/aokana/files`);
    assert.equal(manifestResponse.status, 200);
    const files = await manifestResponse.json();
    assert.deepEqual(
      files.map((file) => file.name),
      ['BGI.gdb', 'system.arc'],
    );
    assert.ok(files.every((file) => Number.isSafeInteger(file.size) && file.size >= 0));
    assert.ok(files.every((file) => Number.isFinite(file.lastModifiedMs)));
    assert.ok(files.every((file) => file.url === `/aokana-data/${encodeURIComponent(file.name)}`));
    assert.deepEqual(await (await fetch(`${origin}/api/aokana/archives`)).json(), files);

    const archive = files.find((file) => /\.arc$/i.test(file.name));
    assert.ok(archive && archive.size > 0);
    const head = await fetch(new URL(archive.url, origin), {
      method: 'HEAD',
      headers: {Range: 'bytes=0-0'},
    });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-range'), `bytes 0-0/${archive.size}`);
    assert.equal(head.headers.get('content-length'), '1');
    const partial = await fetch(new URL(archive.url, origin), {
      headers: {Range: 'bytes=1-2'},
    });
    assert.equal(partial.status, 206);
    assert.deepEqual(new Uint8Array(await partial.arrayBuffer()), Uint8Array.of(2, 3));

    for (const relative of [
      '/aokana-data/%2e%2e%2fGame.exe',
      '/aokana-data/%2e%2e%5cGame.exe',
      '/aokana-data/BGIError.txt',
      '/aokana-data/Game.exe',
      '/aokana-data/disguised.arc',
    ]) {
      assert.equal((await fetch(`${origin}${relative}`, {method: 'HEAD'})).status, 404);
    }

    let cursor = await fetch(`${origin}/api/aokana/cursor`);
    assert.equal(cursor.status, 422);
    assert.equal((await cursor.json()).error, 'invalid-cursor-resource');
    await writeFile(path.join(gameRoot, 'Second.exe'), Uint8Array.of(7));
    cursor = await fetch(`${origin}/api/aokana/cursor`);
    assert.equal(cursor.status, 409);
    assert.equal((await cursor.json()).error, 'ambiguous-executable');
    await rm(path.join(gameRoot, 'Second.exe'));
    await rm(path.join(gameRoot, 'Game.exe'));
    cursor = await fetch(`${origin}/api/aokana/cursor`, {method: 'HEAD'});
    assert.equal(cursor.status, 404);
    assert.equal(cursor.headers.get('content-type'), 'application/json; charset=utf-8');
  } finally {
    server.kill();
    if (server.exitCode === null) await once(server, 'exit');
    await rm(gameRoot, {recursive: true, force: true});
  }
});
