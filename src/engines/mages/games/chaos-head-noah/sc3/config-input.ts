import type {OpcodeExecution} from './opcodes/types.js';
import {
  configCopy,
  configCopyVoices,
  configLanguage,
  configPageFields,
  applyConfigPadBindings,
  clearConfigPadInput,
} from './config-state.js';
import {configVoiceTable} from './config-data.js';
/** 140034320. Preview values update on hover; clicks synthesize native confirm.
 * Navigation repeat, held sliders, and pressed toggles use separate input banks. */
export function interactConfig(h: OpcodeExecution): void {
  const s = h.state,
    g = (a: number) => s.get(a) >>> 0,
    p = (a: number, n: number) => s.put(a, n);
  const pressed = (mask: number) => !!(g(0x5a70d4) & g(mask)),
    repeat = (mask: number) => !!(g(0x5a6f74) & g(mask)),
    held = (mask: number) => !!(g(0x5a70d0) & g(mask));
  const sound = (id: number) => {
    const volume = Math.trunc(Math.fround(Math.fround(Math.fround(g(0x17ac2e8)) * 70) / 100)) >>> 0;
    p(0x5a7100, volume);
    h.sound(id, volume);
  };
  const cancel = () =>
    !s.bytes(0x543836, 1)[0] &&
    !!(s.bytes(0x586a58, 1)[0]! & 2 || pressed(0x872dd8) || g(0x17add90) & 2);
  const click = () => {
    if (g(0x17add90) & 1) p(0x5a70d4, g(0x5a70d4) | g(0x872dd4));
  };
  const hit = (group: number, index: number) => h.input.hit(group, index, true),
    lr = () => !!(g(0x5a6f74) & (g(0x872dcc) | g(0x872dc8)));
  const tab = () => g(0x5b09b4),
    rowAddress = () => 0x5b09a0 + tab() * 4,
    row = () => g(rowAddress()),
    setRow = (n: number) => p(rowAddress(), n);
  const character = () => {
    const i = g(0x5b0470 + row() * 4),
      id = configVoiceTable[i * 4];
    if (id === undefined) throw new Error(`Unknown Config voice entry ${i}`);
    return id;
  };
  const voiceToggle = () => {
    sound(2);
    const a = 0x17abdc0 + character() * 4;
    p(a, g(a) ^ 1);
  };
  configLanguage(s);
  if (g(0x5af928) < 2) {
    for (let i = 0; i < 5; i++)
      if (hit(21, i) && g(0x17add90) & 1) {
        sound(1);
        p(0x5b09b4, i);
        return;
      }
    const count = () => (tab() === 3 ? g(0x5a9ab0) : g(0x20d218 + tab() * 4));
    for (let i = 0; i < count(); i++) {
      if (s.variable(0x2104 / 4) !== 0 && tab() === 0 && i === 4) continue;
      if (hit(20, i)) {
        setRow(i);
        click();
        break;
      }
    }
    if (cancel()) {
      sound(3);
      s.flags[0xe4] = s.flags[0xe4]! | 64;
      s.flags[0xc0] = (s.flags[0xc0]! & ~32) | (g(0x5b099c) === g(0x17a0cdc) ? 0 : 32);
      s.put(0x543837, 0, 1);
      return;
    }
    if (pressed(0x872dd4)) {
      sound(2);
      p(0x5af928, 2);
      return;
    }
    if (g(0x5a70d4) & 256) {
      sound(1);
      p(0x5b09b4, tab() ? tab() - 1 : 4);
      return;
    }
    if (g(0x5a70d4) & 512) {
      sound(1);
      p(0x5b09b4, tab() > 3 ? 0 : tab() + 1);
      return;
    }
    if (tab() < 3) {
      if (repeat(0x872dc0)) {
        sound(1);
        setRow(row() ? row() - 1 : count() - 1);
        if (tab() === 0 && s.variable(0x2104 / 4) !== 0 && row() === 4) setRow(3);
      }
      if (repeat(0x872dc4)) {
        sound(1);
        setRow(row() >= (count() - 1) >>> 0 ? 0 : row() + 1);
        if (tab() === 0 && s.variable(0x2104 / 4) !== 0 && row() === 4) setRow(count() > 5 ? 5 : 0);
      }
      return;
    }
    if (tab() !== 3) {
      const original = row();
      if (original > 4) setRow(original - 5);
      if (repeat(0x872dc0)) {
        sound(1);
        setRow(row() ? row() - 1 : 4);
      }
      if (repeat(0x872dc4)) {
        sound(1);
        setRow(row() < 4 ? row() + 1 : 0);
      }
      if (original > 4) setRow(row() + 5);
      if (lr()) {
        setRow(row() + 5);
        if (row() > (count() - 1) >>> 0) setRow(row() - 10);
      }
      return;
    }
    let moved = false;
    if (repeat(0x872dc0)) {
      if (row() < 2) {
        while (row() + 2 < count()) setRow(row() + 2);
      } else setRow(row() - 2);
      moved = true;
    }
    if (repeat(0x872dc4)) {
      if (row() + 2 < count()) setRow(row() + 2);
      else while (row() > 1) setRow(row() - 2);
      moved = true;
    }
    if (lr()) {
      setRow(row() ^ 1);
      if (row() >= count()) setRow(count() - 1);
      moved = true;
    }
    if (moved) sound(1);
    else if (pressed(0x872e08)) voiceToggle();
    return;
  }
  const page = tab();
  const previewOptions = (fields: readonly (number | undefined)[], count: number) => {
    for (let i = 0; i < count; i++)
      if (hit(22, i)) {
        const field = fields[row()];
        if (field !== undefined && g(field) !== i) {
          sound(1);
          p(field, i);
        }
        click();
        break;
      }
  };
  const endEdit = () => {
    if (cancel()) {
      sound(3);
      p(0x5af928, 1);
      if (page === 3) configCopyVoices(s, false, 17);
      else configCopy(s, false, configPageFields[page]!);
      return true;
    }
    if (pressed(0x872dd4)) {
      sound(2);
      if (page === 0) {
        if (g(0x5af938) !== g(0x17abc08)) p(0x5af930, 1);
        if (g(0x5af93c) !== g(0x17abdac)) p(0x5af934, 1);
        if (g(0x5a9acc) !== g(0x17ac318)) {
          s.flags[0xe5] = s.flags[0xe5]! | 1;
          s.setVariable(0x3400 / 4, g(0x17ac318));
        }
      }
      if (page === 3) configCopyVoices(s, true, 17);
      else configCopy(s, true, configPageFields[page]!);
      p(0x5af928, 1);
      return true;
    }
    return false;
  };
  const clamp = (n: number, max: number) => Math.max(0, Math.min(max, n));
  const sliderStep = (field: number) => {
    if (held(0x872dc8) && g(field) !== 0) p(field, g(field) - 1);
    if (held(0x872dcc) && g(field) < 128) p(field, g(field) + 1);
  };
  if (page === 0) {
    const fields = configPageFields[0];
    previewOptions(fields.slice(0, 6), 3);
    if (endEdit()) return;
    if (lr() && row() < 6) {
      sound(1);
      const a = fields[row()]!;
      if (row() === 3) p(a, repeat(0x872dc8) ? (g(a) ? g(a) - 1 : 2) : g(a) === 2 ? 0 : g(a) + 1);
      else p(a, g(a) ^ 1);
    }
    return;
  }
  if (page === 1) {
    if (hit(23, 0)) {
      const i = clamp((s.get(0x17adddc) - 1218) | 0, 350);
      if (row() === 0) p(0x17a0cd8, Math.floor((i * 3840) / 350) + 256);
      else if (row() === 1) p(0x17adca8, Math.floor(((350 - i) * 1792) / 350) + 256);
      click();
    }
    previewOptions([undefined, undefined, 0x17abc00], 2);
    if (endEdit()) return;
    const down = (a: number, step: number, span: number) => {
      if (g(a) > 256) {
        if (g(a) < 256 + step + 1) p(a, 256);
        else {
          p(a, g(a) - step);
          if ((Math.imul(g(a), 128) - 32768) >>> 0 < span) p(a, 256);
        }
      }
    };
    if (held(0x872dc8)) {
      if (row() === 0) down(0x17a0cd8, 30, 3840);
      else if (row() === 1 && g(0x17adca8) < 2048) p(0x17adca8, Math.min(2048, g(0x17adca8) + 14));
    }
    if (lr() && row() === 2) {
      sound(1);
      p(0x17abc00, g(0x17abc00) ^ 1);
    }
    if (held(0x872dcc)) {
      if (row() === 0 && g(0x17a0cd8) < 4096) p(0x17a0cd8, Math.min(4096, g(0x17a0cd8) + 30));
      else if (row() === 1) down(0x17adca8, 14, 1792);
    }
    return;
  }
  if (page === 2) {
    const fields = configPageFields[2];
    if (hit(23, 0)) {
      const origin = Math.fround(
          Math.fround(Math.fround(s.view(0x17add70, 2).getUint16(0, true)) * 1218) / 1920,
        ),
        i = clamp(Math.trunc(Math.fround(Math.fround(s.get(0x17adddc)) - origin)), 350);
      if (row() < 4) p(fields[row()]!, Math.floor((i * 128) / 350));
      click();
    }
    previewOptions([undefined, undefined, undefined, undefined, 0x17add34, 0x17abc04], 2);
    if (endEdit()) return;
    if (row() < 4) sliderStep(fields[row()]!);
    else if ((row() === 4 || row() === 5) && lr()) {
      sound(1);
      p(fields[row()]!, g(fields[row()]!) ^ 1);
    }
    return;
  }
  if (page === 3) {
    if (hit(23, 0)) {
      const i = clamp((s.get(0x17adddc) - (row() & 1 ? 1304 : 568)) | 0, 270);
      p(0x17abcd0 + character() * 4, Math.floor((i * 128) / 270));
      click();
    }
    if (endEdit()) return;
    sliderStep(0x17abcd0 + character() * 4);
    if (pressed(0x872e08)) voiceToggle();
    return;
  }
  if (page === 4) {
    if (g(0x17add90) & 2 || g(0x5a6f70)) {
      sound(3);
      p(0x5af928, 1);
      return;
    }
    for (let i = 0; i < 32; i++)
      if (s.bytes(0x1dd9fe4 + i, 1)[0]) {
        const mapping = [7, 2, 0, 1, 4, 9, 10, 5, 6, 3][row()],
          config = h.storage.configuration;
        if (mapping !== undefined) {
          const old = config[0x74 + mapping]!;
          config[0x74 + mapping] = i;
          for (let j = 0; j < 32; j++)
            if (j !== mapping && config[0x74 + j] === i) config[0x74 + j] = old;
        }
        applyConfigPadBindings(s, config);
        p(0x5a70d4, 0);
        p(0x5a70d0, 0);
        clearConfigPadInput(s);
        sound(2);
        p(0x5af928, 1);
        return;
      }
  }
}
