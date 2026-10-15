import {measureD3D9Shader, parseD3D9Shader, type D3D9Shader} from './bytecode.js';

export interface EmbeddedD3D9Shader {
  /** Byte offset of the version token within the scanned bytes. */
  offset: number;
  /** A view into the scanned bytes, version token through end token. */
  bytes: Uint8Array;
  shader: D3D9Shader;
}

/** Find D3D9 SM2/SM3 token streams embedded in arbitrary data (for example a DLL's
 * .rdata). A candidate starts with a vs/ps 2.x or 3.0 version token, walks to a
 * 0x0000FFFF end token through valid instruction and comment lengths, and must parse.
 * Matches do not overlap; the scan resumes after each accepted stream. */
export function findEmbeddedD3D9Shaders(bytes: Uint8Array): EmbeddedD3D9Shader[] {
  const found: EmbeddedD3D9Shader[] = [];
  for (let i = 0; i + 8 <= bytes.byteLength; i++) {
    if (bytes[i + 3] !== 0xff || (bytes[i + 2] !== 0xfe && bytes[i + 2] !== 0xff)) continue;
    if (bytes[i + 1] !== 2 && bytes[i + 1] !== 3) continue;
    const length = measureD3D9Shader(bytes, i);
    if (length === undefined) continue;
    const view = bytes.subarray(i, i + length);
    let shader: D3D9Shader;
    try {
      shader = parseD3D9Shader(view);
    } catch {
      continue;
    }
    found.push({offset: i, bytes: view, shader});
    i += length - 1;
  }
  return found;
}
