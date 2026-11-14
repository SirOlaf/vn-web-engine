/** Byte layout only; interpretation, conversion and format support belong to the device. */
export interface DxgiLayout {
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly blockBytes: number;
  readonly depth: boolean;
}

/** Typed formats used by the D3D11 texture path (DXGI_FORMAT values). */
export function dxgiLayout(format: number): DxgiLayout | null {
  switch (format) {
    case 28: // R8G8B8A8_UNORM
    case 87: // B8G8R8A8_UNORM
      return {blockWidth: 1, blockHeight: 1, blockBytes: 4, depth: false};
    case 40: // D32_FLOAT
    case 45: // D24_UNORM_S8_UINT
      return {blockWidth: 1, blockHeight: 1, blockBytes: 4, depth: true};
    case 49: // R8G8_UNORM
      return {blockWidth: 1, blockHeight: 1, blockBytes: 2, depth: false};
    case 61: // R8_UNORM
    case 65: // A8_UNORM
      return {blockWidth: 1, blockHeight: 1, blockBytes: 1, depth: false};
    case 71: // BC1_UNORM
      return {blockWidth: 4, blockHeight: 4, blockBytes: 8, depth: false};
    case 74: // BC2_UNORM
    case 77: // BC3_UNORM
    case 98: // BC7_UNORM
      return {blockWidth: 4, blockHeight: 4, blockBytes: 16, depth: false};
    default:
      return null;
  }
}
