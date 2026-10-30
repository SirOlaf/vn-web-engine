import {NativeLibraryLoader} from '../../src/platform/native-libraries.js';
import {
  D3D11,
  type D3d11Result,
  type IUnknown,
  type ID3D11Device,
  type ID3D11Texture2D,
} from '../../src/native/d3d11/contract.js';
import {
  d3d11WebGl2Library,
  type D3d11WebGl2TextureSharing,
  type D3d11WebGl2TextureLease,
} from '../../src/native/d3d11/library.js';
import {
  emoteDriverD3d11Library,
  extractEmoteX64ShaderBlobs,
} from '../../src/native/emotedriver/library.js';
import {GpuTextureImage, type SharedGpuImageTarget} from '../../src/graphics/gpu-texture-image.js';
import type {D3d11Surface} from '../../src/graphics/d3d11-surfaces.js';
import type {ArtemisNativeGraphics} from '../../src/engines/artemis/native-graphics.js';

function retire(actions: readonly (() => void)[]): void {
  const errors: unknown[] = [];
  for (const action of actions)
    try {
      action();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length) throw new AggregateError(errors, 'Native graphics retirement failed');
}
function owned<T extends IUnknown>(result: D3d11Result<T>): T {
  if (result.hr !== 0 || !result.value) {
    result.value?.release();
    throw new Error('Native graphics resource creation failed: ' + result.hr);
  }
  return result.value;
}

/** Read-only DLL preparation; no graphics context or synchronous export compiles Wasm here. */
export function prepareArtemisNativeGraphics(
  dll: Uint8Array,
): (target: SharedGpuImageTarget) => ArtemisNativeGraphics {
  const shaders = extractEmoteX64ShaderBlobs(dll);
  if (!shaders) throw new Error('Unsupported emotedriver.dll image');
  const emote = emoteDriverD3d11Library({shaders}),
    identity = emote.identities[0]!;
  return (target) => {
    const sharing = new WeakMap<ID3D11Device, D3d11WebGl2TextureSharing>();
    const libraries = new NativeLibraryLoader(
      [
        emote,
        d3d11WebGl2Library(() => target.sharedContext(), {
          deviceCreated: (device, service) => sharing.set(device, service),
        }),
      ],
      {
        locate: (fileName) => {
          const key = fileName.toLowerCase();
          return key === 'emotedriver.dll'
            ? identity
            : key === 'd3d11.dll'
              ? {kind: 'system', fileName: 'd3d11.dll'}
              : null;
        },
      },
    );
    const loaded = libraries.load('d3d11.dll');
    if (loaded.status !== 'loaded') {
      libraries.dispose();
      throw new Error('D3D11 library is unavailable');
    }
    const exports = loaded.library.exports(D3D11)!;
    const created = exports.d3d11CreateDevice(null, 1, 0, 0, null, 7);
    if (created.hr !== 0 || !created.device || !created.immediateContext) {
      libraries.dispose();
      throw new Error('D3D11 device creation failed: ' + created.hr);
    }
    const device = created.device,
      context = created.immediateContext,
      interop = sharing.get(device)!;
    const surfaces = new Set<D3d11Surface>();
    let closed = false;
    // The last disposed surface keeps its storage for the next surface of the same size:
    // a new large render target costs a synchronous GPU allocation in attachSharedImage.
    let idle: {
      readonly width: number;
      readonly height: number;
      readonly texture: ID3D11Texture2D;
      readonly view: D3d11Surface['view'];
      readonly lease: D3d11WebGl2TextureLease;
    } | null = null;
    const retireIdle = () => {
      const storage = idle;
      idle = null;
      if (storage)
        retire([
          () => storage.lease.dispose(),
          () => {
            storage.view.release();
          },
          () => {
            storage.texture.release();
          },
        ]);
    };
    return {
      libraries,
      graphics: {
        device,
        context,
        createSurface(width, height) {
          if (closed) throw new Error('Using released native graphics');
          if (idle && (idle.width !== width || idle.height !== height)) retireIdle();
          const reused = idle;
          idle = null;
          const texture = reused?.texture ?? owned(
            device.createTexture2D(
              {
                width,
                height,
                mipLevels: 1,
                arraySize: 1,
                format: 28,
                sampleDesc: {count: 1, quality: 0},
                usage: 0,
                bindFlags: 0x28,
                cpuAccessFlags: 0,
                miscFlags: 0,
              },
              null,
            ),
          );
          let view: D3d11Surface['view'] | null = reused?.view ?? null,
            lease: D3d11WebGl2TextureLease | null = reused?.lease ?? null;
          let image: GpuTextureImage | null = null;
          try {
            if (reused) context.clearRenderTargetView(reused.view, [0, 0, 0, 0]);
            view ??= owned(device.createRenderTargetView(texture, null));
            lease ??= interop.acquireColorTexture(texture);
            image = new GpuTextureImage(width, height, lease.rowOrigin);
            target.attachSharedImage(image, lease.context, lease.texture);
          } catch (error) {
            try {
              retire([
                () => {
                  if (image) target.invalidate(image);
                },
                () => lease?.dispose(),
                () => {
                  view?.release();
                },
                () => {
                  texture.release();
                },
              ]);
            } catch (cleanup) {
              throw new AggregateError([error, cleanup], 'Native surface construction failed');
            }
            throw error;
          }
          const boundImage = image,
            boundView = view,
            boundLease = lease;
          const value = {
            image: boundImage,
            view: boundView,
            prepare() {
              boundLease.prepare();
            },
            dispose() {
              if (!surfaces.delete(value)) return;
              if (!closed)
                try {
                  retire([() => target.invalidate(boundImage), retireIdle]);
                  idle = {width, height, texture, view: boundView, lease: boundLease};
                  return;
                } catch (error) {
                  try {
                    retire([
                      () => boundLease.dispose(),
                      () => {
                        boundView.release();
                      },
                      () => {
                        texture.release();
                      },
                    ]);
                  } catch (cleanup) {
                    throw new AggregateError([error, cleanup], 'Native surface retirement failed');
                  }
                  throw error;
                }
              retire([
                () => target.invalidate(boundImage),
                () => boundLease.dispose(),
                () => {
                  boundView.release();
                },
                () => {
                  texture.release();
                },
              ]);
            },
          };
          surfaces.add(value);
          return value;
        },
      },
      dispose() {
        if (closed) return;
        closed = true;
        retire(
          [...surfaces]
            .map((surface) => () => surface.dispose())
            .concat([
              retireIdle,
              () => context.clearState(),
              () => {
                context.release();
              },
              () => {
                device.release();
              },
              () => libraries.dispose(),
            ]),
        );
      },
    };
  };
}
