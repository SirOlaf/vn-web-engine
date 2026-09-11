import type {OpcodeExecution} from './types.js';
import type {NoahState} from '../noah-state.js';

/** 14000ce60: script owns texture loading and acknowledges flags a7/20+40. */
function requestImage(s: NoahState): void {
  const buffer = s.get(0x5451cc) >>> 0;
  if (buffer > 1) throw new Error('Native gallery buffer must be zero or one');
  s.setVariable(0x2408 / 4, s.get(0x5438a0 + (s.get(0x5451ec) >>> 0) * 4));
  s.setVariable(0x240c / 4, buffer + 1);
  s.flags[0xa7] = (s.flags[0xa7]! | 0x60) ^ 0x40;
}

/** 14000cec0: aspect fitting uses the loaded texture record's integer dimensions. */
function imageDimensions(s: NoahState): void {
  const a = 0x1d1b200 + s.variable((s.get(0x5451cc) >>> 0) + 0xd48) * 0x1b0;
  const u = (o: number) => s.view(a + o, 2).getUint16(0, true),
    f = Math.fround;
  const cvtt = (n: number) =>
    !Number.isFinite(n) || n >= 2147483648 || n < -2147483648 ? -2147483648 : Math.trunc(n);
  const width = f(cvtt(f(f(u(0x72) * u(0x76)) / u(0x68)))),
    height = f(cvtt(f(f(u(0x74) * u(0x78)) / u(0x6a))));
  s.view(0x5451b4, 4).setFloat32(0, width, true);
  s.view(0x5451e4, 4).setFloat32(0, height, true);
  s.view(0x54300c, 4).setFloat32(
    0,
    width > 1920 ? f(1920 / width) : height > 1080 ? f(1080 / height) : 1,
    true,
  );
}

/** 14000cfb0: copy the pending image transform and swap the two script buffers. */
function finishImage(s: NoahState): void {
  for (const [dst, src] of [
    [0x543018, 0x54301c],
    [0x5451b0, 0x5451b4],
    [0x543008, 0x54300c],
    [0x5432d8, 0x5432dc],
    [0x5451e0, 0x5451e4],
    [0x5451a8, 0x5451ac],
    [0x543010, 0x543014],
    [0x5451d8, 0x5451dc],
    [0x543020, 0x543024],
    [0x543848, 0x54384c],
    [0x543048, 0x54304c],
    [0x5425a8, 0x5425ac],
    [0x5437f8, 0x5437fc],
    [0x543880, 0x543884],
    [0x543898, 0x54389c],
  ])
    s.put(dst!, s.get(src!));
  const old = s.get(0x5451c8);
  s.put(0x5451dc, 0);
  s.put(0x543884, 0);
  s.put(0x5451c8, s.get(0x5451cc));
  s.put(0x5451cc, old);
}

/** 14000d0d0: keep the scaled viewport inside the current image. */
function clampImage(s: NoahState): void {
  const f = Math.fround,
    r = (a: number) => s.view(a, 4).getFloat32(0, true),
    w = (a: number, v: number) => s.view(a, 4).setFloat32(0, v, true),
    scale = r(0x543018);
  for (const [screen, extent, center] of [
    [1920, 0x5451b0, 0x5432d8],
    [1080, 0x5451e0, 0x543010],
  ]) {
    const size = r(extent!),
      span = f(screen! / scale);
    if (screen === 1920 ? !(span < size) : size <= span) {
      w(center!, f(size * 0.5));
      continue;
    }
    const half = f(span * 0.5);
    let low = f(r(center!) - half),
      high = f(half + r(center!));
    if (low < 0) {
      high = f(high - low);
      low = 0;
    }
    if (size < high) {
      low = f(low - f(high - size));
      high = size;
    }
    w(center!, f(f(f(high - low) * 0.5) + low));
  }
}

