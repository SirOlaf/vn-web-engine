import type {
  IUnknown,
  ID3D11Resource,
  ID3D11Texture2D,
  ID3D11RenderTargetView,
  ID3D11DepthStencilView,
} from '../../../d3d11/contract.js';
import type {EmoteD3d11RenderTarget} from './renderer-d3d11.js';

/**
 * External MRenderTarget (0x18005b2e0 / 0x18005ec10), exact DLL SHA-256
 * 80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051.
 * Owns references to the compositor's views and resources. Installing the target
 * does not change native context bindings or clear any pixels.
 */
export class EmoteD3d11Target {
  private readonly owned: IUnknown[] = [];
  private readonly value: EmoteD3d11RenderTarget;
  private closed = false;

  constructor(color: ID3D11RenderTargetView, depth: ID3D11DepthStencilView | null) {
    try {
      const texture = this.texture(color.getResource());
      const desc = texture.getDesc();
      this.retain(color);
      if (depth) {
        this.texture(depth.getResource());
        this.retain(depth);
      }
      // Native SetRenderTarget reads the underlying resource's base dimensions,
      // not the RTV mip dimensions. Destination copies also use subresource0.
      this.value = {
        texture,
        view: color,
        depth,
        width: desc.width,
        height: desc.height,
        subresource: 0,
      };
    } catch (error) {
      try {
        this.dispose();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'E-mote target construction and cleanup failed');
      }
      throw error;
    }
  }

  /** Borrowed by the draw pass until the target owner is disposed. */
  get binding(): EmoteD3d11RenderTarget {
    if (this.closed) throw new Error('Using a released E-mote target');
    return this.value;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    for (const object of this.owned.splice(0).reverse())
      try {
        object.release();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length) throw new AggregateError(errors, 'E-mote target retirement failed');
  }

  private texture(resource: ID3D11Resource): ID3D11Texture2D {
    // GetResource already transfers one owned reference; no implementation cast.
    this.owned.push(resource);
    if (resource.getType() !== 3)
      throw new TypeError('E-mote target requires a Texture2D resource');
    return resource as ID3D11Texture2D;
  }

  private retain(object: IUnknown): void {
    object.addRef();
    this.owned.push(object);
  }
}
