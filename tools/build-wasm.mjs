import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = await mkdtemp(join(tmpdir(), 'vn-web-wasm-'));
try {
  for (const [name, exported, destination] of [
    ['linear-rgb', 'LINEAR_RGB_WASM_BINARY', 'src/graphics/linear-rgb-wasm-binary.ts'],
    [
      'aokana-bitmap',
      'BURIKO_BITMAP_WASM_BINARY',
      'src/engines/buriko/native/bitmap-alpha-wasm-binary.ts',
    ],
  ]) {
    const result = spawnSync(
      'cargo',
      [
        'rustc',
        '--manifest-path',
        `wasm/${name}/Cargo.toml`,
        '--locked',
        '--offline',
        '--target',
        'wasm32-unknown-unknown',
        '--target-dir',
        target,
        '--release',
        '--',
        '-C',
        'target-feature=+simd128',
        '-C',
        'link-arg=--export=__heap_base',
      ],
      {cwd: root, stdio: 'inherit'},
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Rust WebAssembly build exited ${result.status}`);
    const bytes = await readFile(
      join(target, `wasm32-unknown-unknown/release/${name.replaceAll('-', '_')}.wasm`),
    );
    await writeFile(
      join(root, destination),
      `// Generated from wasm/${name} by npm run build:wasm. Do not edit.\n` +
        '// prettier-ignore\n' +
        `export const ${exported} = '${bytes.toString('base64')}';\n`,
    );
  }
} finally {
  await rm(target, {recursive: true, force: true});
}
