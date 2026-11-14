import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  NativeDelayLoadError,
  NativeLibraryLoader,
  defineNativeContract,
} from '../dist/platform/native-libraries.js';

const COUNTER = defineNativeContract('counter.dll', '1');
const CLIENT = defineNativeContract('client.dll', '1');
const STATIC_CLIENT = defineNativeContract('static-client.dll', '1');

const image = (sha256) => ({kind: 'image', sha256});

/** Maps file names to identities, as an installation scan would. */
class TableLocator {
  constructor(files) {
    this.files = new Map(Object.entries(files));
    this.calls = [];
  }
  locate(fileName, requester) {
    this.calls.push({fileName, requester});
    return this.files.get(fileName.toLowerCase()) ?? null;
  }
}

/** Two implementations of one contract with different internals. */
function scriptCounter(log) {
  return {
    contract: COUNTER,
    identities: [image('aa')],
    imports: [],
    link() {
      let total = 0;
      return {
        exports: {
          add(value) {
            total += value;
            return total;
          },
        },
        detach: () => log.push('counter detach'),
      };
    },
  };
}

function bufferCounter(log) {
  return {
    contract: COUNTER,
    identities: [image('aa')],
    imports: [],
    link() {
      const memory = new Int32Array(1);
      return {
        exports: {add: (value) => (memory[0] += value)},
        detach: () => log.push('counter detach'),
      };
    },
  };
}

function delayClient(log) {
  return {
    contract: CLIENT,
    identities: [image('bb')],
    imports: [{contract: COUNTER, binding: 'delay'}],
    link(context) {
      const counter = context.delayImport(COUNTER);
      log.push('client linked');
      return {
        exports: {run: (values) => values.map((value) => counter().add(value))},
        detach: () => log.push('client detach'),
      };
    },
  };
}

for (const [name, counter] of [
  ['script', scriptCounter],
  ['buffer', bufferCounter],
]) {
  test(`delay import composes through the contract (${name} implementation)`, () => {
    const log = [];
    const locator = new TableLocator({'client.dll': image('bb'), 'counter.dll': image('AA')});
    const loader = new NativeLibraryLoader([counter(log), delayClient(log)], locator);
    const result = loader.load('CLIENT.dll');
    assert.equal(result.status, 'loaded');
    assert.deepEqual(log, ['client linked']);
    assert.equal(result.library.exports(COUNTER), null);
    const client = result.library.exports(CLIENT);
    assert.deepEqual(client.run([2, 3]), [2, 5]);
    assert.deepEqual(locator.calls.at(-1), {fileName: 'counter.dll', requester: image('bb')});
    loader.free(result.library);
    assert.deepEqual(log, ['client linked', 'client detach']);
    loader.dispose();
    assert.deepEqual(log, ['client linked', 'client detach', 'counter detach']);
  });
}

test('static imports are shared, reference counted and detached after their importers', () => {
  const log = [];
  const staticClient = {
    contract: STATIC_CLIENT,
    identities: [image('cc')],
    imports: [{contract: COUNTER, binding: 'static'}],
    link(context) {
      const counter = context.staticImport(COUNTER);
      return {
        exports: {add: (value) => counter.add(value)},
        detach: () => log.push('client detach'),
      };
    },
  };
  const loader = new NativeLibraryLoader(
    [scriptCounter(log), staticClient],
    new TableLocator({'static-client.dll': image('cc'), 'counter.dll': image('aa')}),
  );
  const direct = loader.load('counter.dll');
  const client = loader.load('static-client.dll');
  client.library.exports(STATIC_CLIENT).add(4);
  assert.equal(direct.library.exports(COUNTER).add(1), 5);
  loader.free(direct.library);
  assert.deepEqual(log, []);
  loader.free(client.library);
  assert.deepEqual(log, ['client detach', 'counter detach']);
  assert.throws(() => loader.free(client.library), /already freed/);
});

