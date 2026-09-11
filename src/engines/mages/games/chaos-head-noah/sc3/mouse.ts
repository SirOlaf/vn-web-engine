import type {InputFrame} from '../../../../../input/browser-input.js';
import type {NoahState} from './noah-state.js';
import type {NoahCursor} from './cursor.js';

/** 140062800's sampled mouse, followed by 14001e090's application mouse gate.
 * Coordinates use a virtual 1920x1080 client, as supplied by BrowserInput. */
export class NoahMouse {
  private active = false; // Application +30 is zero in the executable initializer.
  constructor(readonly state: NoahState) {}
  poll(frame: InputFrame): void {
    const s = this.state;
    s.put(0x17adf70, 0, 2);
    s.zero(0x17adda0, 8);
    if (!frame.inside || frame.focused === false) {
      this.clear();
      return;
    }
    s.put(0x17adf71, 1, 1);
    const x = Math.trunc(Math.fround(frame.x)),
      y = Math.trunc(Math.fround(frame.y));
    if (x !== s.get(0x17addd4) || y !== s.get(0x17addd8)) s.put(0x17adf70, 1, 1);
    s.put(0x17addd4, x);
    s.put(0x17addd8, y);
    s.put(0x17adddc, x);
    s.put(0x17adde0, y);
    s.put(0x17addd0, frame.wheel);
    const held = (frame.buttons & 7) | (frame.wheel > 0 ? 8 : frame.wheel < 0 ? 16 : 0),
      previous = s.get(0x17ade60) >>> 0;
    s.put(0x17adda0, held, 8);
    s.view(0x17adda8, 8).setBigUint64(0, BigInt.asUintN(64, ~BigInt(held)), true);
    let clicks = 0n;
    for (let bit = 0; bit < 64; bit++) {
      const address = 0x17ade70 + bit * 4,
        age = s.get(address) >>> 0,
        down = !!(BigInt(held) & (1n << BigInt(bit)));
      if (!down && (age - 1) >>> 0 < 14) clicks |= 1n << BigInt(bit);
      s.put(address, down ? age + 1 : 0);
    }
    s.view(0x17add90, 8).setBigUint64(0, clicks, true);
    if (clicks) s.put(0x17adf70, 1, 1);
    s.put(0x17addc0, (previous ^ held) & held, 8);
    let drag = (s.get(0x17add98) >>> 0) & ~(~held & 7);
    for (const [bit, anchor] of [
      [1, 0x17adde4],
      [2, 0x17ade0c],
      [4, 0x17ade34],
    ] as const) {
      if (!(previous & bit) && held & bit) {
        drag |= bit;
        s.put(anchor, x);
        s.put(anchor + 4, y);
        s.put(anchor + 8, x);
        s.put(anchor + 12, y);
      }
    }
    s.put(0x17add98, drag, 8);
    for (const [bit, anchor, total, delta] of [
      [1, 0x17adde4, 0x17addf4, 0x17ade00],
      [2, 0x17ade0c, 0x17ade1c, 0x17ade28],
    ] as const) {
      let dx = 0,
        dy = 0;
      if (drag & bit) {
        dx = x - s.get(anchor);
        dy = y - s.get(anchor + 4);
        s.put(delta, dx - s.get(total));
        s.put(delta + 4, dy - s.get(total + 4));
      } else s.put(0x17addfc, 0);
      s.put(total, dx);
      s.put(total + 4, dy);
    }
    // Native middle-button offsets differ from the two branches above.
    if (drag & 4) {
      s.put(0x17ade50, x - s.get(0x17ade44) - s.get(0x17ade34));
      s.put(0x17ade54, y - s.get(0x17ade48) - s.get(0x17ade38));
      s.put(0x17ade44, x - s.get(0x17ade34));
      s.put(0x17ade48, y - s.get(0x17ade38));
    } else {
      s.put(0x17addfc, 0);
      s.put(0x17ade44, 0);
      s.put(0x17ade48, 0);
    }
    s.put(0x17ade60, held, 8);
    s.view(0x17ade68, 8).setBigUint64(0, BigInt.asUintN(64, ~BigInt(held)), true);
  }
  private clear(): void {
    for (const address of [
      0x17add90, 0x17add98, 0x17adda0, 0x17adda8, 0x17addb0, 0x17addb8, 0x17ade00,
    ])
      this.state.zero(address, 8);
  }
  gate(frame: InputFrame, navigation: boolean, cursor: NoahCursor): void {
    const s = this.state;
    if (frame.focused === false || s.view(0x1dd9ca0, 8).getBigUint64(0, true) !== 0n || navigation)
      this.active = false;
    if (s.view(0x17add90, 8).getBigUint64(0, true)) {
      if (!this.active) this.clear();
      this.active = true;
    }
    if (!this.active) {
      this.clear();
      cursor.useSystem();
      s.put(0x17addd0, 0);
    }
    s.put(0x17add76, +this.active & s.bytes(0x17adf71, 1)[0]!, 1);
  }
}
