import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {runtimeModules} from '../tools/static-runtime-modules.mjs';

test('development worker and lazy-codec URLs resolve real modules beneath the configured base', async () => {
  const base = '/codec-fixture/';
  const server = await createServer({
    configFile: false,
    publicDir: false,
    base,
    plugins: [runtimeModules()],
    server: {host: '127.0.0.1', port: 0},
  });
  try {
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    for (const [source, target] of [
      ['src/audio/vorbis-decoder.ts', 'src/audio/vorbis-worker.ts'],
      ['src/audio/vorbis-codec.ts', 'dist/vendor/ogg-vorbis.js'],
    ]) {
      const response = await fetch(origin + base + source);
      const code = (await response.text()).split('//# sourceMappingURL=')[0];
      assert.equal(response.status, 200);
      assert.ok(code.includes(JSON.stringify(base + target)), 'resolved runtime module URL');
      assert.doesNotMatch(code, /ROLLUP_FILE_URL|__vnStaticModuleImport/);
      const module = await fetch(origin + base + target);
      assert.equal(module.status, 200);
      assert.match(module.headers.get('content-type'), /javascript/);
      assert.doesNotMatch(await module.text(), /<!doctype html>/i);
    }
  } finally {
    await server.close();
  }
});
