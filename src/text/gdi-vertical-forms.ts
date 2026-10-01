/**
 * Emulation of GDI's vertical `@` faces for glyph cells. Engines that write vertically create
 * the font as `@` + name, rasterize a glyph into the same cell as horizontal text and rotate
 * the cell clockwise. The result is the horizontal glyph for most full-width characters; the
 * font's vertical alternates (its `vert` substitutions) move punctuation and small kana to
 * the upper right and turn brackets, dashes and lines. Browsers do not expose `vert` to
 * canvas text, so the alternates are rebuilt from the horizontal glyph by the transforms
 * below, measured from GDI at 240 pixels. Half-width characters are not substituted: the
 * clockwise rotation lays them on their side.
 */

/** A coverage cell: `width` x `height` levels, row by row. */
export interface GlyphCell {
  readonly width: number;
  readonly height: number;
  readonly levels: Uint8Array;
}

/**
 * How a vertical alternate derives from the horizontal glyph: turned (N none, R clockwise,
 * L anticlockwise, F half a turn, T mirrored across the main diagonal, A across the other),
 * then moved by (dx, dy) in 1/240 of the cell.
 */
interface VerticalForm {
  readonly turn: 'N' | 'R' | 'L' | 'F' | 'T' | 'A';
  readonly dx: number;
  readonly dy: number;
}

function forms(spec: string): ReadonlyMap<string, VerticalForm> {
  const map = new Map<string, VerticalForm>();
  for (const entry of spec.split(';')) {
    const match = /^(.)([NRLFTA])(-?\d+),(-?\d+)$/u.exec(entry);
    if (!match) throw new Error(`Invalid vertical form ${entry}`);
    map.set(match[1]!, {
      turn: match[2] as VerticalForm['turn'],
      dx: Number(match[3]),
      dy: Number(match[4]),
    });
  }
  return map;
}

/** ＭＳ 明朝. Circled and squared symbols and 〝〟 have distinct vertical designs and are kept. */
const MINCHO = forms(
  '、N146,-161;。N156,-159;，N168,-149;．N164,-154;：L-28,-1;￣L230,-1;＿L-216,-1;ーT4,1;―R0,0;' +
    '‐R-1,0;∥L1,-1;｜R-1,-1;…L0,-1;‥L0,-1;’F-139,-152;～T1,-1;（R0,0;）R0,0;〔R0,0;〕R0,0;' +
    '［R0,0;］R0,0;｛R0,0;｝R0,0;〈R0,0;〉R0,0;《R0,0;》R0,-2;「R-1,0;」R-1,0;『R-1,0;』R-1,0;' +
    '【R0,0;】R0,0;＝R-1,0;→R-1,0;←R-1,0;↑R-1,0;↓R-1,0;〓R-1,0;ぁN21,-23;ぃN18,-21;ぅN24,-21;' +
    'ぇN19,-22;ぉN18,-20;っN17,-25;ゃN17,-22;ゅN16,-22;ょN19,-28;ゎN17,-23;ァN21,-24;ィN19,-23;' +
    'ゥN19,-22;ェN18,-20;ォN15,-23;ッN15,-28;ャN19,-23;ュN19,-23;ョN19,-24;ヮN19,-24;ヵN20,-24;' +
    'ヶN19,-20;─R0,0;│L0,-1;┌R-1,0;┐R-1,0;┘R0,0;└R0,0;├R0,0;┬R-1,0;┤R0,0;┴R0,0;━R-1,0;' +
    '┃L0,-1;┏R-1,0;┓R-1,0;┛R-1,0;┗R-1,0;┣R0,0;┳R-1,0;┫R0,0;┻R-1,0;┠R0,0;┯R-1,0;┨R0,0;' +
    '┷R-1,0;┿R0,0;┝R0,0;┰R-1,0;┥R0,0;┸R0,0;╂L-1,-1',
);

