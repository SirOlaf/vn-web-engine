import {BurikoNativeRegistry} from './windows-registry.js';
import {BurikoEngineDialogs} from './engine-dialogs.js';
import {parseBurikoCrtWideInteger} from './crt-numbers.js';

/** EF600/EFDE0 use the same title-scoped registry and modal depth as the other system services. */
export class BurikoDisplayMouseTrails {
  private entered = 0; // 273988, independent from the general modal-depth counter.
  constructor(
    readonly registry: BurikoNativeRegistry,
    readonly dialogs: BurikoEngineDialogs,
  ) {}

  /** EF600 reads at most512 bytes of REG_SZ and parses its signed wide decimal prefix. */
  async read(): Promise<number> {
    const key = await this.registry.openKey(0x80000001, 'Control Panel\\Mouse', 0x20019);
    if (key.result !== 0) return 0;
    const result = await this.registry.queryValue(key.handle!, 'MouseTrails');
    let value = 0;
    if (result.result === 0 && result.value!.type === 1 && result.value!.data.length <= 512) {
      const bytes = result.value!.data;
      let text = '',
        terminated = false;
      for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
        const unit = bytes[offset]! | (bytes[offset + 1]! << 8);
        if (unit === 0) {
          terminated = true;
          break;
        }
        text += String.fromCharCode(unit);
      }
      if (!terminated) throw new Error('Buriko mouse-trails registry string has no terminator');
      value = parseBurikoCrtWideInteger(text, 10, true).value | 0;
    }
    this.registry.closeKey(key.handle!);
    return value;
  }
  async transition(fullscreen: number): Promise<void> {
    if ((fullscreen | 0) === 0) {
      if (this.entered !== 0) {
        this.dialogs.transition(false);
        this.entered = 0;
      }
    } else if (this.entered === 0 && (await this.read()) !== 0) {
      this.dialogs.transition(true);
      this.entered = 1;
    }
  }
}
