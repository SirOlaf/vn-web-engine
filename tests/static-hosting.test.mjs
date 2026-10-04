import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile, readdir} from 'node:fs/promises';
import {test} from 'node:test';
import {runInNewContext} from 'node:vm';
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
      'buriko.html',
      'noah.html',
      'assets.html',
      'buriko-assets.html',
    ]) {
      const url = `${origin}${base}${page}`;
      const response = await fetch(url);
      assert.equal(response.status, 200, page);
      const html = await response.text();
      assert.match(html, /rel="manifest" href="\.\/manifest.webmanifest"/);
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
    const manifestUrl = `${origin}${base}manifest.webmanifest`;
    const manifestResponse = await fetch(manifestUrl);
    assert.match(manifestResponse.headers.get('content-type'), /application\/manifest\+json/);
    const manifest = await manifestResponse.json();
    assert.equal(new URL(manifest.scope, manifestUrl).pathname, base);
    assert.equal(new URL(manifest.id, manifestUrl).pathname, base);
    assert.equal((await fetch(new URL(manifest.start_url, manifestUrl))).status, 200);
    assert.equal(manifest.display, 'standalone');
    for (const size of [192, 512]) {
      const icon = manifest.icons.find((icon) => icon.sizes === `${size}x${size}`);
      assert.ok(icon, `${size}px install icon`);
      const image = Buffer.from(await (await fetch(new URL(icon.src, manifestUrl))).arrayBuffer());
      assert.equal(image.subarray(1, 4).toString(), 'PNG');
      assert.equal(image.readUInt32BE(16), size);
      assert.equal(image.readUInt32BE(20), size);
    }
    // Exercise installation against the generated artifact: lazy modules and
    // icons must be available offline even if no player has been opened yet.
    const events = new Map();
    let installation;
    let precached;
    runInNewContext(await (await fetch(`${origin}${base}sw.js`)).text(), {
      URL,
      Request,
      self: {
        registration: {scope: `${origin}${base}`},
        addEventListener: (name, handler) => events.set(name, handler),
      },
      caches: {
        open: async () => ({
          addAll: async (requests) => {
            precached = requests;
          },
        }),
      },
    });
    events.get('install')({
      waitUntil: (promise) => {
        installation = promise;
      },
    });
    await installation;
    assert.deepEqual(
      Array.from(precached, (request) => {
        assert.ok(request.url.startsWith(`${origin}${base}`));
        return request.url.slice(`${origin}${base}`.length);
      }).sort(),
      files.filter((file) => file.includes('.') && !['.nojekyll', 'sw.js'].includes(file)).sort(),
      'the offline cache includes the complete built website',
    );
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

test('the service worker activates an update on request and keeps the previous build for open tabs', async () => {
  const scope = 'https://example.test/preservation/vn/';
  const source = await readFile(new URL('../site/sw.js', import.meta.url), 'utf8');
  const stores = new Map([
    [`vn-web-engine:${scope}:previous`, new Map([[`${scope}assets/old-chunk.js`, 'old chunk']])],
    ['sibling-project', new Map()],
  ]);
  const events = new Map();
  let windows = [];
  let skippedWaiting = false;
  runInNewContext(source, {
    URL,
    Request,
    fetch: async () => 'network',
    self: {
      registration: {scope},
      clients: {matchAll: async () => windows},
      skipWaiting: () => {
        skippedWaiting = true;
      },
      addEventListener: (name, handler) => events.set(name, handler),
    },
    caches: {
      keys: async () => [...stores.keys()],
      open: async (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        const store = stores.get(name);
        return {addAll: async () => {}, match: async (url) => store.get(url)};
      },
      delete: async (name) => stores.delete(name),
    },
  });
  const dispatch = async (name, event) => {
    let pending;
    events.get(name)({...event, waitUntil: (promise) => (pending = promise)});
    await pending;
  };
  const respond = async (url, mode = 'no-cors') => {
    let response;
    events.get('fetch')({
      request: {url, mode, method: 'GET', headers: new Headers()},
      respondWith: (promise) => (response = promise),
    });
    return response && (await response);
  };

  events.get('message')({data: {type: 'something-else'}});
  assert.equal(skippedWaiting, false);
  events.get('message')({data: {type: 'activate-update'}});
  assert.equal(skippedWaiting, true, 'the Reload choice activates the waiting build');

  windows = [{}, {}];
  await dispatch('activate', {});
  assert.ok(stores.has(`vn-web-engine:${scope}:previous`), 'another tab still runs it');
  assert.equal(await respond(`${scope}assets/old-chunk.js`), 'old chunk');
  assert.equal(await respond(`${scope}assets/missing.js`), 'network');
  assert.equal(await respond(`${scope}old-page.html`, 'navigate'), undefined);
  assert.equal(await respond('https://elsewhere.test/assets/old-chunk.js'), undefined);

  windows = [{}];
  await dispatch('activate', {});
  assert.ok(!stores.has(`vn-web-engine:${scope}:previous`), 'no other tab needs it');
  assert.ok(stores.has('sibling-project'));
});
