import test from 'node:test';
import assert from 'node:assert/strict';
import {MountedFileSystem, StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaProductionDisplayResourceGraph} from '../dist/engines/buriko/games/aokana/native/production-display-resource-graph.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaProgramMedia} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';
import {aokanaIsoSampleBytes} from '../dist/engines/buriko/games/aokana/native/movie-iso-samples.js';

function join(...parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
}
function u32(...values) {
  const bytes = new Uint8Array(values.length * 4),
    view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value));
  return bytes;
}
const four = (value) => Uint8Array.from(value, (char) => char.charCodeAt(0));
function box(type, ...parts) {
  const body = join(...parts);
  return join(u32(body.length + 8), four(type), body);
}
const full = (type, flags, ...parts) => box(type, u32(flags), ...parts);
const table = (type, rows, stride) => full(type, 0, u32(rows.length / stride), u32(...rows));

function movieDocument(sample) {
  const tkhd = new Uint8Array(80),
    header = new DataView(tkhd.buffer);
  header.setUint32(8, 1);
  header.setUint32(16, 40);
  header.setUint32(36, 0x10000);
  header.setUint32(52, 0x10000);
  header.setUint32(68, 0x40000000);
  header.setUint32(72, 2 * 65536);
  header.setUint32(76, 2 * 65536);
  const avcHeader = new Uint8Array(78),
    avcView = new DataView(avcHeader.buffer);
  avcView.setUint16(6, 1);
  avcView.setUint16(24, 2);
  avcView.setUint16(26, 2);
  const description = box(
    'avc1',
    avcHeader,
    box('avcC', Uint8Array.of(1, 100, 0, 31, 255, 224, 0)),
  );
  const tables = join(
    table('stts', [1, 40], 2),
    table('stsc', [1, 1, 1], 3),
    full('stsz', 0, u32(0, 1, sample.length)),
    table('stco', [8], 1),
    table('stss', [1], 1),
  );
  const track = box(
    'trak',
    full('tkhd', 1, tkhd),
    box(
      'mdia',
      full('mdhd', 0, u32(0, 0, 1000, 40)),
      full('hdlr', 0, u32(0), four('vide')),
      box(
        'minf',
        box('dinf', full('dref', 0, u32(1), full('url ', 1))),
        box('stbl', full('stsd', 0, u32(1), description), tables),
      ),
    ),
  );
  return join(box('mdat', sample), box('moov', full('mvhd', 0, u32(0, 0, 1000, 40)), track));
}
function archive(entries) {
  const base = 16 + entries.length * 128;
  const bytes = new Uint8Array(base + entries.reduce((sum, entry) => sum + entry.data.length, 0));
  const view = new DataView(bytes.buffer),
    encode = new TextEncoder();
  bytes.set(encode.encode('BURIKO ARC20'));
  view.setUint32(12, entries.length, true);
  let offset = 0;
  entries.forEach((entry, index) => {
    const record = 16 + index * 128;
    bytes.set(encode.encode(entry.name), record);
    view.setUint32(record + 96, offset, true);
    view.setUint32(record + 100, entry.data.length, true);
    bytes.set(entry.data, base + offset);
    offset += entry.data.length;
  });
  return bytes;
}

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.disabled = false;
    this.rect = {left: 800, top: 50, right: 1200, bottom: 350};
  }
  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }
  removeEventListener(name, listener) {
    if (this.listeners.get(name) === listener) this.listeners.delete(name);
  }
  append(child) {
    this.children.push(child);
  }
  contains(target) {
    return this === target || this.children.some((child) => child.contains(target));
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  getBoundingClientRect() {
    return this.rect;
  }
  getContext() {
    assert.fail('partial graph fixture must not initialize or render a device');
  }
  focus() {}
  remove() {
    this.removed = true;
  }
}

