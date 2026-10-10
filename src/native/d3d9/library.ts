import type {NativeLibraryImplementation} from '../../platform/native-libraries.js';
import {D3D9, D3D_SDK_VERSION, type D3d9Exports} from './contract.js';
import type {WebGl2Adapter} from './webgl2/device.js';
import {WebGl2Direct3D} from './webgl2/direct3d.js';

export {describeWebGl2Adapter, type WebGl2Adapter} from './webgl2/device.js';

/** `D3D_SDK_VERSION` values `Direct3DCreate9` accepts (9.0c and 9.0b headers). */
const sdkVersions = new Set([D3D_SDK_VERSION, 31]);
const D3D_DEBUG_SDK_BIT = 0x80000000;

/**
 * `d3d9.dll` on WebGL2. `adapter` describes the WebGL2 implementation (probe it with
 * `describeWebGl2Adapter` on the context the compositor will hand to `createDevice`), so
 * `IDirect3D9` answers format queries before a device exists.
 */
export function d3d9WebGl2Library(
  adapter: WebGl2Adapter,
): NativeLibraryImplementation<D3d9Exports> {
  return {
    contract: D3D9,
    identities: [{kind: 'system', fileName: 'd3d9.dll'}],
    imports: [],
    link: () => ({
      exports: {
        direct3DCreate9: (sdkVersion) =>
          sdkVersions.has((sdkVersion & ~D3D_DEBUG_SDK_BIT) >>> 0)
            ? new WebGl2Direct3D(adapter)
            : null,
      },
    }),
  };
}
