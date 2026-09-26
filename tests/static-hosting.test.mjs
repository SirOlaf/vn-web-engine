import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile, readdir} from 'node:fs/promises';
import {test} from 'node:test';
import {createStaticServer} from '../tools/serve-static.mjs';

test('the production artifact serves complete pages beneath a project path without debug routes', async () => {
  const base = '/preservation/vn/';
  const server = await createStaticServer({base});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const page of [
      'index.html',
      'aokana.html',
      'noah.html',
      'assets.html',
      'aokana-assets.html',
    ]) {
      const url = `${origin}${base}${page}`;
      const response = await fetch(url);
      assert.equal(response.status, 200, page);
      const html = await response.text();
      const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
      assert.ok(
        references.some((reference) => reference.endsWith('.js')),
        `${page} mounts an application`,
      );
      for (const reference of references) {
        const asset = new URL(reference, url);
        assert.ok(
          asset.pathname.startsWith(base),
          `${page}: ${reference} stays beneath the project path`,
        );
        assert.equal((await fetch(asset, {method: 'HEAD'})).status, 200, reference);
      }
    }
    const files = await readdir(new URL('../site/', import.meta.url), {recursive: true});
    assert.ok(files.includes('.nojekyll'));
    assert.ok(files.includes('assets/ogg-vorbis.LICENSE.txt'));
    assert.ok(files.some((file) => /worklet.*\.js$/.test(file)));
    assert.ok(files.some((file) => /worker.*\.js$/.test(file)));
    const codec = files.find((file) => /\/ogg-vorbis-[^/]+\.js$/.test(file));
    assert.ok(codec, 'the lazy decoder is part of the artifact');
    const {VorbisPacketDecoder} = await import(new URL(`../site/${codec}`, import.meta.url));
    const decoder = new VorbisPacketDecoder();
    await decoder.ready;
    decoder.free();
    assert.ok(
      files.every((file) => !/\.map$|(^|\/)(?:targetgame|tools|tests|src|dist)(?:\/|$)/.test(file)),
    );
    for (const file of files.filter((file) => file.endsWith('.js'))) {
      const source = await readFile(new URL(`../site/${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /sourceMappingURL=/, file);
      assert.equal((await fetch(`${origin}${base}${file}`, {method: 'HEAD'})).status, 200, file);
    }
    for (const route of [
      'api/archives',
      'api/aokana/files',
      'targetgame/aokana/system.arc',
      'tools/serve.mjs',
      'dist/game.js',
      '%2e%2e%2fpackage.json',
    ])
      assert.equal((await fetch(`${origin}${base}${route}`)).status, 404, route);
    assert.equal((await fetch(`${origin}/`)).status, 404);
    assert.equal((await fetch(`${origin}${base}`, {method: 'POST'})).status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