test('one partial production graph joins real display/window and mounted resource-worker owners', async () => {
  let hostTimeReads = 0;
  let clockNow = 100;
  let documentHasFocus = true;
  const moviePerformance = {
    now: () => {
      hostTimeReads++;
      return clockNow;
    },
  };
  const selectedSample = Uint8Array.of(41, 42, 43, 44),
    selectedMovie = movieDocument(selectedSample),
    archivedSample = Uint8Array.of(51, 52, 53, 54, 55),
    archivedMovie = movieDocument(archivedSample),
    physicalArchive = archive([
      {name: 'padding.bin', data: Uint8Array.of(1, 2, 3)},
      {name: 'archived.iso', data: archivedMovie},
    ]);
  const store = new MemoryStore(),
    files = new StoredFileSystem(store, (path) => path.toLowerCase());
  await files.commit([
    {kind: 'write', path: '/document', data: Uint8Array.of(11, 22, 33, 44)},
    {kind: 'write', path: '/movie.iso', data: selectedMovie},
    {kind: 'write', path: '/physical.arc', data: physicalArchive},
  ]);
  const backing = new MountedFileSystem();
  backing.mount('/game', files);
  const mounted = new AokanaMountedFileMetadata(backing, {
      records: [
        {
          path: '/game/document',
          kind: 'file',
          attributes: 32,
          creationTime: null,
          accessTime: null,
          writeTime: 123n,
        },
        {
          path: '/game/movie.iso',
          kind: 'file',
          attributes: 32,
          creationTime: null,
          accessTime: null,
          writeTime: 123n,
        },
        {
          path: '/game/physical.arc',
          kind: 'file',
          attributes: 32,
          creationTime: null,
          accessTime: null,
          writeTime: 123n,
        },
      ],
      volumes: [{path: '/', identity: {}, writable: true}],
      canonical: (path) => path.toLowerCase(),
      currentFileTime: () => 123n,
      accessTimePolicy: 'disabled',
    }),
    paths = new AokanaMountedProgramPaths(
      [
        {native: 'C:\\game', mounted: '/game'},
        {native: 'D:\\Drops', mounted: '/drops'},
      ],
      'C:\\game',
    ),
    text = new AokanaNativeText(),
    encode = (value) => text.encodeWide(value, 1),
    document = {
      createElement: (tag) => new Element(tag),
      hasFocus: () => documentHasFocus,
      activeElement: null,
    },
    parent = document.createElement('div'),
    canvas = document.createElement('canvas'),
    graph = new AokanaProductionDisplayResourceGraph({
      document,
      parent,
      canvas,
      navigator: {},
      readViewportScreenMapping: () => ({
        originX: 200,
        originY: 100,
        nativePixelsPerCssX: 2,
        nativePixelsPerCssY: 2,
      }),
      wheelTranslator: {translate: () => [{axis: 'vertical', delta: 120}]},
      monitors: [
        [0, 0, 1000, 1000],
        [1000, 0, 2000, 1000],
      ],
      selectedMonitor: 0,
      primaryMonitor: 0,
      clientOrigin: [0, 0],
      adapters: [
        {
          monitor: 0,
          pixelShaderVersion: 0,
          mode: {width: 1000, height: 1000, refreshRate: 60, format: 22},
        },
        {
          monitor: 1,
          pixelShaderVersion: 0,
          mode: {width: 1000, height: 1000, refreshRate: 60, format: 22},
        },
      ],
      damageCapacity: 64,
      childMetrics: {
        frameWidth: 0,
        frameHeight: 0,
        verticalScrollbarWidth: 0,
        horizontalScrollbarHeight: 0,
      },
      nativeWindowTitle: encode('Aokana'),
      preferredDialogTitle: null,
      cursorResource: null,
      performance: moviePerformance,
      readSystemTime: () => new Date(Date.UTC(2026, 8, 19, 12, 34, 56)),
      cpuHost: {
        cpuid: () => [0, 0, 0, 0],
        readTimestampCounter: () => 0n,
        setCurrentThreadAffinity: () => 1n,
        logicalProcessorCount: () => 1,
        logicalProcessorInformation: () => [{relationship: 0, processorMask: 1n}],
      },
      registryStore: new MemoryStore(),
      specialFolderProfile: {
        shellAllocatorAvailable: false,
        windows: null,
        programFiles: null,
        currentUser: {desktop: null, programs: null, documents: null, profile: null},
        shellUser: {desktop: null, programs: null, documents: null, profile: null},
        elevated: false,
        shellTokenAvailable: false,
        debugPrivilegeAvailable: false,
        shellAccountName: null,
      },
      readUserDefaultUiLanguage: () => 0x409,
      localizedText: null,
      processorCount: 1,
      executablePathWide: 'C:\\game\\aokana.exe',
      commandLineTailWide: '   ',
      drop: {mountedRoot: '/drops', nativeRoot: 'D:\\Drops'},
      resource: {
        mounted,
        paths,
        media: new AokanaProgramMedia(),
        configuration: {
          nativeFileRoot: 'C:\\game\\',
          primaryRoot: encode('C:\\game\\'),
          secondaryRoot: Uint8Array.of(0),
          secondaryMediaPath: '',
          searchDirectoriesEnabled: 0,
          searchDirectories: [],
          retryTitle: Uint8Array.of(0),
          retryMessage: Uint8Array.of(0),
          quitConfirmation: Uint8Array.of(0),
        },
        errorDirectory: encode('C:\\game\\'),
        workingDirectory: encode('C:\\game\\'),
        audioRootWide: 'C:\\game\\',
        backend: new AokanaMemorySpeakerBackend(1000),
        output: {prefer24Bit: false},
        resourceWorkerCount: 1,
        sleep: async () => {},
      },
    });
  assert.equal(graph.resource.files.metadata, mounted);
  assert.equal(graph.resource.files.paths, paths);
  assert.equal(graph.resource.resources.files, graph.resource.files);
  assert.equal(graph.resource.scripts.files, graph.resource.files);
  assert.equal(graph.resource.channels.actors, graph.allocator);
  assert.equal(graph.manager.surfaces.allocator, graph.allocator);
  assert.equal(graph.particles.manager, graph.manager);
  assert.equal(graph.particles.variants, graph.particleVariants);
  assert.equal(graph.particles.random, graph.particleRandom);
  assert.equal(graph.particles.clock, graph.clock);
  assert.equal(graph.particles.processing, graph.resource.processing);
  assert.equal(graph.particleFrames.particles, graph.particles);
  assert.equal(graph.movieFramePosition.surfaces, graph.surfaces);
  assert.equal(graph.movieFramePosition.movies, graph.movies);
  assert.equal(graph.resource.channels.locks, graph.manager.locks);
  assert.equal(graph.sizeEffects.graph, graph);
  assert.equal(graph.sizeEffects.graph.resource.channels, graph.resource.channels);
  assert.equal(graph.sizeEffects.graph.manager.locks, graph.manager.locks);
  assert.equal(graph.sizeEffects.graph.receiver, graph.receiver);
  assert.equal(graph.sizeEffects.graph.input, graph.input);
  assert.equal(graph.sizeEffects.graph.clock, graph.clock);
  assert.equal(graph.sizeEffects.graph.traditionalMovieAudio, graph.traditionalMovieAudio);
  assert.equal(graph.sizeEffects.graph.mfMovieVolume, graph.mfMovieVolume);
  assert.equal(graph.controller.fullscreenMovie, graph.fullscreenMovie);
  assert.equal(graph.frames.fullscreenMovie, graph.fullscreenMovie);
  assert.equal(graph.mfMovieVolume.fullscreen, graph.fullscreenMovie);
  assert.equal(graph.mfSourceCandidates.resources, graph.resource.resources);
  assert.equal(graph.movieSources.resources, graph.resource.resources);
  assert.equal(graph.installerManifest.resources, graph.resource.resources);
  assert.deepEqual(graph.externalMutexName.readAnsiName(), Uint8Array.of(0));
  assert.equal(graph.mfMovieVolume.savedVolume, 0);
  assert.equal(graph.traditionalMovieAudio.savedDecibels, 0);
  assert.equal(graph.callbacks.isReady(), true);
  assert.equal(parent.contains(canvas), true);
  assert.equal(parent.children.filter((child) => child === canvas).length, 1);
  document.activeElement = canvas;
  assert.equal(graph.host.isForegroundWindow(), true);
  assert.deepEqual(graph.host.mapCanvasViewportPoint(810, 60), {
    clientX: 20,
    clientY: 20,
    screenX: 1820,
    screenY: 220,
  });
  let wheelPrevented = false;
  canvas.listeners.get('wheel')({
    clientX: 810,
    clientY: 60,
    buttons: 0,
    shiftKey: false,
    ctrlKey: false,
    preventDefault: () => {
      wheelPrevented = true;
    },
  });
  assert.equal(wheelPrevented, true);
  assert.deepEqual(graph.messages.take(), {
    target: 'main',
    message: 0x20a,
    wParam: 0x00780000,
    lParam: 0x00dc071c,
  });
  graph.domInput.refreshForeground();
  assert.equal(graph.input.foreground, true);
  assert.equal(canvas.listeners.has('keydown'), true);
  assert.equal(graph.host.showWindow(false), true);
  assert.equal(parent.style.visibility, 'hidden');
  assert.equal(graph.host.isForegroundWindow(), false);
  assert.equal(graph.input.foreground, false);
  assert.equal(graph.host.showWindow(true), true);
  assert.equal(parent.style.visibility, 'visible');
  assert.equal(graph.input.foreground, true);
  document.activeElement = document.createElement('outside');
  assert.equal(graph.host.isForegroundWindow(), false);
  document.activeElement = canvas;
  documentHasFocus = false;
  assert.equal(graph.host.isForegroundWindow(), false);
  documentHasFocus = true;
  assert.equal(graph.host.isForegroundWindow(), true);
  assert.equal(graph.clock.suspensionEnabled, false);
  graph.host.applySizeMenuTail(0, graph.input);
  assert.equal(graph.clock.suspensionEnabled, true);
  assert.equal(graph.clock.beginSuspension(false), false);
  graph.host.applySizeMenuTail(1, graph.input);
  assert.equal(graph.clock.suspensionEnabled, false);
  graph.host.applySizeMenuTail(0, graph.input);
  assert.equal(graph.clock.endSuspension(), false);
  assert.equal(graph.adapters.currentMonitor(), 1);
  graph.host.captureOuterRectangleBeforeMinimize();
  parent.rect = {left: 0, top: 0, right: 0, bottom: 0};
  assert.equal(graph.adapters.currentMonitor(), 1);
  assert.equal(graph.droppedFiles.files, graph.resource.files);

  const startup = graph.start({automatic: false});
  await assert.rejects(graph.start({automatic: false}), /already used/);
  await startup;
  assert.equal(graph.initialized.initialized, false);
  await assert.rejects(
    graph.sizeEffects.runInitializedMinimize(graph.allocator.currentActor),
    /initialized size effects require live shared channels and window/,
  );
  // The eventual complete C3900 owner publishes this bit; partial graph.start does not.
  graph.initialized.completeStartup(1, () => 1);
  try {
    const actor = graph.allocator.currentActor;
    const channels = graph.resource.channels;
    assert.equal(await channels.setPersistentMaster(true, 0, 37, actor), 1);
    assert.equal(await channels.setPersistentMaster(false, 127, 83, actor), 1);
    assert.equal(graph.input.inputActive, true);
    graph.clock.setPauseOption(1);
    const beforeMinimize = graph.clock.read();
    await graph.sizeEffects.runInitializedMinimize(actor);
    clockNow = 110;
    assert.equal(graph.clock.read(), beforeMinimize);
    assert.equal(channels.muted, 1);
    assert.equal(channels.streamMaster[0], 37);
    assert.equal(channels.staticMaster[127], 83);
    assert.equal(channels.stream[0].levels.master, 0);
    assert.equal(channels.static[127].levels.master, 0);
    assert.equal(graph.traditionalMovieAudio.rawSuppression, 1);
    assert.equal(graph.mfMovieVolume.savedVolume, 0);
    assert.equal(graph.input.inputActive, true);
    assert.equal(graph.input.iconic, 0);
    assert.equal(graph.input.scriptMinimizeLatch, 0);
    assert.equal(graph.clock.endSuspension(), true);
    const pointer = (value) => ({bytes: encode(value), offset: 0});
    const movie = await graph.prepareMovieDocument(
      null,
      pointer('movie.iso'),
      selectedMovie.length,
    );
    assert.equal(movie.actor, actor);
    assert.equal(movie.source.widePath, 'C:\\game\\movie.iso');
    assert.deepEqual([movie.source.offset, movie.source.length], [0, 0]);
    const track = movie.movie.tracks[0];
    assert.equal(track.handler, 'vide');
    assert.deepEqual(
      [...aokanaIsoSampleBytes(movie.movie, track, track.samples[0])],
      [...selectedSample],
    );
    assert.equal(
      await graph.resource.resources.archives.registerComplex(pointer('virtual'), [
        pointer('physical.arc'),
      ]),
      1,
    );
    const archived = await graph.prepareMovieDocument(
      pointer('virtual'),
      pointer('archived.iso'),
      archivedMovie.length,
    );
    assert.equal(archived.actor, actor);
    assert.equal(archived.source.widePath, 'c:\\game\\physical.arc');
    assert.deepEqual([archived.source.offset, archived.source.length], [275, archivedMovie.length]);
    assert.deepEqual(
      [
        ...aokanaIsoSampleBytes(
          archived.movie,
          archived.movie.tracks[0],
          archived.movie.tracks[0].samples[0],
        ),
      ],
      [...archivedSample],
    );
    const selected = await graph.prepareVideoOnlySource(
      pointer('virtual'),
      pointer('archived.iso'),
      archivedMovie.length,
      1,
    );
    assert.equal(selected.graph, graph);
    assert.equal(selected.document.actor, actor);
    assert.equal(selected.document.source.widePath, 'c:\\game\\physical.arc');
    assert.deepEqual(
      [selected.document.source.offset, selected.document.source.length],
      [275, archivedMovie.length],
    );
    assert.equal(selected.tracks.document, selected.document);
    assert.equal(selected.tracks.movie, selected.document.movie);
    assert.equal(selected.tracks.video.track.id, 1);
    assert.equal(selected.tracks.audio, null);
    assert.equal(selected.tracks.video.configurations.get(1).codec, 'avc1.64001f');
    assert.deepEqual([...selected.tracks.video.sampleBytes(0)], [...archivedSample]);
    assert.equal(selected.timeline.tracks, selected.tracks);
    assert.equal(selected.timeline.clock, selected.clock);
    assert.equal(selected.timeline.stopTime, 400000n);
    const priorTimeReads = hostTimeReads;
    selected.clock.now();
    assert.equal(hostTimeReads, priorTimeReads + 1);
    selected.dispose();
    assert.equal(graph.surfaces.record(0).movieId, -1);
    assert.equal(graph.movies.find(0), null);

    const output = {bytes: null},
      result = {value: 99};
    graph.resource.loading.enqueueOwned(output, result, null, encode('document'));
    assert.equal(await graph.resource.worker.processOne(), 'resource');
    assert.equal(result.value, 4);
    assert.deepEqual([...output.bytes], [11, 22, 33, 44]);

    graph.droppedFiles.setEnabled(1);
    let prevented = false;
    canvas.listeners.get('drop')({
      preventDefault() {
        prevented = true;
      },
      dataTransfer: {files: [new File(['dropped payload'], 'Demo.TXT')]},
    });
    assert.equal(prevented, true);
    assert.deepEqual(graph.notifications.take(), {type: 0x10, value1: 0, value2: 0});
    const droppedName = graph.text.decodeAuto({bytes: graph.droppedFiles.bytes, offset: 0});
    assert.equal(droppedName, 'D:\\Drops\\1\\Demo.TXT');
    const opened = await graph.resource.files.openWide(droppedName);
    assert.equal(opened.error, 0);
    assert.equal(
      new TextDecoder().decode(
        await graph.resource.files.read(opened.source, 0, opened.source.size),
      ),
      'dropped payload',
    );

    const child = graph.messages.createTarget();
    graph.messages.invalidate(child);
    graph.messages.post({target: 'main', message: 0x10, wParam: 0, lParam: 0});
    const close = graph.messages.takePostedEvent();
    assert.equal(close.kind, 'window');
    assert.equal(close.message.message, 0x10);
    graph.messages.dispatch(close.message);
    assert.equal(graph.callbacks.isReady(), false);
    assert.equal(graph.messages.mainTarget(), null);
    assert.equal(graph.host.showWindow(false), false);
    assert.equal(parent.style.visibility, 'visible');
    assert.equal(graph.host.isForegroundWindow(), false);
    assert.deepEqual(graph.messages.takePostedEvent(), {kind: 'quit', exitCode: 0});
    assert.equal(graph.messages.takePostedEvent(), null);
    assert.equal(graph.messages.take().target, child);
    const particle = graph.particles.create(16, 16);
    assert.equal(particle.result, 0);
    assert.equal(graph.particles.setRefreshInterval(particle.handle, 25), true);
    assert.equal(graph.particles.scheduleHead.handle, particle.handle);

    let releaseSelection;
    const selectionGate = new Promise((resolve) => {
      releaseSelection = resolve;
    });
    graph.movieSources.locate = async () => {
      await selectionGate;
      return null;
    };
    const preparing = graph.prepareMovieDocument(null, pointer('movie.iso'), selectedMovie.length);
    let shutdownComplete = false;
    const shutdown = graph.shutdown().then(() => {
      shutdownComplete = true;
    });
    try {
      await Promise.resolve();
      assert.equal(shutdownComplete, false);
    } finally {
      releaseSelection();
    }
    assert.equal(await preparing, null);
    await shutdown;
    assert.equal(shutdownComplete, true);
    await assert.rejects(
      graph.prepareMovieDocument(null, pointer('movie.iso'), selectedMovie.length),
      /closed/,
    );
  } finally {
    const closing = graph.shutdown();
    assert.equal(graph.initialized.initialized, false);
    await closing;
  }
  assert.equal(graph.particles.scheduleHead, null);
  assert.equal(graph.resource.worker.isRunning, false);
  assert.equal(graph.resource.channels.flags, 0);
  assert.equal(canvas.listeners.size, 0);
  await assert.rejects(graph.start({automatic: false}), /already used/);
});