test('load results distinguish missing files, unsupported builds and failed imports', () => {
  const staticClient = {
    contract: STATIC_CLIENT,
    identities: [image('cc')],
    imports: [{contract: COUNTER, binding: 'static'}],
    link: () => assert.fail('must not link without its import'),
  };
  const loader = new NativeLibraryLoader(
    [staticClient],
    new TableLocator({'static-client.dll': image('cc'), 'counter.dll': image('ff')}),
  );
  assert.deepEqual(loader.load('absent.dll'), {status: 'not-found', fileName: 'absent.dll'});
  assert.deepEqual(loader.load('counter.dll'), {
    status: 'unsupported',
    fileName: 'counter.dll',
    identity: image('ff'),
  });
  assert.deepEqual(loader.load('static-client.dll'), {
    status: 'import-failed',
    fileName: 'static-client.dll',
    cause: {status: 'unsupported', fileName: 'counter.dll', identity: image('ff')},
  });
});

test('a failed delay import throws at first use', () => {
  const loader = new NativeLibraryLoader(
    [delayClient([])],
    new TableLocator({'client.dll': image('bb')}),
  );
  const client = loader.load('client.dll').library.exports(CLIENT);
  assert.throws(
    () => client.run([1]),
    (error) =>
      error instanceof NativeDelayLoadError &&
      error.result.status === 'not-found' &&
      error.result.fileName === 'counter.dll',
  );
});

test('a contract mismatch is reported, not linked', () => {
  const other = {...scriptCounter([]), contract: defineNativeContract('counter.dll', '2')};
  const loader = new NativeLibraryLoader(
    [other, delayClient([])],
    new TableLocator({'client.dll': image('bb'), 'counter.dll': image('aa')}),
  );
  const client = loader.load('client.dll').library.exports(CLIENT);
  assert.throws(
    () => client.run([1]),
    (error) => error.result?.status === 'unsupported',
  );
});

test('undeclared imports and duplicate identities are rejected', () => {
  const sneaky = {
    contract: CLIENT,
    identities: [image('bb')],
    imports: [],
    link: (context) => ({exports: {counter: context.delayImport(COUNTER)}}),
  };
  const loader = new NativeLibraryLoader([sneaky], new TableLocator({'client.dll': image('bb')}));
  assert.throws(() => loader.load('client.dll'), /undeclared delay import counter\.dll/);
  assert.throws(
    () => new NativeLibraryLoader([scriptCounter([]), bufferCounter([])], new TableLocator({})),
    /Two native library implementations/,
  );
});

// Contract boundary: see src/native/README.md.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeRoot = join(root, 'src', 'native');

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (path.endsWith('.ts')) files.push(path);
  }
  return files;
}

function importTargets(path) {
  const text = readFileSync(path, 'utf8');
  const specifiers = [
    ...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
  ].map((match) => match[1]);
  return specifiers
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => resolve(dirname(path), specifier).replace(/\.js$/, '.ts'));
}

/** The library directory a path belongs to, or null outside src/native. */
function nativeLibrary(path) {
  const inside = relative(nativeRoot, path);
  if (inside.startsWith('..') || !inside.includes(sep)) return null;
  return inside.split(sep)[0];
}

test('code outside a native library imports only its contract', () => {
  const violations = [];
  for (const file of sourceFiles(join(root, 'src'))) {
    for (const target of importTargets(file)) {
      const library = nativeLibrary(target);
      if (library === null || nativeLibrary(file) === library) continue;
      if (target !== join(nativeRoot, library, 'contract.ts'))
        violations.push(`${relative(root, file)} -> ${relative(root, target)}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('contracts import only contracts and the loader', () => {
  const loader = join(root, 'src', 'platform', 'native-libraries.ts');
  const violations = [];
  for (const file of sourceFiles(nativeRoot).filter((path) => path.endsWith(`${sep}contract.ts`))) {
    for (const target of importTargets(file)) {
      const isContract = nativeLibrary(target) !== null && target.endsWith(`${sep}contract.ts`);
      if (!isContract && target !== loader)
        violations.push(`${relative(root, file)} -> ${relative(root, target)}`);
    }
  }
  assert.deepEqual(violations, []);
});