/** 14005a990 and its native CG-grid and image-view controller paths. */
export function cgGallery(h: OpcodeExecution): void {
  h.skip(2);
  const selector = h.byte(),
    s = h.state,
    g = (a: number) => s.get(a) >>> 0,
    p = (a: number, n: number) => s.put(a, n);
  const sound = (id: number) => {
    const volume = Math.trunc(Math.fround(Math.fround(Math.fround(g(0x17ac2e8)) * 70) / 100)) >>> 0;
    p(0x5a7100, volume);
    h.sound(id, volume);
  };
  if (selector === 0) {
    p(0x5451cc, 1);
    p(0x5432d4, 1);
    s.flags[0xa3] = s.flags[0xa3]! & ~0xc0;
    s.flags[0xa7] = s.flags[0xa7]! & ~0xe0;
    p(0x5451c8, 0);
    p(0x5451b8, 0);
    s.zero(0x543880, 8);
    s.variables.setBigUint64(0x2408, 0n, true);
    p(0x543568, 0);
    p(0x5451a4, 0);
    s.galleryProgress();
    if (g(0x5451c4) && g(0x5451c4) === g(0x543564)) h.achievement(27);
    return;
  }
  if (selector !== 1) return;
  if (g(0x5451a4)) {
    p(0x5451a4, g(0x5451a4) + 1);
    if (g(0x5451a4) >= 16) {
      p(0x5432d4, g(0x543028));
      p(0x5451a4, 0);
    }
    return;
  }
  if (g(0x543890)) {
    p(0x543890, g(0x543890) + 1);
    if (g(0x543890) >= 16) {
      p(0x543888, g(0x543004));
      p(0x543890, 0);
    }
    return;
  }
  const blocked = () => !!s.bytes(0x543836, 1)[0],
    pressed = (mask: number) => !!(g(0x5a70d4) & g(mask)),
    repeat = (mask: number) => !!(g(0x5a6f74) & g(mask));
  const cancel = () => !blocked() && !!(g(0x586a58) & 2 || pressed(0x872dd8) || g(0x17add90) & 2);
  if (g(0x5432d4) === 1) {
    if (cancel()) {
      s.flags[0xa3] = s.flags[0xa3]! | 0x80;
      sound(3);
      return;
    }
    for (let i = 0; i < 20; i++)
      if (h.input.hit(21, i, true)) {
        p(0x543568, i);
        if (g(0x17add90) & 1) p(0x5a70d4, g(0x5a70d4) | g(0x872dd4));
        break;
      }
    const old = g(0x543568),
      index = (old + Math.imul(g(0x543888), 20)) >>> 0;
    if (pressed(0x872dd4) && g(0x543570 + index * 4)) {
      sound(2);
      p(0x543038, 1);
      p(0x5451ec, index * 10);
      s.zero(0x5451b0, 8);
      p(0x54302c, g(0x5451ec) + g(0x543570 + index * 4));
      p(0x5451b8, 1);
      s.zero(0x543880, 8);
      p(0x5432d4, 2);
      p(0x5451a4, 0);
      requestImage(s);
      p(0x5437f4, 0);
      return;
    }
    if (!blocked()) {
      let page: number | undefined;
      if (g(0x586a58) & 0x80 || g(0x5a6f74) & 0x100) page = g(0x543004) ? g(0x543004) - 1 : 7;
      else if (g(0x586a58) & 0x100 || g(0x5a6f74) & 0x200)
        page = g(0x543004) < 7 ? g(0x543004) + 1 : 0;
      if (page !== undefined) {
        sound(2);
        const count = g(0x542d80 + page * 4);
        if (g(0x543568) >= count) p(0x543568, count - 1);
        p(0x543004, page);
        p(0x543890, 1);
        return;
      }
    }
    const count = g(0x542d80 + g(0x543888) * 4);
    if (!count || blocked()) return;
    let n = old;
    if (g(0x586a58) & 8 || repeat(0x872dc8)) {
      n = (n + (n < 16 && (0x8421 >>> n) & 1 ? 4 : -1)) >>> 0;
      if (n >= count) n = count - 1;
      p(0x543568, n);
    }
    if (g(0x586a58) & 16 || repeat(0x872dcc)) {
      n = (n < 20 && (0x84210 >>> n) & 1) || n === count - 1 ? Math.trunc((n | 0) / 5) * 5 : n + 1;
      p(0x543568, n);
    }
    if (g(0x586a58) & 32 || repeat(0x872dc0)) {
      if ((n | 0) < 5) {
        n = (n + 15) >>> 0;
        if (n >= count) n = (n - (Math.floor((n - count) / 5) + 1) * 5) >>> 0;
      } else n -= 5;
      p(0x543568, n);
    }
    if (g(0x586a58) & 64 || repeat(0x872dc4)) {
      if ((n + 5) >>> 0 < count) n = (n + 5) >>> 0;
      else if ((n | 0) > 4) n %= 5;
      p(0x543568, n);
    }
    if (old !== n) sound(1);
    return;
  }
  if (g(0x5432d4) !== 2) return;
  if (s.flags[0xa7]! & 0x20) {
    if (!(s.flags[0xa7]! & 0x40)) return;
    s.flags[0xa7] = s.flags[0xa7]! & ~0x60;
    imageDimensions(s);
    s.view(0x543014, 4).setFloat32(0, s.view(0x5451e4, 4).getFloat32(0, true) * 0.5, true);
    p(0x543884, 1);
    s.view(0x5432dc, 4).setFloat32(0, s.view(0x5451b4, 4).getFloat32(0, true) * 0.5, true);
    p(0x54301c, g(0x54300c));
  }
  if (g(0x5451b8) & 0xffffffef) {
    p(0x5451b8, g(0x5451b8) + 1);
    if (g(0x5451b8) < 17) {
      p(0x543884, g(0x5451b8));
      if (g(0x5451b8) === 16) finishImage(s);
    } else {
      p(0x543880, 32 - g(0x5451b8));
      if (g(0x5451b8) === 32) {
        p(0x5451b8, 0);
        p(0x5432d4, 1);
      }
    }
    return;
  }
  if ((g(0x543884) - 1) >>> 0 < 15) {
    p(0x543884, g(0x543884) + 1);
    if (g(0x543884) === 16) finishImage(s);
    return;
  }
  if (g(0x5437f4)) p(0x5437f4, g(0x5437f4) - 1);
  if (pressed(0x872e04)) {
    sound(2);
    p(0x543038, g(0x543038) ^ 1);
    return;
  }
  if ((!blocked() && (g(0x586a58) & 1 || pressed(0x872dd4))) || g(0x17add90) & 1) {
    sound(2);
    if ((g(0x5451ec) + 1) >>> 0 === g(0x54302c)) p(0x5451b8, 17);
    else {
      p(0x5451ec, g(0x5451ec) + 1);
      requestImage(s);
    }
    return;
  }
  if (s.get(0x17addd0) < 0) p(0x5a70d0, g(0x5a70d0) | 0x200);
  if (s.get(0x17addd0) > 0) p(0x5a70d0, g(0x5a70d0) | 0x100);
  const f = Math.fround,
    r = (a: number) => s.view(a, 4).getFloat32(0, true),
    w = (a: number, n: number) => s.view(a, 4).setFloat32(0, n, true);
  let scale = r(0x543018);
  if (g(0x17adda0) & 1 && s.bytes(0x17add76, 1)[0]) {
    w(0x5432d8, f(r(0x5432d8) - f(f(f(s.get(0x17ade00)) / r(0x1badf64)) / scale)));
    clampImage(s);
    w(0x543010, f(r(0x543010) - f(f(f(s.get(0x17ade04)) / r(0x17adf9c)) / scale)));
    clampImage(s);
    s.put(0x17add73, 1, 1);
  } else s.put(0x17add73, 0, 1);
  if (cancel()) {
    sound(3);
    p(0x5451b8, 17);
    return;
  }
  const held = g(0x5a70d0),
    step = f(0.02);
  if (!g(0x5437f4)) {
    if (held & 0xa00 && scale < 2) {
      if (scale >= 1 || f(scale + step) < 1) w(0x543018, Math.min(f(scale + step), 2));
      else {
        w(0x543018, 1);
        p(0x5437f4, 20);
      }
      scale = r(0x543018);
      clampImage(s);
    }
    if (held & 0x500 && r(0x543008) < scale) {
      if (scale <= 1 || f(scale - step) > 1) w(0x543018, Math.max(f(scale - step), r(0x543008)));
      else {
        w(0x543018, 1);
        p(0x5437f4, 20);
      }
      clampImage(s);
    }
  }
  for (const [bit, address, delta] of [
    [0x10000, 0x543010, -40],
    [0x20000, 0x543010, 40],
    [0x40000, 0x5432d8, -40],
    [0x80000, 0x5432d8, 40],
  ])
    if (held & bit!) {
      w(address!, f(r(address!) + delta!));
      clampImage(s);
    }
}
