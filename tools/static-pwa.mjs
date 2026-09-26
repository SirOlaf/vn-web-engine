import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const pwaRoot = new URL('../ui/pwa/', import.meta.url);

/** Cache the complete, final build, including lazy workers, worklets and codecs. */
export function progressiveWebApp() {
  return {
    name: 'static-progressive-web-app',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml() {
      return [
        {tag: 'link', attrs: {rel: 'manifest', href: './manifest.webmanifest'}},
        {tag: 'link', attrs: {rel: 'icon', type: 'image/svg+xml', href: './icons/icon.svg'}},
        {tag: 'link', attrs: {rel: 'apple-touch-icon', href: './icons/apple-touch-icon.png'}},
      ];
    },
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        const contents = new Map(
          Object.entries(bundle)
            .filter(([name]) => name !== '.nojekyll')
            .map(([name, output]) => [name, output.type === 'chunk' ? output.code : output.source]),
        );
        for (const fileName of [
          'manifest.webmanifest',
          'icons/icon.svg',
          'icons/icon-192.png',
          'icons/icon-512.png',
          'icons/apple-touch-icon.png',
        ]) {
          const source = await readFile(new URL(fileName, pwaRoot));
          contents.set(fileName, source);
          this.emitFile({
            type: 'asset',
            fileName,
            source,
          });
        }
        const template = await readFile(new URL('service-worker.js', pwaRoot), 'utf8');
        const files = [...contents.keys()].sort();
        const hash = createHash('sha256').update(template);
        for (const name of files) {
          hash.update(name).update('\0').update(contents.get(name));
        }
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: template
            .replace('__BUILD_REVISION__', hash.digest('hex'))
            .replace('/* __PRECACHE_FILES__ */ []', JSON.stringify(files)),
        });
      },
    },
  };
}
