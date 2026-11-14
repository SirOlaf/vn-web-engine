// A whole ArtemisRuntime over an in-memory synthetic installation and the nonvisual tool
// fixtures (metadata layers, glyph layout, surface preload, offline sound). No game data.
import {ArtemisRuntime} from '../dist/engines/artemis/runtime.js';
import {ARTEMIS_3179_EXECUTABLE_SHA256} from '../dist/engines/artemis/revision.js';
import {BrowserWindowsDynamicLibraryHost} from '../dist/platform/windows-dynamic-library.js';
import {createMetadataLayerFixture} from '../tools/artemis-metadata-layer-fixture.mjs';
import {createArtemisGlyphLayoutFixture} from '../tools/artemis-glyph-layout-fixture.mjs';
import {createArtemisSurfacePreloadFixture} from '../tools/artemis-surface-preload-fixture.mjs';
import {createArtemisOfflineSoundFixture} from '../tools/artemis-offline-sound-fixture.mjs';

const encode = (text) => new TextEncoder().encode(text);

/** `files` maps lowercase installation paths to text or bytes; system.ini defaults to a
 * 640x360 window that boots system/first.iet. `services` overrides runtime services.
 * `savedFiles` seeds independent byte copies for a fresh runtime; `close` releases
 * the runtime and the fixture workers. */
export async function openArtemisRuntimeFixture(
  files,
  {
    hash = ARTEMIS_3179_EXECUTABLE_SHA256,
    services = {},
    savedFiles = {},
    glyphsOverrides = {},
  } = {},
) {
  const entries = new Map(
    Object.entries({
      'system.ini': '[WINDOWS]\nWIDTH=640\nHEIGHT=360\nBOOT=system/first.iet\n',
      ...files,
    }).map(([path, data]) => [path, typeof data === 'string' ? encode(data) : data]),
  );
  const saves = new Map(Object.entries(savedFiles).map(([name, bytes]) => [name, bytes.slice()])),
    effects = [];
  const read = async (path) => entries.get(path) ?? null;
  const sound = createArtemisOfflineSoundFixture(hash, read),
    glyphs = createArtemisGlyphLayoutFixture(hash, read),
    surfaces = createArtemisSurfacePreloadFixture(hash, read);
  let runtime;
  try {
    runtime = await ArtemisRuntime.open({
      executableSha256: hash,
      files: {
        read,
        readPlain: read,
        resolvePath: (path) => path.replace(/\\/g, '/').toLowerCase(),
        setMagicPath: () => {},
        paths: new Set(entries.keys()),
      },
      storage: {
        read: async (name) => saves.get(name) ?? null,
        write: (name, bytes) => void saves.set(name, bytes),
        delete: (name) => void saves.delete(name),
      },
      randomSeed: 0,
      createLayers: (host) => createMetadataLayerFixture(hash, read, host, true),
      glyphs: {...glyphs, ...glyphsOverrides},
      surfaces: surfaces.manager,
      sound,
      moviePlayer: {playing: false, play: async () => false, close() {}},
      dialogs: {present: () => {}},
      window: {
        minimized: () => false,
        show: () => {},
        toggleFullscreen: () => {},
        displayModeChanged: () => {},
      },
      caption: {setCaption: () => true},
      cursor: {setVisible: () => {}, setPosition: () => {}},
      pointer: {readPointerPosition: () => ({x: 0, y: 0})},
      dynamicLibraries: new BrowserWindowsDynamicLibraryHost(),
      windowsVersion: () => ({major: 10, minor: 0}),
      applyVolumes: () => {},
      setTouchLimit: () => {},
      reportError: () => {},
      trace: {effect: (effect) => effects.push(effect)},
      ...services,
    });
  } catch (error) {
    await Promise.allSettled([glyphs.close(), surfaces.close(), sound.close()]);
    throw error;
  }
  const close = async () => {
    runtime.close();
    await glyphs.close();
    await surfaces.close();
    await sound.close();
  };
  return {runtime, sound, saves, effects, close};
}
