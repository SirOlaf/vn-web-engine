/** Prepared CRT text-mode input: CRLF becomes LF and CTRL+Z terminates input.
 * The borrowed raw file remains available for a later binary-mode reopen.
 */
export function windowsTextFileBytes(raw: Uint8Array): Uint8Array {
  const end = raw.indexOf(0x1a);
  const input = end < 0 ? raw : raw.subarray(0, end);
  const output = new Uint8Array(input.length);
  let size = 0;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === 13 && input[i + 1] === 10) continue;
    output[size++] = input[i]!;
  }
  return output.subarray(0, size);
}
