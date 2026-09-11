import type {NoahState} from './noah-state.js';
const product = (...values: number[]) => values.reduce((a, b) => Math.imul(a, b), 1) >>> 0;
const cvtt = (n: number) =>
  !Number.isFinite(n) || n < -2147483648 || n >= 2147483648 ? -2147483648 : Math.trunc(n);
const clamp = (n: number) => Math.max(0, Math.min(1000, n));

/** 1400286b0: six-channel spatial coefficients, including native int overflow. */
export function spatialAudio(s: NoahState, channel: number): void {
  const offset = [0x6228, 0x6238, 0x6248, 0x61f8, 0x6208, 0x6218][channel];
  if (offset === undefined) return;
  const v = s.variables,
    x = v.getInt32(offset, true),
    y = v.getInt32(offset + 4, true),
    base = 0x5a7110 + channel * 0x98;
  if (x === -2147483648) {
    s.put(base + 0x90, 0);
    return;
  }
  s.put(base + 0x90, 1);
  const length = (a: number, b: number) => cvtt(Math.sqrt((Math.imul(a, a) + Math.imul(b, b)) | 0));
  const distance = length(x, y);
  let strength = v.getInt32(offset + 8, true),
    delta: number;
  if (distance < 1415) {
    delta = Math.trunc((1414 - distance) / 2);
    strength = (strength + delta) | 0;
  } else delta = -Math.trunc(((distance - 1414) | 0) / 2);
  s.put(base + 0x8c, clamp((v.getInt32(offset + 12, true) + delta) | 0));
  const speakers = [
    [x + 1000, y + 1000],
    [x, y + 1414],
    [x - 1000, y + 1000],
    [x + 1000, y - 1000],
    [x - 1000, y - 1000],
  ];
  speakers.forEach(([a, b], i) => {
    const half = Math.trunc(length(a! | 0, b! | 0) / 2);
    s.put(base + 0x78 + i * 4, clamp(strength <= half ? 0 : (strength - half) | 0));
  });
}

/** Volume/ducking and script mirror prefix of 140027180. */
export function mixAudio(s: NoahState): void {
  const v = s.variables,
    get = (a: number) => v.getInt32(a, true),
    u = (a: number) => v.getUint32(a, true),
    put = (a: number, n: number) => v.setUint32(a, n, true),
    g = (a: number) => s.get(a) >>> 0;
  const master = g(0x17abe88);
  s.put(0x17ac2e8, Math.floor(product(master, 70) / 100));
  if (get(0x2104) !== 0)
    s.put(
      0x17abc94,
      g(0x17abccc) === 0
        ? [0x5a7310, 0x5a73a8, 0x5a7440].some((a) => s.get(a) === 1 && s.get(a + 4) === 0)
          ? 1
          : 0
        : s.get(0x5a74d8),
    );
  const duck = s.get(0x17abc94);
  if (get(0x43b0) !== 0) {
    const next = (get(0x43b0) + get(0x43a8)) | 0;
    if (next < 0) {
      put(0x43a8, 0);
      put(0x43b0, 0);
    } else if (next < 1001) put(0x43a8, next);
    else {
      put(0x43a8, 1000);
      put(0x43b0, 0);
    }
  }
  if (u(0x43a8) > 1000) put(0x43a8, 1000);
  for (const a of [0x4368, 0x436c, 0x4370, 0x4374, 0x4390, 0x4394, 0x4398])
    if (u(a) > 100) put(a, 100);
  if (!(s.flags[0x137]! & 8)) {
    s.put(0x5a76d4, 0);
    s.put(0x5a75a4, Math.floor(product(u(0x4368), g(0x17acb7c), 50) / 10000));
  } else {
    s.put(0x5a75a4, Math.floor(product(u(0x43a8), g(0x17acb7c), 50) / 100000));
    s.put(0x5a76d4, Math.floor(product(1000 - get(0x43a8), g(0x17acb7c), 50) / 100000));
  }
  const amount =
    duck === 1 && s.get(0x17abdbc) !== 0
      ? s.get(0x17ac1c0) !== 0
        ? 50
        : 0
      : s.get(0x17ac1bc) !== 0
        ? 40
        : 0;
  if (amount)
    for (const a of [0x5a75a4, 0x5a76d4]) s.put(a, Math.floor(product(g(a), amount) / 100));
  if (s.bytes(0x1d8be28, 1)[0])
    s.view(0x1d8be38, 4).setFloat32(
      0,
      Math.fround(Math.floor(product(g(0x17abdb8), 50) / 100)) * 0.0078125,
      true,
    );
  const voiceVolume = (id: number) => {
    if (id >= 50) return 0;
    const character = u((id + 0x814) * 4),
      volume = Math.floor(product(g(0x17abcd0 + character * 4), g(0x17abdbc), 100) / 12800);
    return get(0x2104) !== 0 && s.get(0x17abdc0 + character * 4) === 0 ? 0 : volume;
  };
  const voice = [0, 1, 2].map((i) =>
    voiceVolume(s.flags[0x142]! & (16 << i) ? u(0x439c + i * 4) : g(0x17abca0 + i * 4)),
  );
  s.put(0x5a750c, voiceVolume(g(0x17abcac)));
  if (!(s.flags[0x97]! & 2)) {
    [0x5b10b5, 0x5c2a39, 0x5d43bd].forEach((a, i) =>
      s.put(
        0x5a717c + s.bytes(a, 1)[0]! * 0x98,
        Math.floor(product(voice[i]!, u(0x4390 + i * 4)) / 100),
      ),
    );
    [0x5a717c, 0x5a7214, 0x5a72ac].forEach((a, i) =>
      s.put(a, Math.floor(product(master, u(0x436c + i * 4), 100) / 10000)),
    );
  } else
    for (const a of [
      0x5a75a4, 0x5a717c, 0x5a7214, 0x5a72ac, 0x5a7344, 0x5a73dc, 0x5a7474, 0x5a750c, 0x5a76d4,
    ])
      s.put(a, 0);
  s.put(0x5a763c, s.get(0x5a75a4));
  for (const [to, from] of [
    [15000, 0x5a7304],
    [0x3a9c, 0x5a72d8],
    [0x3aa8, 0x5a739c],
    [0x3aac, 0x5a7370],
    [0x3ab8, 0x5a7434],
    [0x3abc, 0x5a7408],
    [0x3ad0, 0x5a713c],
    [0x3ad4, 0x5a7110],
    [0x3ad8, 0x5a71d4],
    [0x3adc, 0x5a71a8],
    [0x3ae0, 0x5a726c],
    [0x3ae4, 0x5a7240],
    [0x3af8, 0x5a7694],
    [0x3afc, 0x5a7668],
  ])
    put(to!, s.get(from!));
  const active = g(0x20dde8);
  put(0x3af0, s.get(0x5a713c + active * 0x98));
  put(0x3af4, s.get(0x5a7110 + active * 0x98));
}
