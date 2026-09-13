import {AokanaDisplayAdapters, type AokanaAdapterDesktopMode} from './display-adapters.js';
import {AokanaDisplayDevice} from './display-device.js';

export interface AokanaDisplayCapabilitiesRecord {
  caps: number;
  caps2: number;
  pixelShaderVersion: number;
}
const NOT_AVAILABLE = 0x8876086a;

/** Concrete software implementation of the IDirect3D9 operations used by B11F0.
 * Native HAL requests select this title's implemented canvas device. Its mutable
 * 21/22 textures supply DYNAMICTEXTURES; the browser has no physical raster query.
 * Adapter identity and the title-visible shader-version gate are explicit host
 * records, rather than a fabricated claim about the browser's physical GPU. */
export class AokanaDisplayCapabilities {
  private active = false; // The one 1e6ae8 interface owner, distinct from the device.
  constructor(
    readonly device: AokanaDisplayDevice,
    readonly adapters: AokanaDisplayAdapters,
  ) {
    if (device.adapter !== adapters)
      throw new Error('Aokana capability queries require the actual device adapter owner');
  }
  /** Direct3DCreate9(32) in the configured software profile. */
  create(): boolean {
    this.active = typeof this.device.canvas.getContext === 'function';
    return this.active;
  }
  isPresent(): boolean {
    return this.active;
  }
  /** B11B0 releases shader/device resources before the interface itself. */
  release(): void {
    this.device.release();
    this.active = false;
  }
  readMode(adapter: number, output: AokanaAdapterDesktopMode | null): boolean {
    return this.active && this.adapters.queryAdapterMode(adapter, output);
  }
  readIdentifier(adapter: number, output: Uint8Array): boolean {
    if (!this.active) return false;
    const identifier = this.adapters.records[adapter >>> 0]?.identifier;
    if (identifier === undefined) return false;
    if (output.length < 0x450)
      throw new RangeError('Aokana adapter identifier output is shorter than the native record');
    output.set(identifier);
    return true;
  }
  readCapabilities(adapter: number, deviceType: number, output: AokanaDisplayCapabilitiesRecord): number {
    const record = this.adapters.records[adapter >>> 0];
    if (!this.active || record === undefined || (deviceType >>> 0) !== 1) return NOT_AVAILABLE;
    output.caps = this.device.rasterStatusAvailable ? 0x20000 : 0;
    output.caps2 = 0x20000000;
    output.pixelShaderVersion = record.pixelShaderVersion >>> 0;
    return 0;
  }
  checkDeviceType(adapter: number, deviceType: number, displayFormat: number, backBufferFormat: number, windowed: number): number {
    return this.active && this.adapters.records[adapter >>> 0] !== undefined &&
      (deviceType >>> 0) === 1 && (displayFormat >>> 0) === 22 && (backBufferFormat >>> 0) === 22 &&
      ((windowed >>> 0) === 0 || (windowed >>> 0) === 1) ? 0 : NOT_AVAILABLE;
  }
  checkDeviceFormat(adapter: number, deviceType: number, adapterFormat: number, usage: number, resourceType: number, format: number): number {
    return this.active && this.adapters.records[adapter >>> 0] !== undefined &&
      (deviceType >>> 0) === 1 && (adapterFormat >>> 0) === 22 &&
      ((usage >>> 0) === 0 || (usage >>> 0) === 0x200) && (resourceType >>> 0) === 3 &&
      ((format >>> 0) === 21 || (format >>> 0) === 22) ? 0 : NOT_AVAILABLE;
  }
}
