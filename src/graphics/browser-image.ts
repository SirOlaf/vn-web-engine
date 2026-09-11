/** Browser-owned image codecs. No engine state, filesystem or third-party decoder. */
export async function decodeBrowserImage(
  bytes: Uint8Array,
  type: string,
): Promise<{width: number; height: number; pixels: Uint8Array}> {
  const blob = new Blob([bytes.slice().buffer], {type});
  // ImageBitmap disables profile conversion and premultiplication at decode.
  // Canvas readback is exact for opaque images; alpha images require a decoder
  // that exposes straight RGBA rather than a premultiplied round trip.
  if (typeof createImageBitmap !== 'function')
    throw new Error('Browser image decoder is unavailable; inject an image decoder for this host');
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
      context = canvas.getContext('2d', {willReadFrequently: true});
    if (!context) throw new Error('Image readback context unavailable');
    context.drawImage(bitmap, 0, 0);
    const pixels = new Uint8Array(context.getImageData(0, 0, bitmap.width, bitmap.height).data);
    let opaque = true;
    for (let i = 3; i < pixels.length; i += 4)
      if (pixels[i] !== 255) {
        opaque = false;
        break;
      }
    if (opaque) return {width: bitmap.width, height: bitmap.height, pixels};
    throw new Error('Transparent browser image decoding needs a verified straight-alpha path');
  } finally {
    bitmap.close();
  }
}
