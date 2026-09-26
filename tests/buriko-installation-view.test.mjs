import test from 'node:test';
import assert from 'node:assert/strict';
import {readBurikoHvlCatalog} from '../dist/formats/buriko/hvl.js';
import {burikoInstallationView} from '../dist/engines/buriko/installation-view.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';

function catalog(names, version = 1) {
  const stride = version === 1 ? 64 : 256,
    bytes = new Uint8Array(16 + names.length * stride),
    data = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(version === 1 ? 'BHV_____' : 'BHV_V2__'));
  data.setUint32(12, names.length, true);
  names.forEach((name, index) => {
    bytes.set(new TextEncoder().encode(name), 16 + index * stride);
    data.setBigUint64(16 + (index + 1) * stride - 8, 0x0102030405060708n + BigInt(index), true);
  });
  return bytes;
}
function source(bytes) {
  return {
    size: bytes.length,
    reads: [],
    async read(offset, length) {
      this.reads.push([offset, length]);
      return bytes.slice(offset, offset + length);
    },
  };
}
function file(path, bytes = new Uint8Array()) {
  return {path, source: source(bytes), lastModifiedMs: 123};
}

test('disc catalogs project a zero-copy runtime tree while installed folders retain all files', async () => {
  for (const version of [1, 2]) {
    const files = [
      file('/BGI.exe'),
      file('/BGIForInstalling.exe'),
      file('/BGI.hvl', catalog(['SYSTEM.ARC', 'Data\\part.arc'], version)),
      file('/system.arc'),
      file('/data/part.arc'),
      file('/DiscMarker'),
      file('/Setup.exe'),
      file('/DirectX9/dxsetup.exe'),
      file('/installer.arc'),
    ];
    // Resource size is deliberately multi-GB. Inspection must not read/copy it.
    files[4].source.size = 10 * 1024 ** 3;
    const parsed = await readBurikoHvlCatalog(files[2].source);
    assert.equal(parsed.version, version);
    assert.equal(parsed.entries[1].name, 'Data\\part.arc');
    assert.equal(parsed.entries[1].checksum, 0x0102030405060709n);
    const projected = await burikoInstallationView(files, '/bgi.exe'),
      mounted = new SourceFileSystem((path) => path.toLowerCase());
    assert.equal(projected.kind, 'disc');
    assert.deepEqual(
      projected.files.map(({path}) => path),
      ['/BGI.exe', '/BGI.hvl', '/system.arc', '/data/part.arc'],
    );
    for (const entry of projected.files) {
      assert.ok(files.includes(entry));
      mounted.attach(entry.path, entry.source);
    }
    assert.equal(await mounted.open('/data/part.arc'), files[4].source);
    await assert.rejects(mounted.stat('/DiscMarker'), {code: 'NOT_FOUND'});
    assert.ok(
      files
        .filter((entry) => entry.path !== '/BGI.hvl')
        .every(({source}) => source.reads.length === 0),
    );
    // Restoring raw selected sources reproduces the same runtime projection.
    assert.deepEqual((await burikoInstallationView([...files], '/BGI.exe')).files, projected.files);
    const installed = files.filter((entry) => entry.path !== '/BGIForInstalling.exe'),
      unchanged = await burikoInstallationView(installed, '/BGI.exe');
    assert.equal(unchanged.kind, 'installed');
    assert.equal(unchanged.files, installed);
  }
});

test('disc metadata rejects truncated, oversized, unsafe, duplicate and missing catalog records', async () => {
  const entries = (names) => [
    file('/BGI.exe'),
    file('/BGIForInstalling.exe'),
    file('/BGI.hvl', catalog(names)),
    file('/system.arc'),
  ];
  for (const name of ['../outside.arc', 'C:\\outside.arc', '\\network\\file.arc', './system.arc'])
    await assert.rejects(
      burikoInstallationView(entries(['system.arc', name]), '/BGI.exe'),
      /Unsafe/,
    );
  await assert.rejects(
    burikoInstallationView(entries(['system.arc', 'SYSTEM.ARC']), '/BGI.exe'),
    /Duplicate/,
  );
  await assert.rejects(
    burikoInstallationView(entries(['system.arc', 'missing.arc']), '/BGI.exe'),
    /missing/,
  );
  await assert.rejects(
    burikoInstallationView(entries([]), '/BGI.exe'),
    /does not include system.arc/,
  );
  const truncated = catalog(['system.arc']).subarray(0, 40);
  await assert.rejects(readBurikoHvlCatalog(source(truncated)), /Truncated/);
  const oversized = catalog([]);
  new DataView(oversized.buffer).setUint32(12, 0xffffffff, true);
  const bounded = source(oversized);
  await assert.rejects(readBurikoHvlCatalog(bounded), /entry limit/);
  assert.deepEqual(bounded.reads, [[0, 16]]);
  const unterminated = catalog(['system.arc']);
  unterminated.fill(65, 16, 72);
  await assert.rejects(readBurikoHvlCatalog(source(unterminated)), /unterminated/);
});
