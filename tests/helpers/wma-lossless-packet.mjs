/** Synthetic stereo adaptive-prediction packet; no external media bytes. */
export function compressedPacket(bits) {
  const data = new Uint8Array(16384);
  let index = 0;
  const put = (n, value) => {
    for (let i = n - 1; i >= 0; i--, index++)
      data[index >> 3] |= ((value >>> i) & 1) << (7 - (index & 7));
  };
  put(4, 0);
  put(2, 0);
  put(18, 0); // Packet header.
  put(1, 1);
  put(4, 15);
  put(8, 0);
  put(1, 0); // Full-size tile, no trimming.
  put(1, 1); // Seekable tile.
  put(1, 0);
  put(1, 1);
  put(1, 1);
  put(1, 1); // Arithmetic off; AC, stereo, MCLMS on.
  put(4, 1);
  put(4, 3);
  put(3, 2);
  put(3, 1); // Two AC taps, scaling 3.
  put(4, 1);
  put(4, 4);
  put(1, 0); // MCLMS order 4, scaling 4, zero initial coefficients.
  put(1, 0); // LMS coefficients initially zero.
  for (let ch = 0; ch < 2; ch++) {
    put(3, 1); // Two cascaded LMS layers.
    put(7, 1);
    put(7, 3); // Orders 16 and 32.
    put(4, 8);
    put(4, 10);
  }
  const moving = 4;
  put(3, moving);
  put(8, 0); // Moving average, quantization step 1.
  put(1, 0);
  put(2, 3);
  put(1, 0);
  put(1, 0); // Compressed, both channels, no LPC/padding.
  for (let ch = 0; ch < 2; ch++) {
    put(1, 0);
    put(bits, 0);
    put(bits + 1, ch ? -100 : 100);
    let average = 0;
    for (let i = 1; i < 2048; i++) {
      const residue = ((i * 13 + ch * 3) % 19) - 9;
      const unsigned = residue < 0 ? -residue * 2 - 1 : residue * 2;
      const mean = ((average + (1 << moving)) >>> 0) >>> (moving + 1);
      const n = mean <= 1 ? 0 : 32 - Math.clz32(mean - 1);
      const quotient = unsigned >>> n;
      for (let j = 0; j < quotient; j++) put(1, 1);
      put(1, 0);
      if (n) put(n, unsigned & ((1 << n) - 1));
      average = (unsigned + average - (average >>> moving)) >>> 0;
    }
  }
  put(1, 0);
  return data;
}
