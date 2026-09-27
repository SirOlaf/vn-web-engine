/** Builds a compiled GSC program: header, code, strings, word arrays and labels. */
export function gsc({code, strings = [''], arrays = [], labels = []}) {
  const stringData = Buffer.concat(strings.map((s) => Buffer.from(s + '\0', 'latin1')));
  const stringIndex = Buffer.alloc(strings.length * 4);
  strings.reduce(
    (offset, s, i) => (stringIndex.writeUInt32LE(offset, i * 4), offset + s.length + 1),
    0,
  );
  const words = [0];
  const arrayIndex = Buffer.alloc((arrays.length + 1) * 4);
  arrayIndex.writeUInt32LE(0xffff, 0);
  arrays.forEach((array, i) => {
    arrayIndex.writeUInt32LE(words.length, (i + 1) * 4);
    words.push(array.length, ...array);
  });
  const arrayData = Buffer.alloc(words.length * 2);
  words.forEach((w, i) => arrayData.writeInt16LE(w, i * 2));
  const allLabels = [['', 0], ...labels];
  const labelData = Buffer.concat(allLabels.map(([name]) => Buffer.from(name + '\0', 'latin1')));
  const labelNames = Buffer.alloc(allLabels.length * 4),
    labelOffsets = Buffer.alloc(allLabels.length * 4);
  allLabels.reduce((offset, [name, target], i) => {
    labelNames.writeUInt32LE(offset, i * 4);
    labelOffsets.writeUInt32LE(target, i * 4);
    return offset + name.length + 1;
  }, 0);
  const sections = [
    code,
    stringIndex,
    stringData,
    arrayIndex,
    arrayData,
    labelNames,
    labelOffsets,
    labelData,
  ];
  const header = Buffer.alloc(36);
  const total = 36 + sections.reduce((n, s) => n + s.length, 0);
  [
    total,
    36,
    code.length,
    stringIndex.length,
    stringData.length,
    arrayIndex.length,
    words.length,
    labelNames.length,
    labelData.length,
  ].forEach((v, i) => header.writeUInt32LE(v, i * 4));
  return new Uint8Array(Buffer.concat([header, ...sections]));
}
