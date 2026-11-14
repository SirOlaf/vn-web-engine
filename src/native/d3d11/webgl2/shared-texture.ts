import type {ID3D11Texture2D} from '../contract.js';

/** UI wiring only: a retained, single-level color texture on the backend's shared GL context. */
export interface D3d11WebGl2TextureLease {
  readonly context: WebGL2RenderingContext;
  readonly texture: WebGLTexture;
  readonly width: number;
  readonly height: number;
  /** The compositor applies this explicit physical texture origin to native rows. */
  readonly rowOrigin: 'top' | 'bottom';
  /** Publish pending CPU transfers without a framebuffer readback. */
  prepare(): void;
  dispose(): void;
}

/** Backend integration service; separate from the native DLL's ABI and export revision. */
export interface D3d11WebGl2TextureSharing {
  acquireColorTexture(resource: ID3D11Texture2D): D3d11WebGl2TextureLease;
}
