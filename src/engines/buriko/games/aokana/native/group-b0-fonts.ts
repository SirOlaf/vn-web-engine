import type {AokanaBpPointer} from '../bp/memory.js';
import {pop32, push32} from '../bp/state.js';
import type {
  AokanaBpOpcodeContext,
  AokanaBpOpcodeHandler,
  AokanaNativeSlotDefinition,
} from './types.js';
import {AokanaFontResources} from './font-resources.js';
import {AokanaNativeLanguage} from './group-81-language.js';
import {copyText, textBytes} from './text.js';
import {writePropertyWord} from './property-values.js';

function pointer(h: AokanaBpOpcodeContext): AokanaBpPointer | null {
  return h.memory.resolve(h.thread, pop32(h.thread));
}
function required(value: AokanaBpPointer | null): AokanaBpPointer {
  if (value === null) throw new Error('Aokana font service dereferences a null native string');
  return value;
}
function nullableBytes(value: AokanaBpPointer | null): Uint8Array | null {
  return value === null ? null : textBytes(value);
}

/** B0 C0–C8/CF own font-name registration, resource loading and host enumeration. */
export function createGroupB0Fonts(
  resources: AokanaFontResources,
  language: AokanaNativeLanguage,
): AokanaNativeSlotDefinition[] {
  const fonts = resources.fonts;
  const japanese = (): boolean => (language.value & 0x3ff) === 0x11;
  const definitions: AokanaNativeSlotDefinition[] = [];
  const add = (
    secondary: number,
    nativeAddress: number,
    name: string,
    execute: AokanaBpOpcodeHandler,
  ): void => {
    definitions.push({primary: 0xb0, secondary, nativeAddress, name, execute});
  };
  const enumerate = async (h: AokanaBpOpcodeContext, charset: number): Promise<0> => {
    const output = pointer(h);
    const result = await resources.enumerate(charset, japanese());
    if (output === null) push32(h.thread, result.byteCount);
    else {
      let offset = output.offset;
      for (const name of result.names) {
        copyText({bytes: output.bytes, offset}, {bytes: name, offset: 0});
        offset += name.length;
      }
      push32(h.thread, result.names.length);
    }
    return 0;
  };
  add(0xc0, 0x1400d41c0, 'RegisterFontName', (h) => {
    push32(h.thread, fonts.registerName(textBytes(required(pointer(h))), -1));
    return 0;
  });
  add(0xc1, 0x1400d4170, 'RegisterFontNameWithCharset', (h) => {
    const charset = pop32(h.thread),
      name = pointer(h);
    push32(h.thread, fonts.registerName(textBytes(required(name)), charset));
    return 0;
  });
  add(0xc2, 0x1400d4130, 'LoadFontFile', async (h): Promise<0> => {
    push32(h.thread, Number((await resources.load(null, textBytes(required(pointer(h))))) === 0));
    return 0;
  });
  add(0xc3, 0x1400d40e0, 'LoadFontResource', async (h): Promise<0> => {
    const name = pointer(h),
      archive = pointer(h);
    // The lower routine decodes and keys the filename before consulting the archive.
    const filename = textBytes(required(name));
    push32(
      h.thread,
      Number(
        (await resources.load(archive === null ? null : () => textBytes(archive), filename)) === 0,
      ),
    );
    return 0;
  });
  add(0xc4, 0x1400d40a0, 'EnumerateJapaneseFontNames', (h) => enumerate(h, 128));
  add(0xc5, 0x1400d4050, 'EnumerateFontNames', (h) => enumerate(h, pop32(h.thread)));
  add(0xc6, 0x1400d4000, 'QueryFontPitch', async (h): Promise<0> => {
    const name = pointer(h),
      output = pointer(h);
    const pitch = await fonts.browser.queryPitch(fonts.text.decodeAuto(required(name)));
    if (pitch !== null) writePropertyWord(output, pitch);
    push32(h.thread, Number(pitch !== null));
    return 0;
  });
  add(0xc7, 0x1400d3fc0, 'SetFontFallback', (h) => {
    const fallback = pointer(h),
      name = pointer(h);
    fonts.setFallback(nullableBytes(name), nullableBytes(fallback));
    return 0;
  });
  add(0xc8, 0x1400d3f80, 'SetFontAlias', (h) => {
    const alias = pointer(h),
      name = pointer(h);
    fonts.setAlias(textBytes(required(name)), nullableBytes(alias));
    return 0;
  });
  add(0xcf, 0x1400d3f60, 'ResetFontResources', () => {
    resources.reset(true, japanese());
    return 0;
  });
  return definitions;
}
