import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = path.join(root, 'src') + path.sep;
const uiRoot = path.join(root, 'ui') + path.sep;

/** Preserve module-URL semantics while bundling workers, worklets and lazy codecs.
 * Vite's ordinary asset URLs copy worklets without bundling their imports. Emitting
 * these as module entries instead keeps every relative dependency in the build.
 */
export function runtimeModules() {
  return {
    name: 'runtime-module-urls',
    enforce: 'pre',
    async transform(code, id) {
      if (!(id.startsWith(sourceRoot) || id.startsWith(uiRoot)) || !/\.[cm]?[jt]s$/.test(id))
        return;
      const references = [
        ...code.matchAll(
          /new URL\(\s*(['"])(\.[^'"]+\.[cm]?[jt]s)\1\s*,\s*import\.meta\.url\s*\)/g,
        ),
      ];
      if (!references.length) return;
      for (const reference of references.reverse()) {
        const specifier = reference[2];
        // The decoder is built separately from its pinned npm dependency.
        const candidate = path.resolve(path.dirname(id), specifier);
        const resolved = candidate.startsWith(path.join(sourceRoot, 'vendor') + path.sep)
          ? {id: path.join(root, 'dist', path.relative(sourceRoot, candidate))}
          : await this.resolve(specifier, id);
        if (!resolved || resolved.external)
          this.error(`Cannot bundle runtime module ${specifier} from ${id}`);
        const emitted = this.emitFile({
          type: 'chunk',
          id: resolved.id,
          preserveSignature: 'strict',
        });
        const expression = `new URL(import.meta.ROLLUP_FILE_URL_${emitted}, import.meta.url)`;
        code =
          code.slice(0, reference.index) +
          expression +
          code.slice(reference.index + reference[0].length);
      }
      // Hide native URL imports from Vite's document-based preload/error helper:
      // these modules also run inside workers. Restore the import at render time,
      // after Vite's import analysis; emitFile already owns the dependency graph.
      code = code.replace(
        /import\(\s*(?=new URL\(import\.meta\.ROLLUP_FILE_URL_)/g,
        '__vnStaticModuleImport(',
      );
      return {code, map: null};
    },
    renderChunk(code) {
      if (!code.includes('__vnStaticModuleImport(')) return;
      return {code: code.replaceAll('__vnStaticModuleImport(', 'import('), map: null};
    },
    async generateBundle(_options, bundle) {
      for (const [name, output] of Object.entries(bundle)) {
        if (name.endsWith('.map')) this.error(`Source map must not be published: ${name}`);
        if (output.type !== 'chunk') continue;
        for (const dependency of [...output.imports, ...output.dynamicImports]) {
          if (!(dependency in bundle))
            this.error(`Missing static dependency ${dependency} from ${name}`);
        }
      }
      this.emitFile({type: 'asset', fileName: '.nojekyll', source: ''});
      this.emitFile({
        type: 'asset',
        fileName: 'assets/ogg-vorbis.LICENSE.txt',
        source: await readFile(path.join(root, 'third_party/ogg-vorbis/LICENSE.txt'), 'utf8'),
      });
    },
  };
}
