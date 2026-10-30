/** Synthetic planar composite PSDs only; no game assets. */
export function psd({width, height, planes, compression = 0, rows, sections = []}) {
  const header = Buffer.alloc(26);
  header.write('8BPS');
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(planes.length, 12);
  header.writeUInt32BE(height, 14);
  header.writeUInt32BE(width, 18);
  header.writeUInt16BE(8, 22);
  header.writeUInt16BE(3, 24);
  const sectionsBytes = Array.from({length: 3}, (_, index) => {
    const data = Buffer.from(sections[index] ?? []),
      length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, data]);
  });
  const type = Buffer.alloc(2);
  type.writeUInt16BE(compression);
  let body;
  if (compression === 0) body = Buffer.concat(planes.map((plane) => Buffer.from(plane)));
  else {
    if (!rows)
      rows = planes.flatMap((plane) =>
        Array.from({length: height}, (_, y) => {
          const row = Buffer.from(plane.slice(y * width, (y + 1) * width));
          if (width > 128) throw Error('Provide explicit synthetic rows for width>128');
          return Buffer.concat([Buffer.from([width - 1]), row]);
        }),
      );
    const table = Buffer.alloc(rows.length * 2);
    rows.forEach((row, index) => table.writeUInt16BE(row.length, index * 2));
    body = Buffer.concat([table, ...rows.map((row) => Buffer.from(row))]);
  }
  return new Uint8Array(Buffer.concat([header, ...sectionsBytes, type, body]));
}
