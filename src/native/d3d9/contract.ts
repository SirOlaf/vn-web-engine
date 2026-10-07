/** HRESULT values returned through the device contract. */
export const D3D_OK = 0;
export const D3DERR_DEVICELOST = 0x88760868 | 0;
export const D3DERR_DEVICENOTRESET = 0x88760869 | 0;

/**
 * `IDirect3DDevice9`. Members are added as client libraries are lifted; each one keeps its
 * COM slot number. A device is shared by every library that receives it (the compositor
 * that created it and the runtimes it hands it to), so all of them draw into one context.
 * The `d3d9.dll` export contract (`Direct3DCreate9`) is defined with the compositor.
 */
export interface IDirect3DDevice9 {
  /** Slot 1. */
  addRef(): number;
  /** Slot 2. */
  release(): number;
  /** Slot 3. `D3D_OK`, `D3DERR_DEVICELOST` or `D3DERR_DEVICENOTRESET`. */
  testCooperativeLevel(): number;
}
