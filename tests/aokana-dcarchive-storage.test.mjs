import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaDcArchive} from '../dist/engines/buriko/games/aokana/native/audio/dc-archive.js';
import {AokanaArchiveFileStorage} from '../dist/engines/buriko/games/aokana/native/audio/archive-storage.js';
import {createAokanaWaveStatic} from '../dist/engines/buriko/games/aokana/native/audio/wave-static.js';
import {AokanaSpeakerModel} from '../dist/engines/buriko/games/aokana/native/audio/speaker-model.js';
import {
  AokanaSpeakerContext,
  AokanaStaticSpeaker,
} from '../dist/engines/buriko/games/aokana/native/audio/speaker.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';

test('real DCArchive member cursor feeds initialized WaveBox bytes to the actual static PCM speaker', async () => {
  const wave = new Uint8Array(72),
    header = new DataView(wave.buffer);
  for (const [offset, value] of [
    [0, 64],
    [4, 0x20207762],
    [8, 8],
    [12, 4],
    [16, 24000],
    [20, 1],
    [48, 1],
  ])
    header.setUint32(offset, value, true);
  [0, 16384, 0, -16384].forEach((value, i) => header.setInt16(64 + i * 2, value, true));
  const bytes = new Uint8Array(16 + 256 + 3 + wave.length),
    index = new DataView(bytes.buffer),
    encode = new TextEncoder();
  bytes.set(encode.encode('BURIKO ARC20'));
  index.setUint32(12, 2, true);
  bytes.set(encode.encode('Other.bin'), 16);
  index.setUint32(16 + 96, 0, true);
  index.setUint32(16 + 100, 3, true);
  bytes.set(encode.encode('Voice.BW'), 144);
  index.setUint32(144 + 96, 3, true);
  index.setUint32(144 + 100, wave.length, true);
  bytes.set([7, 8, 9], 272);
  bytes.set(wave, 275);
  const backing = new StoredFileSystem(new MemoryStore(), (p) => p.toLowerCase());
  await backing.commit([{kind: 'write', path: '/game/sound.arc', data: bytes}]);
  const mounted = new AokanaMountedFileMetadata(backing, {
    records: [
      {
        path: '/game/sound.arc',
        kind: 'file',
        attributes: 32,
        creationTime: null,
        accessTime: null,
        writeTime: 123456789n,
      },
    ],
    volumes: [{path: '/', identity: {}, writable: true}],
    canonical: (p) => p.toLowerCase(),
    currentFileTime: () => 123456789n,
    accessTimePolicy: 'disabled',
  });
  const files = new AokanaProgramFiles(
      mounted,
      new AokanaNativeText(),
      new AokanaProgramMedia(),
      new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
    ),
    archive = new AokanaDcArchive(files),
    storage = new AokanaArchiveFileStorage(),
    actor = {},
    backend = new AokanaMemorySpeakerBackend(24000),
    speaker = new AokanaStaticSpeaker(new AokanaSpeakerContext(backend));
  try {
    assert.equal(await archive.openIndex('C:\\game\\sound.arc', actor), 0);
    assert.equal(await archive.hasMember('VOICE.bw', actor), 0);
    assert.deepEqual(await archive.memberInfo('voice.BW', actor), {status: 0, offset: 3, size: 72});
    assert.equal(await storage.open(archive, 'vOiCe.Bw', actor), true);
    assert.equal(storage.size, 72);
    const actual = new Uint8Array(72),
      initialized = new Uint8Array(72);
    assert.equal(await storage.readInto({bytes: actual, offset: 0}, 64, actor, initialized), 64);
    assert.equal(storage.position, 64);
    assert.equal(await storage.readInto({bytes: actual, offset: 64}, 8, actor, initialized), 8);
    assert.equal(storage.position, 72);
    assert.deepEqual(actual, wave);
    assert.ok(initialized.every((value) => value === 1));
    assert.equal(storage.seek(66), 66);
    const continuation = new Uint8Array(6);
    assert.equal(await storage.readInto({bytes: continuation, offset: 0}, 6, actor), 6);
    assert.deepEqual([...continuation], [0, 64, 0, 0, 0, 192]);
    // Detached bytes are intentionally the fixture's final consumer, not a live-stream claim.
    const decoded = await createAokanaWaveStatic(actual, {gain: 1, prefer24Bit: false});
    assert.equal(await speaker.attach(new AokanaSpeakerModel(decoded)), 0);
    assert.equal(await speaker.start(0), 0);
    const output = backend.buffers[0].render(4);
    assert.deepEqual([...output[0]], [0, 0.5, 0, -0.5]);
    assert.deepEqual([...output[1]], [0, 0.5, 0, -0.5]);
  } finally {
    (await speaker.detach())?.dispose();
    storage.dispose();
    archive.dispose();
  }
});
