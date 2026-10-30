import type {NativeLibraryImplementation} from '../../platform/native-libraries.js';
import {D3D11, D3D11_SDK_VERSION, type D3d11Exports, type ID3D11Device} from './contract.js';
import {WebGl2D3d11Device} from './webgl2/device.js';
import {D3d11TextureError} from './webgl2/textures.js';
import type {D3d11WebGl2TextureSharing} from './webgl2/shared-texture.js';

export type {D3d11WebGl2TextureSharing, D3d11WebGl2TextureLease} from './webgl2/shared-texture.js';

export interface D3d11WebGl2LibraryOptions {
  /** UI wiring receives borrowed interfaces and the backend's texture-sharing service. */
  readonly deviceCreated?: (device: ID3D11Device, sharing: D3d11WebGl2TextureSharing) => void;
}

/** UI wiring supplies a prepared GL context; native exports keep their SDK arguments. */
export function d3d11WebGl2Library(
  createContext: () => WebGL2RenderingContext | null,
  options: D3d11WebGl2LibraryOptions = {},
): NativeLibraryImplementation<D3d11Exports> {
  return {
    contract: D3D11,
    identities: [{kind: 'system', fileName: 'd3d11.dll'}],
    imports: [],
    link: () => ({
      exports: {
        d3d11CreateDevice(adapter, driverType, software, flags, featureLevels, sdkVersion) {
          const fail = (hr: number) => ({
            hr,
            device: null,
            featureLevel: 0,
            immediateContext: null,
          });
          if (
            sdkVersion !== D3D11_SDK_VERSION ||
            !Number.isInteger(driverType) ||
            driverType < 0 ||
            driverType > 5 ||
            !Number.isInteger(flags) ||
            flags < 0 ||
            flags > 0xffffffff ||
            !Number.isSafeInteger(software) ||
            software < 0 ||
            (adapter !== null && driverType !== 0) ||
            (adapter === null && driverType === 0) ||
            (driverType === 4 ? software === 0 : software !== 0) ||
            (featureLevels !== null &&
              (!featureLevels.length ||
                featureLevels.some(
                  (level) => ![0xb000, 0xa100, 0xa000, 0x9300, 0x9200, 0x9100].includes(level),
                )))
          )
            return fail(0x80070057 | 0);
          if (flags & 2) return fail(0x887a002d | 0); // No native SDK debug layer is installed here.
          if (adapter !== null || driverType !== 1 || flags & ~(1 | 8 | 0x20 | 0x80))
            return fail(0x80004001 | 0);
          const level = (featureLevels ?? [0xb000, 0xa100, 0xa000]).find((level) =>
            [0xb000, 0xa100, 0xa000].includes(level),
          );
          if (level === undefined) return fail(0x887a0004 | 0);
          try {
            const gl = createContext();
            if (!gl) return fail(0x887a0004 | 0);
            if (gl.isContextLost()) return fail(0x887a0005 | 0);
            const device = new WebGl2D3d11Device(gl, flags, level);
            try {
              options.deviceCreated?.(device, device);
            } catch (error) {
              try {
                device.context.release();
              } finally {
                device.release();
              }
              throw error;
            }
            return {hr: 0, device, featureLevel: level, immediateContext: device.context};
          } catch (error) {
            return fail(
              error instanceof D3d11TextureError
                ? error.hr
                : error instanceof RangeError
                  ? 0x8007000e | 0
                  : 0x80004005 | 0,
            );
          }
        },
      },
    }),
  };
}
