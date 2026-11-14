import {
  FreeType,
  type FreeTypeFace,
  type FreeTypeGlyph,
  type FreeTypeMetrics,
  type FreeTypeSizeRequest,
} from './freetype.js';

export type FreeTypeRequest =
  | {id: number; kind: 'open'; bytes: Uint8Array; faceIndex: number}
  | {id: number; kind: 'metrics'; face: number}
  | {id: number; kind: 'size'; face: number; type: 0 | 1 | 2 | 3 | 4; width: number; height: number}
  | {
      id: number;
      kind: 'glyph';
      face: number;
      codePoint: number;
      flags: number;
      bold: boolean;
      shear: number;
      size?: FreeTypeSizeRequest;
    }
  | {id: number; kind: 'close'; face: number};
export interface FreeTypeResponse {
  id: number;
  error?: string;
  value?: number | FreeTypeMetrics | FreeTypeGlyph;
}
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<FreeTypeRequest>) => void) | null;
  postMessage(value: FreeTypeResponse, transfers: Transferable[]): void;
};
let library: FreeType | undefined;
let nextFace = 0;
const faces = new Map<number, FreeTypeFace>();
scope.onmessage = ({data}) => {
  let value: FreeTypeResponse['value'];
  try {
    if (data.kind === 'open') {
      library ??= new FreeType();
      const face = library.open(data.bytes, data.faceIndex);
      value = ++nextFace;
      faces.set(value, face);
    } else {
      const face = faces.get(data.face);
      if (!face) throw Error('FreeType worker face closed');
      if (data.kind === 'metrics') value = face.metrics;
      else if (data.kind === 'size') {
        face.requestSize(data.type, data.width, data.height);
        value = face.metrics;
      } else if (data.kind === 'glyph') value = face.rasterize(data.codePoint, data);
      else if (data.kind === 'close') {
        face.close();
        faces.delete(data.face);
      } else throw Error('Unsupported FreeType worker operation');
    }
    scope.postMessage(
      {id: data.id, value},
      value && typeof value === 'object' && 'pixels' in value ? [value.pixels.buffer] : [],
    );
  } catch (error) {
    scope.postMessage({id: data.id, error: String(error)}, []);
  }
};
