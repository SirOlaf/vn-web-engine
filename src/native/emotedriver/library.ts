import type {NativeLibraryImplementation} from '../../platform/native-libraries.js';
import {EMOTE_PSB_KEYS} from '../../formats/kirikiri/psb-filter.js';
import {EMOTE_DRIVER, type EmoteDriverExports} from './contract.js';
import {EMOTEDRIVER_SHA256, PEmoteDevice, type EmotePlayerFactory} from './device.js';
import {emoteFilterTexture} from './filter-texture.js';
import {PEmotePlayer} from './player.js';
import {emoteClipFactory} from './runtime/clip.js';
import {createEmoteControls} from './runtime/controls/index.js';
import type {EmoteMeshKernel} from './runtime/interfaces.js';
import {createEmoteMeshKernel} from './runtime/mesh/index.js';
import {EmotePlayerCore} from './runtime/player-core.js';
import type {EmoteShaderBlobs} from './runtime/render/shaders.js';

export {extractEmoteShaderBlobs, type EmoteShaderBlobs} from './runtime/render/shaders.js';

export interface EmoteDriverLibraryOptions {
  /**
   * Compiled shaders of the build, read from the installation's `emotedriver.dll` with
   * `extractEmoteShaderBlobs`. Null runs the device at shader level 0 (fixed function), as
   * the native device does when shaders cannot be created.
   */
  readonly shaders: EmoteShaderBlobs | null;
  /** Mesh kernel; default the Wasm kernel (TypeScript twin when WebAssembly is unavailable). */
  readonly kernel?: EmoteMeshKernel;
}

/**
 * `emotedriver.dll` (SHA-256 `a3b693b6…5e70b3a86`). The library imports nothing the loader
 * resolves: the Direct3D device arrives through `EmoteCreate`'s `InitParam`, and the D3DX
 * math it imports is part of the implementation.
 */
export function emoteDriverLibrary(
  options: EmoteDriverLibraryOptions,
): NativeLibraryImplementation<EmoteDriverExports> {
  return {
    contract: EMOTE_DRIVER,
    identities: [{kind: 'image', sha256: EMOTEDRIVER_SHA256}],
    imports: [],
    link() {
      const kernel = options.kernel ?? createEmoteMeshKernel();
      // PEmotePlayer ctor 0x10001880: the core is built on the last motion file; clips resolve
      // atlas textures through the player's renderer.
      const createPlayer: EmotePlayerFactory = (_device, model, _count, {renderer}) => {
        const core = new EmotePlayerCore({
          model,
          createClip: emoteClipFactory(model, {
            kernel,
            textureIndexOf: (source) => renderer.textureIndexOf(source),
          }),
          createControls: createEmoteControls,
        });
        return new PEmotePlayer(core, renderer, renderer);
      };
      const key = EMOTE_PSB_KEYS.get(EMOTEDRIVER_SHA256)!;
      return {
        exports: {
          emoteCreate: (param) => new PEmoteDevice(param, createPlayer, options.shaders),
          emoteFilterTexture: (data, filter) => emoteFilterTexture(data, key, filter),
        },
      };
    },
  };
}
