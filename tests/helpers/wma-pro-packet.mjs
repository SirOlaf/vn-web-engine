/** Generated length-prefixed WMA Pro silence; no external media bytes. */
export function proPacket({frames = 3, endTrim = 0} = {}) {
  const field = (n, value) => value.toString(2).padStart(n, '0');
  let bits = '000000' + field(18, 0); // Sequence, unused bits and previous-frame tail.
  for (let frame = 0; frame < frames; frame++) {
    const trim = frame === frames - 1 ? endTrim : 0;
    const payload =
      '10' +
      '0' +
      field(8, 0) + // Shared full-size tiles, no postprocess, DRC.
      (trim ? '101' + field(12, trim) : '0') +
      '0001000'; // No fill/reserved/transform, independent uncoded channels.
    bits += field(18, 18 + payload.length + 2) + payload + '0' + Number(frame + 1 < frames);
  }
  const data = new Uint8Array(20434);
  for (let i = 0; i < bits.length; i++) data[i >> 3] |= Number(bits[i]) << (7 - (i & 7));
  return data;
}

export function proConfig() {
  return {
    sampleRate: 44100,
    channels: 2,
    blockAlign: 20434,
    extra: Uint8Array.from([24, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 224, 0, 0, 0]),
  };
}
