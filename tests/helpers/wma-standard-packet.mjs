/** Three generated 2048-sample WMA v2 frames, without external media bytes. */
export function standardPacket(coded = false) {
  const data = new Uint8Array(2731);
  let index = 0;
  const put = (n, value) => {
    for (let i = n - 1; i >= 0; i--, index++)
      data[index >> 3] |= ((value >>> i) & 1) << (7 - (index & 7));
  };
  put(4, 0);
  put(4, 4);
  put(12, 0); // Three complete frames; no previous frame.
  for (let frame = 0; frame < 3; frame++) {
    if (!frame) {
      put(3, 0);
      put(3, 0);
    }
    put(3, 0); // Current, previous and next blocks all 2048 samples.
    put(1, 0);
    put(2, coded ? 3 : 0); // Independent stereo channels.
    if (coded) {
      put(7, 20); // Total gain 21.
      // 25 exponent bands at 48 kHz; delta zero is the 1-bit AAC code 0.
      for (let ch = 0; ch < 2; ch++) for (let band = 0; band < 25; band++) put(1, 0);
      for (let ch = 0; ch < 2; ch++) {
        put(2, 0);
        put(1, ch ? 0 : 1); // DC coefficient +1 or -1.
        put(9, 0xf6); // Coefficient table 2 end-of-block.
      }
    }
  }
  return data;
}

export function standardConfig() {
  return {
    sampleRate: 48000,
    channels: 2,
    bytesPerSecond: 8000,
    blockAlign: 2731,
    extra: Uint8Array.from([0, 136, 0, 0, 15, 0, 0, 0, 0, 0]),
  };
}
