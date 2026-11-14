import type {
  ID3D11Device,
  ID3D11DeviceContext,
  ID3D11RenderTargetView,
} from '../native/d3d11/contract.js';
import type {TriangleImage} from './triangle-draw.js';

/** One owned native target together with the compositor's view of the same GPU allocation. */
export interface D3d11Surface {
  readonly image: TriangleImage;
  /** Borrowed until disposal; native setters acquire their own references. */
  readonly view: ID3D11RenderTargetView;
  /** Publish native transfers before the compositor samples this image. */
  prepare(): void;
  dispose(): void;
}

/** Supplied by UI backend registration. No renderer or backend implementation crosses it. */
export interface D3d11SurfaceHost {
  readonly device: ID3D11Device;
  readonly context: ID3D11DeviceContext;
  createSurface(width: number, height: number): D3d11Surface;
}