/** ＭＳ ゴシック, and the shapes used for other fonts. */
const GOTHIC = forms(
  '、N140,-155;。L1,-140;，N174,-155;．F2,-10;：L-23,-5;￣L226,-1;＿L-228,-1;ーR-1,-1;―R0,0;' +
    '‐R24,0;∥L0,-3;｜R-1,-1;…R0,0;‥R0,-1;’F-164,-154;～A0,-1;（R-1,0;）R-1,0;〔R-1,2;〕R-1,-3;' +
    '［R2,-12;］R2,11;｛R7,15;｝R3,-15;〈R-1,4;〉R-1,1;《R-1,0;》R-1,0;「R-2,-1;」R-1,0;' +
    '『R-1,-7;』R-1,6;【R-1,1;】R-1,-1;＝R0,-1;→R0,-1;←R0,-1;↑R0,-1;↓R0,-1;〓R0,-1;ぁN19,-19;' +
    'ぃN29,-20;ぅN23,-21;ぇN24,-19;ぉN21,-23;っN22,-23;ゃN22,-22;ゅN27,-21;ょN19,-22;ゎN23,-19;' +
    'ァN23,-22;ィN23,-24;ゥN23,-20;ェN21,-21;ォN22,-20;ッN21,-20;ャN21,-19;ュN23,-19;ョN20,-20;' +
    'ヮN21,-23;ヵN21,-20;ヶN20,-20;─R0,0;│L0,-1;┌R-1,0;┐R-1,0;┘R0,0;└R0,0;├R0,0;┬R-1,0;' +
    '┤R0,0;┴R0,0;━R-1,0;┃L0,-1;┏R-1,0;┓R-1,0;┛R-1,0;┗R-1,0;┣R0,0;┳R-1,0;┫R0,0;┻R-1,0;' +
    '┠R0,0;┯R-1,0;┨R0,0;┷R-1,0;┿R0,0;┝R0,0;┰R-1,0;┥R0,0;┸R0,0;╂L-1,-1',
);

/** The alternates of a face name: mincho designs, or gothic ones for every other face. */
export function gdiVerticalForms(face: string): 'mincho' | 'gothic' {
  return /明朝|mincho/i.test(face) ? 'mincho' : 'gothic';
}

/** Turns a cell clockwise: a w x h cell becomes h x w, each row a source column bottom-up. */
export function rotateCellClockwise(cell: GlyphCell): GlyphCell {
  const {width, height, levels} = cell;
  const out = new Uint8Array(width * height);
  for (let row = 0; row < width; row++)
    for (let column = 0; column < height; column++)
      out[row * height + column] = levels[(height - 1 - column) * width + row]!;
  return {width: height, height: width, levels: out};
}

/**
 * The vertical cell of a character whose horizontal cell is `cell`: half-width cells are
 * turned clockwise, full-width alternates are rebuilt, and other characters keep their
 * horizontal glyph.
 */
export function gdiVerticalCell(
  character: string,
  cell: GlyphCell,
  design: 'mincho' | 'gothic',
): GlyphCell {
  if (cell.width !== cell.height) return rotateCellClockwise(cell);
  const form = (design === 'mincho' ? MINCHO : GOTHIC).get(character);
  if (!form) return cell;
  const n = cell.width,
    source = cell.levels,
    out = new Uint8Array(n * n);
  const dx = Math.round((form.dx * n) / 240),
    dy = Math.round((form.dy * n) / 240);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let sx: number, sy: number;
      switch (form.turn) {
        case 'R':
          sx = y;
          sy = n - 1 - x;
          break;
        case 'L':
          sx = n - 1 - y;
          sy = x;
          break;
        case 'F':
          sx = n - 1 - x;
          sy = n - 1 - y;
          break;
        case 'T':
          sx = y;
          sy = x;
          break;
        case 'A':
          sx = n - 1 - y;
          sy = n - 1 - x;
          break;
        default:
          sx = x;
          sy = y;
      }
      const tx = x + dx,
        ty = y + dy;
      if (tx >= 0 && tx < n && ty >= 0 && ty < n) out[ty * n + tx] = source[sy * n + sx]!;
    }
  return {width: n, height: n, levels: out};
}
