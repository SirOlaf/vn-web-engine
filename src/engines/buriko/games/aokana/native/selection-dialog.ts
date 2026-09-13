import type {AokanaBpPointer} from '../bp/memory.js';
import {AokanaEngineDialogs} from './engine-dialogs.js';
import {AokanaFontResources} from './font-resources.js';
import {AokanaNativeText, textByte, textBytes, writeText} from './text.js';

/** 1400b0c40 and callback 1400ae920, shared by the native list picker and font chooser. */
export class AokanaSelectionDialog {
  constructor(
    readonly dialogs: AokanaEngineDialogs,
    readonly text: AokanaNativeText,
  ) {}

  select(
    output: AokanaBpPointer | null,
    title: AokanaBpPointer | null,
    prompt: AokanaBpPointer | null,
    list: AokanaBpPointer | null,
  ): Promise<0 | 1> {
    return this.dialogs.withNativeModal(async () => {
      const caption = title === null ? '一覧からの選択' : this.text.decodeAuto(title);
      const message = prompt === null ? '項目を一つ選択して下さい' : this.text.decodeAuto(prompt);
      if (list === null) throw new Error('Aokana native list dialog dereferences a null item list');
      const faces: string[] = [];
      let offset = list.offset;
      while (textByte(list.bytes, offset) !== 0) {
        let length = 0;
        while (
          textByte(list.bytes, offset + length) !== 0 &&
          textByte(list.bytes, offset + length) !== 10
        )
          length++;
        if (length > 0) {
          if (length >= 784)
            throw new RangeError('Aokana list item overwrites its native stack scratch buffer');
          const line = new Uint8Array(length + 1);
          line.set(list.bytes.subarray(offset, offset + length));
          faces.push(this.text.decodeAuto({bytes: line, offset: 0}));
        }
        offset += length + Number(textByte(list.bytes, offset + length) === 10);
      }
      const selected = await this.dialogs.chooseList(caption, message, faces);
      if (!selected.accepted) return 0;
      if (output === null)
        throw new Error('Aokana native list dialog dereferences a null output pointer');
      if (selected.index === null) writeText(output, Uint8Array.of(0));
      else {
        const face = faces[selected.index];
        if (face === undefined)
          throw new RangeError('Aokana list selection index is outside native list storage');
        if ((face.length + 1) * 2 > 0x20000)
          throw new RangeError('Aokana list text overwrites its native wide scratch buffer');
        writeText(output, this.text.encodeWide(face));
      }
      return 1;
    });
  }

  /** 1400bdce0 builds a newline list using the fixed native "%s\n" format. */
  async chooseFont(
    fonts: AokanaFontResources,
    japanese: boolean,
    output: AokanaBpPointer | null,
    title: AokanaBpPointer | null,
  ): Promise<0 | 1> {
    const enumerated = await fonts.enumerate(128, japanese);
    if (enumerated.byteCount > 0x100000)
      throw new RangeError('Aokana font enumeration overwrites its native scratch allocation');
    if (enumerated.names.length === 0) return 0;
    const list = new Uint8Array(0x100000);
    let offset = 0;
    for (const name of enumerated.names) {
      const bytes = textBytes({bytes: name, offset: 0});
      if (offset + bytes.length + 2 > list.length)
        throw new RangeError('Aokana font list overwrites its native scratch allocation');
      list.set(bytes, offset);
      offset += bytes.length;
      list[offset++] = 10;
      list[offset] = 0;
    }
    // Original prompt at 140180ff0 is CP932, independent of the selected encoding mode.
    const prompt = Uint8Array.of(
      0x83,
      0x74,
      0x83,
      0x48,
      0x83,
      0x93,
      0x83,
      0x67,
      0x82,
      0xf0,
      0x91,
      0x49,
      0x91,
      0xf0,
      0x82,
      0xb5,
      0x82,
      0xc4,
      0x82,
      0xad,
      0x82,
      0xbe,
      0x82,
      0xb3,
      0x82,
      0xa2,
      0,
    );
    return this.select(output, title, {bytes: prompt, offset: 0}, {bytes: list, offset: 0});
  }
}
