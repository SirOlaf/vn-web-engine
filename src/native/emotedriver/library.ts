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
import {EMOTE_DRIVER_D3D11, type EmoteDriverD3d11Exports} from './contract.js';
import {EMOTEDRIVER_X64_SHA256} from './build.js';
import {PEmoteD3d11Device} from './device-d3d11.js';
import {EmoteD3d11MaskState} from './runtime/render/d3d11-mask-state.js';
import type {EmoteX64MeshKernel} from './runtime/interfaces.js';
import type {EmoteX64ShaderBlobs} from './runtime/render/shaders.js';

export {extractEmoteShaderBlobs, type EmoteShaderBlobs} from './runtime/render/shaders.js';
export {extractEmoteX64ShaderBlobs, type EmoteX64ShaderBlobs} from './runtime/render/shaders.js';

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

export interface EmoteDriverD3d11LibraryOptions {
  /** Exact-image DXBC blobs/reflection, extracted before library registration. */
  readonly shaders: EmoteX64ShaderBlobs;
  /** Prepared x64 kernel. The default is prepared here, outside synchronous native exports. */
  readonly kernel?: EmoteX64MeshKernel;
}

/** Native x64 export assembly through the existing loader and revision2 contract. */
export function emoteDriverD3d11Library(
  options: EmoteDriverD3d11LibraryOptions,
): NativeLibraryImplementation<EmoteDriverD3d11Exports> {
  const kernel = options.kernel ?? createEmoteMeshKernel({driverSha256: EMOTEDRIVER_X64_SHA256});
  return {
    contract: EMOTE_DRIVER_D3D11,
    identities: [{kind: 'image', sha256: EMOTEDRIVER_X64_SHA256}],
    imports: [],
    link: () => {
      const masks = new EmoteD3d11MaskState();
      return {
        exports: {
          emoteCreate: (param) => new PEmoteD3d11Device(param, options.shaders, kernel, masks),
          // Native0x180004130/4120 metadata; neither string selects implementation behavior.
          emoteGetSDKVersion: () => '3.9.8',
          emoteGetBuildDateTime: () => '2022/12/28-13:02:35',
        },
      };
    },
  };
}
