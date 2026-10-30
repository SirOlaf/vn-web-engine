import type {NativeLibraryLoader} from '../../platform/native-libraries.js';
import type {D3d11SurfaceHost} from '../../graphics/d3d11-surfaces.js';

/** Process library table and GPU resources selected by UI wiring for this player. */
export interface ArtemisNativeGraphics {
  readonly libraries: NativeLibraryLoader;
  readonly graphics: D3d11SurfaceHost;
  dispose(): void;
}
