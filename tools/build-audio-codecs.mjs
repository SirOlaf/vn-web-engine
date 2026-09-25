import {build} from 'vite';
import {copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await build({
  configFile: false,
  root,
  publicDir: false,
  plugins: [
    {
      name: 'verify-reference-decoder-bundle',
      generateBundle(_options, bundle) {
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== 'chunk') continue;
          for (const [id, module] of Object.entries(chunk.modules)) {
            if (id.includes('/codec-parser/') && module.renderedLength > 0)
              throw new Error(
                'Unused codec-parser must not be included in the reference decoder bundle',
              );
          }
        }
      },
    },
  ],
  build: {
    target: 'es2022',
    outDir: 'dist/vendor',
    emptyOutDir: false,
    lib: {entry: 'tools/vorbis-codec-entry.mjs', formats: ['es'], fileName: () => 'ogg-vorbis.js'},
    minify: true,
    rolldownOptions: {
      output: {
        banner: '/*! @wasm-audio-decoders/ogg-vorbis 0.1.20; licenses: ogg-vorbis.LICENSE.txt */',
      },
    },
  },
});
await copyFile(
  new URL('../third_party/ogg-vorbis/LICENSE.txt', import.meta.url),
  new URL('../dist/vendor/ogg-vorbis.LICENSE.txt', import.meta.url),
);
