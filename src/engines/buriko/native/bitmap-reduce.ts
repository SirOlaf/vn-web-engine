import {averageLanesCeil} from '../../../graphics/packed-pixels.js';
import {withBurikoBitmapText} from './bitmap-dom-text.js';
import {
  initializedBurikoBitmapView,
  writableBurikoBitmapView,
  type BurikoBitmap,
} from './bitmap.js';
import {bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';
import {tryBurikoBitmapReduceWasm} from './bitmap-alpha-wasm.js';

const average = averageLanesCeil;

/** Checked bulk access retains pair-before-store aliasing and marks only completed row bytes. */
function reduceInitialized(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  width: number,
  height: number,
  oddColumn: boolean,
  oddRow: boolean,
): boolean {
  // The scalar native row step is a signed 32-bit shift; unusual wrapped strides stay scalar.
  if (source.stride << 1 !== source.stride * 2) return false;
  const sourceView = initializedBurikoBitmapView(
      source,
      width * 2 + Number(oddColumn),
      height * 2 + Number(oddRow),
    ),
    destinationView = writableBurikoBitmapView(
      destination,
      width + Number(oddColumn),
      height + Number(oddRow),
    );
  if (sourceView === null || destinationView === null) return false;
  const sourceRowStep = source.stride << 1,
    writtenBytes = (width + Number(oddColumn)) * 4;
  if (
    tryBurikoBitmapReduceWasm(
      destination,
      source,
      destinationView,
      sourceView,
      width,
      height,
      oddColumn,
      oddRow,
    )
  ) {
    for (let y = 0; y < height + Number(oddRow); y++)
      destination.storage!.written(destination.offset + y * destination.stride, writtenBytes);
    return true;
  }
  for (let y = 0; y < height; y++) {
    const top = source.offset + y * sourceRowStep,
      bottom = top + source.stride,
      output = destination.offset + y * destination.stride;
    const reduce = (x: number): number =>
      average(
        average(
          sourceView.getUint32(top + x * 8, true),
          sourceView.getUint32(bottom + x * 8, true),
        ),
        average(
          sourceView.getUint32(top + x * 8 + 4, true),
          sourceView.getUint32(bottom + x * 8 + 4, true),
        ),
      );
    let x = 0;
    for (; x + 1 < width; x += 2) {
      const first = reduce(x),
        second = reduce(x + 1);
      destinationView.setUint32(output + x * 4, first, true);
      destinationView.setUint32(output + x * 4 + 4, second, true);
    }
    if (x < width) destinationView.setUint32(output + x * 4, reduce(x), true);
    if (oddColumn)
      destinationView.setUint32(
        output + width * 4,
        average(
          sourceView.getUint32(top + width * 8, true),
          sourceView.getUint32(bottom + width * 8, true),
        ),
        true,
      );
    destination.storage!.written(output, writtenBytes);
  }
  if (oddRow) {
    const input = source.offset + height * sourceRowStep,
      output = destination.offset + height * destination.stride;
    const reduce = (x: number): number =>
      average(
        sourceView.getUint32(input + x * 8, true),
        sourceView.getUint32(input + x * 8 + 4, true),
      );
    let x = 0;
    for (; x + 1 < width; x += 2) {
      const first = reduce(x),
        second = reduce(x + 1);
      destinationView.setUint32(output + x * 4, first, true);
      destinationView.setUint32(output + x * 4 + 4, second, true);
    }
    if (x < width) destinationView.setUint32(output + x * 4, reduce(x), true);
    if (oddColumn)
      destinationView.setUint32(
        output + width * 4,
        sourceView.getUint32(input + width * 8, true),
        true,
      );
    destination.storage!.written(output, writtenBytes);
  }
  return true;
}

/** 0549E0/053750: byte-wise PAVGB reduction, vertical pair before horizontal pair.
 * Odd column/row/corner writes follow the native available-destination tests;
 * untouched output padding retains its previous bytes. RGB's fourth byte is
 * averaged too, exactly like RGBA. No alpha-weighted resampling is substituted. */
function reduceBurikoBitmapHalfPixels(destination: BurikoBitmap, source: BurikoBitmap): void {
  if (destination.format !== source.format || (source.format !== 1 && source.format !== 2)) return;
  const width = Math.min(destination.width >>> 0, source.width >>> 1),
    height = Math.min(destination.height >>> 0, source.height >>> 1),
    oddColumn = (source.width & 1) !== 0 && (destination.width * 2) >>> 0 > source.width >>> 0,
    oddRow = (source.height & 1) !== 0 && (destination.height * 2) >>> 0 > source.height >>> 0;
  if (reduceInitialized(destination, source, width, height, oddColumn, oddRow)) return;
  const sourceRowStep = source.stride << 1;
  for (let y = 0; y < height; y++) {
    const top = source.offset + y * sourceRowStep,
      bottom = top + source.stride,
      output = destination.offset + y * destination.stride;
    const reduce = (x: number): number =>
      average(
        average(bitmapRead32(source, top + x * 8), bitmapRead32(source, bottom + x * 8)),
        average(bitmapRead32(source, top + x * 8 + 4), bitmapRead32(source, bottom + x * 8 + 4)),
      );
    let x = 0;
    for (; x + 1 < width; x += 2) {
      const first = reduce(x),
        second = reduce(x + 1);
      bitmapWrite32(destination, output + x * 4, first);
      bitmapWrite32(destination, output + x * 4 + 4, second);
    }
    if (x < width) bitmapWrite32(destination, output + x * 4, reduce(x));
    if (oddColumn)
      bitmapWrite32(
        destination,
        output + width * 4,
        average(bitmapRead32(source, top + width * 8), bitmapRead32(source, bottom + width * 8)),
      );
  }
  if (oddRow) {
    const input = source.offset + height * sourceRowStep,
      output = destination.offset + height * destination.stride;
    const reduce = (x: number): number =>
      average(bitmapRead32(source, input + x * 8), bitmapRead32(source, input + x * 8 + 4));
    let x = 0;
    for (; x + 1 < width; x += 2) {
      const first = reduce(x),
        second = reduce(x + 1);
      bitmapWrite32(destination, output + x * 4, first);
      bitmapWrite32(destination, output + x * 4 + 4, second);
    }
    if (x < width) bitmapWrite32(destination, output + x * 4, reduce(x));
    if (oddColumn)
      bitmapWrite32(destination, output + width * 4, bitmapRead32(source, input + width * 8));
  }
}

export const reduceBurikoBitmapHalf = withBurikoBitmapText(reduceBurikoBitmapHalfPixels, {
  replace: true,
  region: (args) => ({
    x: 0,
    y: 0,
    width: Math.min(args[0].width, Math.ceil(args[1].width / 2)),
    height: Math.min(args[0].height, Math.ceil(args[1].height / 2)),
  }),
  applied: (_, args) =>
    args[0].format === args[1].format && (args[1].format === 1 || args[1].format === 2),
  map: (x, y) => [x / 2, y / 2],
});
