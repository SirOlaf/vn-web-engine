import {
  D3D_OK,
  D3DADAPTER_DEFAULT,
  D3DDEVTYPE_HAL,
  D3DERR_INVALIDCALL,
  D3DERR_NOTAVAILABLE,
  D3DFMT_D24S8,
  D3DFMT_R5G6B5,
  D3DFMT_X8R8G8B8,
  D3DRTYPE_TEXTURE,
  D3DUSAGE_DYNAMIC,
  D3DUSAGE_RENDERTARGET,
  type D3dDeviceWindow,
  type D3dPresentParameters,
  type D3dResult,
  type IDirect3DDevice9,
} from '../contract.js';
import {WebGl2Device, type DeviceParent, type WebGl2Adapter} from './device.js';
import {D3DFMT_X1R5G5B5, textureFormat} from './formats.js';

const D3DRTYPE_SURFACE = 1;
const D3DUSAGE_DEPTHSTENCIL = 2;
const displayFormats = new Set([D3DFMT_X8R8G8B8, D3DFMT_R5G6B5, D3DFMT_X1R5G5B5]);

/** `IDirect3D9` for one WebGL2 adapter. */
export class WebGl2Direct3D implements DeviceParent {
  private references = 1;

  constructor(readonly adapter: WebGl2Adapter) {}

  addRef(): number {
    return ++this.references;
  }

  release(): number {
    if (this.references === 0) return 0;
    return --this.references;
  }

  checkDeviceFormat(
    adapter: number,
    deviceType: number,
    adapterFormat: number,
    usage: number,
    resourceType: number,
    checkFormat: number,
  ): number {
    if (adapter !== D3DADAPTER_DEFAULT || !displayFormats.has(adapterFormat))
      return D3DERR_INVALIDCALL;
    if (deviceType !== D3DDEVTYPE_HAL) return D3DERR_NOTAVAILABLE;
    if (usage & D3DUSAGE_DEPTHSTENCIL)
      return checkFormat === D3DFMT_D24S8 && resourceType === D3DRTYPE_SURFACE
        ? D3D_OK
        : D3DERR_NOTAVAILABLE;
    if (resourceType !== D3DRTYPE_TEXTURE && resourceType !== D3DRTYPE_SURFACE)
      return D3DERR_NOTAVAILABLE;
    if (usage & ~(D3DUSAGE_RENDERTARGET | D3DUSAGE_DYNAMIC)) return D3DERR_NOTAVAILABLE;
    const format = textureFormat(checkFormat);
    if (!format) return D3DERR_NOTAVAILABLE;
    if (format.compressed && !this.adapter.s3tc) return D3DERR_NOTAVAILABLE;
    if (usage & D3DUSAGE_RENDERTARGET && !format.renderTarget) return D3DERR_NOTAVAILABLE;
    return D3D_OK;
  }

  createDevice(
    adapter: number,
    deviceType: number,
    window: D3dDeviceWindow,
    behaviorFlags: number,
    presentation: D3dPresentParameters,
  ): D3dResult<IDirect3DDevice9> {
    if (adapter !== D3DADAPTER_DEFAULT) return {hr: D3DERR_INVALIDCALL, value: null};
    if (deviceType !== D3DDEVTYPE_HAL) return {hr: D3DERR_NOTAVAILABLE, value: null};
    if (window.context.isContextLost()) return {hr: D3DERR_NOTAVAILABLE, value: null};
    if (!WebGl2Device.supports(window, presentation)) return {hr: D3DERR_NOTAVAILABLE, value: null};
    return {hr: D3D_OK, value: new WebGl2Device(this, window, presentation, behaviorFlags)};
  }
}
