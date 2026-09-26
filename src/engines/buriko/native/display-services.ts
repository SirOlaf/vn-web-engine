import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import type {BurikoDisplayController} from './display-controller.js';
import type {BurikoNativeDisplayState} from './display-state.js';
import {normalizeBurikoAsciiSpaces} from './byte-string-spaces.js';
import {writeText} from './text.js';

/** B3000 uses the cached primary-adapter identifier, without querying another monitor. */
export function readBurikoDisplayAdapter(
  display: BurikoNativeDisplayState,
  description: BurikoBpPointer,
  version: BurikoBpPointer,
): void {
  const bytes = normalizeBurikoAsciiSpaces({bytes: display.adapterIdentifier, offset: 0x200});
  writeText(description, Uint8Array.of(...bytes, 0));
  const identifier = new DataView(
    display.adapterIdentifier.buffer,
    display.adapterIdentifier.byteOffset,
    display.adapterIdentifier.byteLength,
  );
  for (const [index, offset] of [0x426, 0x424, 0x422, 0x420].entries())
    pointerView({bytes: version.bytes, offset: version.offset + index * 4}, 4).setUint32(
      0,
      identifier.getUint16(offset, true),
      true,
    );
}

/** B2C70 writes client size and the preset latch before optionally rebuilding the windowed device. */
export async function setBurikoRequestedClientSize(
  controller: BurikoDisplayController,
  width: number,
  height: number,
  position: readonly [number, number] | null,
): Promise<void> {
  const display = controller.display;
  width >>>= 0;
  height >>>= 0;
  const usePreset = Number(width === 0 || height === 0);
  if (usePreset !== 0) {
    width = display.logicalWidth;
    height = display.logicalHeight;
  }
  display.requestedWidth = width; // B2D00.
  display.requestedHeight = height;
  display.useSizePreset = usePreset; // B6E70.
  if (controller.device.fullscreen === 0) {
    const format = display.selectedWindowParameter,
      preset = display.selectedSizePreset;
    await controller.reconfigure(preset, format, 0, position, 0);
  }
}
