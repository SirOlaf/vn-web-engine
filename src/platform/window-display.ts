/** Native window geometry; the platform chooses how to present it on the host. */
export interface WindowDisplayGeometry {
  readonly width: number;
  readonly height: number;
  readonly fullscreen: boolean;
}

export interface WindowDisplayHost {
  configure(geometry: WindowDisplayGeometry): void;
  setPosition(x: number, y: number): void;
}

export interface ViewportScreenMapping {
  readonly originX: number;
  readonly originY: number;
  readonly nativePixelsPerCssX: number;
  readonly nativePixelsPerCssY: number;
}
