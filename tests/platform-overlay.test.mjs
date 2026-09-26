import test from 'node:test';
import assert from 'node:assert/strict';
import {BlobSource} from '../dist/core/source.js';
import {OverlayFileSystem, SourceFileSystem, readFile} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';

test('persistent overlay retains range sources and commits writes and deletions atomically', async () => {
  const canonical = (path) => path.toLowerCase();
  const installed = new SourceFileSystem(canonical);
  const archive = new BlobSource(new Blob([Uint8Array.of(1, 2, 3)]));
  installed.attach('/System.ARC', archive);
  installed.attach('/Old.ini', new BlobSource(new Blob([Uint8Array.of(4)])));
  const store = new MemoryStore();
  let files = new OverlayFileSystem(installed, store, canonical);
  assert.equal(await files.open('/SYSTEM.arc'), archive);
  await files.commit([
    {kind: 'write', path: '/Save/Data.bin', data: Uint8Array.of(8)},
    {kind: 'delete', path: '/OLD.INI'},
    {kind: 'write', path: '/system.arc', data: Uint8Array.of(9)},
  ]);
  files = new OverlayFileSystem(installed, store, canonical);
  assert.deepEqual([...(await readFile(files, '/save/data.BIN'))], [8]);
  assert.deepEqual([...(await readFile(files, '/SYSTEM.ARC'))], [9]);
  await assert.rejects(files.open('/old.ini'), /NOT_FOUND/);
  assert.deepEqual(
    (await files.list('/')).map(({path}) => path),
    ['/save', '/system.arc'],
  );
  await assert.rejects(
    files.commit([
      {kind: 'write', path: '/save/data.bin', data: Uint8Array.of(7)},
      {kind: 'delete', path: '/missing'},
    ]),
    /NOT_FOUND/,
  );
  assert.deepEqual([...(await readFile(files, '/save/data.bin'))], [8]);
  await files.commit([
    {kind: 'delete', path: '/system.arc'},
    {kind: 'write', path: '/SYSTEM.ARC', data: Uint8Array.of(5)},
  ]);
  assert.deepEqual([...(await readFile(files, '/system.arc'))], [5]);
  await files.commit([{kind: 'delete', path: '/system.arc'}]);
  await assert.rejects(files.open('/system.arc'), /NOT_FOUND/);
  await files.commit([{kind: 'write', path: '/system.arc/child', data: Uint8Array.of(6)}]);
  assert.deepEqual([...(await readFile(files, '/system.arc/child'))], [6]);
});
