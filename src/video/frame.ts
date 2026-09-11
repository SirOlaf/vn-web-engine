/** Planar 4:2:0, including macroblock padding; display uses width/height only. */
export interface YuvFrame {
  alpha?: Uint8Array;
  width: number;
  height: number;
  stride: number;
  paddedHeight: number;
  y: Uint8Array;
  cb: Uint8Array;
  cr: Uint8Array;
  index: number;
  pictureType: number;
  temporalReference: number;
}
export function allocateFrame(width: number, height: number): YuvFrame {
  const stride = Math.ceil(width / 16) * 16,
    paddedHeight = Math.ceil(height / 16) * 16,
    size = stride * paddedHeight;
  return {
    width,
    height,
    stride,
    paddedHeight,
    y: new Uint8Array(size),
    cb: new Uint8Array(size / 4),
    cr: new Uint8Array(size / 4),
    index: -1,
    pictureType: 0,
    temporalReference: 0,
  };
}
