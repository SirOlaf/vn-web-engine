/** Project-level GDI+ bitmap boundary. Browser and desktop hosts may implement
 * this against different codecs; callers still observe native pixel formats,
 * signed LockBits stride, and the installed encoder inventory. */
export interface WindowsGdiLockedBitmap {
  readonly bytes: Uint8Array;
  readonly scan0Offset: number;
  readonly stride: number;
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: number;
}

export interface WindowsGdiDecodedBitmap {
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: number;
  lockBits(pixelFormat: number): WindowsGdiLockedBitmap | null;
  dispose(): void;
}

export interface WindowsGdiEncoder {
  readonly mime: string;
  /** Opaque encoder identity retained from enumeration order. */
  readonly id: string;
}

export interface WindowsGdiScan0Bitmap {
  readonly bytes: Uint8Array;
  readonly scan0Offset: number;
  readonly scan0Stride: number;
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: number;
}

export interface WindowsGdiImageCodecHost {
  decode(bytes: Uint8Array): Promise<WindowsGdiDecodedBitmap | null>;
  encoders(): readonly WindowsGdiEncoder[];
  /** Null represents GdipSaveImageToFile failure; quality is raw GDI+ DWORD. */
  encode(
    source: WindowsGdiScan0Bitmap,
    encoder: WindowsGdiEncoder,
    quality: number | null,
  ): Promise<Uint8Array | null>;
}
