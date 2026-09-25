import test from 'node:test';
import assert from 'node:assert/strict';
import {MountedFileSystem} from '../dist/platform/filesystem.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaProgramMedia} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaProductionResourceWorker} from '../dist/engines/buriko/games/aokana/native/production-resource-worker.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';
import {AokanaDroppedFiles} from '../dist/engines/buriko/games/aokana/native/dropped-files.js';
import {AokanaMainWindowMessageReceiver} from '../dist/engines/buriko/games/aokana/native/main-window-messages.js';
import {AokanaWindowMessages as Waits} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaKnobDisplays} from '../dist/engines/buriko/games/aokana/native/knob-displays.js';
import {deviceServiceFixture} from './aokana-device-service-fixture.mjs';

test('production file owner reads a dropped Blob through its metadata-backed mount', async () => {
  const s = deviceServiceFixture(),
    listeners = new Map();
  s.canvas.addEventListener = (name, listener) => listeners.set(name, listener);
  s.canvas.removeEventListener = (name) => listeners.delete(name);
  const backing = new MountedFileSystem(),
    mounted = new AokanaMountedFileMetadata(backing, {
      records: [],
      volumes: [{path: '/', identity: {}, writable: true}],
      canonical: (path) => path.toLowerCase(),
      currentFileTime: () => 123n,
      accessTimePolicy: 'disabled',
    }),
    paths = new AokanaMountedProgramPaths([{native: 'D:\\Drops', mounted: '/drops'}], 'D:\\Drops'),
    text = s.controller.localized.text,
    encode = (value) => text.encodeWide(value, 1),
    owner = new AokanaProductionResourceWorker({
      mounted,
      paths,
      text,
      media: new AokanaProgramMedia(),
      dialogs: s.controller.mouseTrails.dialogs,
      configuration: {
        nativeFileRoot: 'D:\\Drops\\',
        primaryRoot: encode('D:\\Drops\\'),
        secondaryRoot: Uint8Array.of(0),
        secondaryMediaPath: '',
        searchDirectoriesEnabled: 0,
        searchDirectories: [],
        retryTitle: Uint8Array.of(0),
        retryMessage: Uint8Array.of(0),
        quitConfirmation: Uint8Array.of(0),
      },
      errorDirectory: encode('D:\\Drops\\'),
      workingDirectory: encode('D:\\Drops\\'),
      audioRootWide: 'D:\\Drops\\',
      backend: new AokanaMemorySpeakerBackend(1000),
      output: {prefer24Bit: false},
      ticks: s.controller.ticks,
      allocator: s.manager.surfaces.allocator,
      locks: s.manager.locks,
      resourceWorkerCount: 1,
      sleep: async () => {},
    });
  assert.equal(owner.files.metadata, mounted);
  assert.equal(owner.files.usesFileSystem(mounted), true);
  assert.equal(owner.files.usesFileSystem(backing), false);
  const drops = new AokanaDroppedFiles(
    s.canvas,
    s.messages,
    owner.files,
    mounted,
    '/drops',
    'D:\\Drops',
  );
  new AokanaMainWindowMessageReceiver(
    s.messages,
    new Waits(),
    s.input,
    s.notifications,
    s.controller.host,
    new AokanaKnobDisplays(s.manager, s.input, s.notifications),
    s.controller,
    null,
    drops,
  );
  try {
    drops.setEnabled(1);
    let prevented = false;
    listeners.get('drop')({
      preventDefault() {
        prevented = true;
      },
      dataTransfer: {files: [new File(['mounted payload'], 'SaMpLe.TXT')]},
    });
    assert.equal(prevented, true);
    assert.deepEqual(s.notifications.take(), {type: 16, value1: 0, value2: 0});
    const output = {bytes: new Uint8Array(780), offset: 0};
    assert.equal(drops.copyPath(output), 1);
    const native = text.decodeAuto(output);
    assert.equal(native, 'D:\\Drops\\1\\SaMpLe.TXT');
    assert.equal((await mounted.stat('/drops/1/sample.txt')).kind, 'file');
    const opened = await owner.files.openWide(native);
    assert.equal(opened.error, 0);
    assert.equal(
      new TextDecoder().decode(await owner.files.read(opened.source, 0, opened.source.size)),
      'mounted payload',
    );
  } finally {
    drops.dispose();
  }
  assert.equal(listeners.size, 0);
});
