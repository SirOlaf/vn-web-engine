import {MemoryStore} from '../dist/platform/store.js';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {WindowsFileSystem} from '../dist/platform/windows-filesystem.js';
import {StoredRegistry} from '../dist/platform/registry.js';
import {Sc3Runtime} from '../dist/engines/mages/games/chaos-head-noah/sc3/runtime.js';
export function scriptBytes(code) {
  const b = Buffer.alloc(16 + code.length);
  b.write('SC3\0');
  b.writeUInt32LE(b.length, 4);
  b.writeUInt32LE(b.length, 8);
  b.writeUInt32LE(16, 12);
  b.set(code, 16);
  return b;
}
export function mesBytes() {
  const b = Buffer.alloc(16);
  b.write('MES\0');
  b.writeUInt32LE(1, 4);
  b.writeUInt32LE(16, 12);
  return b;
}
export function platform() {
  const store = new MemoryStore(),
    files = new StoredFileSystem(store);
  return {
    files,
    registry: new StoredRegistry(store),
    windowsFiles: new WindowsFileSystem(files, {
      cwd: 'C:\\Game',
      mounts: [{windows: 'C:\\', virtual: '/c'}],
    }),
  };
}
export function runtime(code, requested = []) {
  let seed = 1;
  return new Sc3Runtime(
    platform(),
    {
      size: (bank, id) => (bank === 'script' ? scriptBytes(code).length : mesBytes().length),
      script: async (id) => {
        requested.push(['script', id]);
        return scriptBytes(code);
      },
      messages: async (id) => {
        requested.push(['messages', id]);
        return mesBytes();
      },
    },
    {
      random15: () => {
        seed = (Math.imul(seed, 214013) + 2531011) >>> 0;
        return (seed >>> 16) & 32767;
      },
      language: 0,
      configEnabled: false,
    },
  );
}
export const literal = (n) => [0xe0, n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24, 0, 0];
export const assignment = (op, index, value) => [
  op,
  10,
  ...literal(index).slice(0, -1),
  0x14,
  0,
  ...literal(value),
];
