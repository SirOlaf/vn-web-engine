import {PsbFile, type PsbObject, type PsbResource, type PsbValue} from './psb.js';
import {
  EmoteDiagnostics,
  EmoteModelError,
  boolField,
  field,
  floatField,
  floatList,
  has,
  intField,
  listField,
  nullableIntField,
  objectField,
  textField,
  toBool,
  toFloat,
  toInt,
  toList,
  toObject,
  toResource,
  toText,
  unreadKeys,
  type EmoteDiagnostic,
} from './emote-fields.js';
import {readEmoteMetadata, type EmoteMetadata} from './emote-metadata.js';

export {EmoteModelError, type EmoteDiagnostic} from './emote-fields.js';

/**
 * Typed, immutable model of an E-mote motion PSB as `emotedriver.dll` (SHA-256
 * `a3b693b605d67812e489b1fb62cd341012b5514fc9114a032fee4685e70b3a86`) reads it. Every key
 * the runtime reads is a typed field; keys it does not read stay in `unread` as raw PSB
 * values. Addresses in the comments are the native readers in that build.
 *
 * Strictness follows the runtime: a key it reads without a presence test is required and a
 * missing one throws `EmoteModelError` (the runtime aborts with "psb: undefined object key").
 * Keys it tests first take its default. Files of other specs (`krkr`, loaded by
 * `emoteplayer.dll`) lack some keys the D3D runtime requires; those are tolerated, set to
 * `null`, and listed in `diagnostics` as `abort` entries. Texture and icon pixels stay
 * undecoded `PsbResource` views.
 */
export interface EmoteModel {
  /** Root `id`; the version check runs only when it is `"motion"` (0x1002bb30). */
  readonly id: string | null;
  readonly label: string | null;
  /**
   * Root `spec`. The D3D runtime accepts `"win"` and `"common"` (0x1002bb30); `"common"`
   * selects the portable texture-format table (0x10054520).
   */
  readonly spec: string;
  /** Root `version`. Accepted: exactly `EMOTE_MOTION_VERSION` (other values only warn). */
  readonly version: number | null;
  /** `screenSize` (0x1002b9d0). */
  readonly screenSize: EmoteScreenSize;
  /** `source` by name (0x1002bb30; icons resolved by 0x1002c3a0). */
  readonly sources: ReadonlyMap<string, EmoteSource>;
  /** `object` by name; motions resolve by object and motion name (0x1002c1d0). */
  readonly objects: ReadonlyMap<string, EmoteObject>;
  /** Root `easing` curve table referenced by easing indices (0x100293c0); null when absent. */
  readonly easing: readonly EmoteEasingCurve[] | null;
  readonly metadata: EmoteMetadata;
  /** Native aborts and warnings that the reader tolerated. Empty for well-formed `win` files. */
  readonly diagnostics: readonly EmoteDiagnostic[];
  /** Root keys the runtime does not read (for example `stereovisionProfile`). */
  readonly unread: Readonly<Record<string, PsbValue>>;
}

/** The motion file version the runtime accepts: `float 3.03` (0x1002bd39). */
export const EMOTE_MOTION_VERSION = Math.fround(3.03);
/** Specs the D3D runtime accepts; others produce "has not adaptive spec" (0x1002bb30). */
export const EMOTE_DRIVER_SPECS: ReadonlySet<string> = new Set(['win', 'common']);

export interface EmoteScreenSize {
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
}

export interface EmoteSource {
  /** Atlas texture; required by the D3D runtime, absent in `krkr` files. */
  readonly texture: EmoteTexture | null;
  readonly icons: ReadonlyMap<string, EmoteIcon>;
  readonly unread: Readonly<Record<string, PsbValue>>;
}

/** Texture descriptor (0x10054520). Pixel data is never decoded here. */
export interface EmoteTexture {
  /**
   * `win` table: `L8`, `A8`, `A8L8`, `RGBA5650`, `RGBA5551`, `RGBA4444`, `DXT1`, `DXT3`,
   * `DXT5`, `RGBA8`, `RGBX8`. `RGBA8` uploads as `D3DFMT_A8R8G8B8`, `DXT5` as `'DXT5'`.
   */
  readonly type: string;
  readonly width: number;
  readonly height: number;
  /**
   * Optional. When present and the texture fits the device limit, these replace
   * `width`/`height` as the allocated texture size.
   */
  readonly truncatedWidth: number | null;
  readonly truncatedHeight: number | null;
  /** Optional `mip_level`; read and discarded. */
  readonly mipLevel: number | null;
  /** Optional `ast` (bool); selects ETC1/PVRTC variants only. */
  readonly ast: boolean | null;
  readonly pixel: PsbResource;
  /** Optional `mipMapLevel`; `mipMap` is required when it is present and mipmaps are on. */
  readonly mipMapLevel: number | null;
  readonly mipMap: readonly EmoteMipLevel[];
  readonly unread: Readonly<Record<string, PsbValue>>;
}

export interface EmoteMipLevel {
  readonly width: number;
  readonly height: number;
  readonly pixel: PsbResource;
}

/** Icon rectangle (0x1002c3a0). `left`/`top` are absent in `krkr` icons with own pixels. */
export interface EmoteIcon {
  /** Optional, default 0. A null `attr` (krkr icons) aborts natively; it reads as 0. */
  readonly attr: number;
  readonly originX: number;
  readonly originY: number;
  readonly left: number | null;
  readonly top: number | null;
  readonly width: number;
  readonly height: number;
  /** `krkr` only: separate image (`compress: "RL"`), unread by the D3D runtime. */
  readonly pixel: PsbResource | null;
  readonly unread: Readonly<Record<string, PsbValue>>;
}

/** One `easing` curve: segments of parallel `x`/`y`/`p` lists (0x10028a80). */
export type EmoteEasingCurve = readonly EmoteEasingSegment[];
export interface EmoteEasingSegment {
  readonly points: readonly {readonly x: number; readonly y: number; readonly p: number}[];
}

export interface EmoteObject {
  readonly motions: ReadonlyMap<string, EmoteMotion>;
  /** `type`, `metadata`: not read. */
  readonly unread: Readonly<Record<string, PsbValue>>;
}

/** A motion clip (0x10033810). */
export interface EmoteMotion {
  /** `priority` frame list; stored raw by the runtime, evaluation use not mapped. */
  readonly priority: readonly PsbValue[];
  /** `tag` list; stored raw. */
  readonly tag: readonly PsbValue[];
  readonly loopTime: number;
  readonly lastTime: number;
  /** Required by the D3D runtime; absent in `krkr` files. */
  readonly bounds: EmoteBounds | null;
  /** `parameter` (0x10030bc0): the motion's variables. */
  readonly parameters: readonly EmoteParameter[];
  /** Index into `parameters`, or null. */
  readonly parameterize: number | null;
  /** `layerIndexMap` (0x10039df0): name to layer index. Absent in `krkr` files. */
  readonly layerIndexMap: ReadonlyMap<string, number> | null;
  /** Top-level `layer` list; `children` recurse (0x1003a4c0). */
  readonly layers: readonly EmoteLayer[];
  /** `type`, `metadata`, `variable`, `reference*FileList`: not read. */
  readonly unread: Readonly<Record<string, PsbValue>>;
}

export interface EmoteBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** `parameter` entry (0x10030bc0). `enabled` is not read. */
export interface EmoteParameter {
  readonly id: string;
  readonly discretization: boolean;
  readonly rangeBegin: number;
  readonly rangeEnd: number;
  readonly division: number;
  readonly unread: Readonly<Record<string, PsbValue>>;
}

/**
 * Layer type values and the type-specific keys the loader reads (0x100344a0). The numeric
 * value is the native one; names are given only where the payload identifies the kind.
 */
export const EmoteLayerType = {
  /** Reads `objTriPriority`; frames carry `src`/`icon`. */
  Image: 0,
  /** Reads `shape`. */
  Shape: 1,
  /** No payload, no source reference. */
  Group: 2,
  /** Nested motion: reads `motionIndependentLayerInherit`; frames carry `src`/`icon`. */
  Motion: 3,
  /** Reads the `particle*` keys. */
  Particle: 4,
  /** Reads `anchor`. */
  Anchor: 9,
  /** Reads `screenBounds`. */
  ScreenBounds: 10,
  /** Stencil composite: reads `stencilCompositeMaskLayerList`; frames carry `src`/`icon`. */
  StencilComposite: 12,
} as const;

/** Layer types whose frames read `src` and `icon` (bit set 0x1849 at 0x100362b0). */
export const EMOTE_SOURCE_LAYER_TYPES: ReadonlySet<number> = new Set([0, 3, 6, 11, 12]);

/** A layer node (0x100344a0). */
export interface EmoteLayer {
  readonly label: string;
  readonly type: number;
  /** Index into the motion's `parameters`, or null. */
  readonly parameterize: number | null;
  /** Bit set of transform components inherited from the parent; bits not yet mapped. */
  readonly inheritMask: number;
  /** Four integers: the transform composition order. */
  readonly transformOrder: readonly [number, number, number, number];
  /** Optional, default 0. NEKOPARA uses 0 and 5. */
  readonly stencilType: number;
  readonly coordinate: number;
  readonly joinTarget: boolean;
  readonly groundCorrection: boolean;
  /** 0 none; 1 allocates a bezier-patch mesh. */
  readonly meshTransform: number;
  /** Present when `meshTransform` is nonzero. */
  readonly mesh: EmoteLayerMesh | null;
  /** Type 0. */
  readonly objTriPriority: number | null;
  /** Type 1. */
  readonly shape: number | null;
  /** Type 3. */
  readonly motionIndependentLayerInherit: boolean | null;
  /** Type 4. */
  readonly particle: EmoteParticleSettings | null;
  /** Type 9. */
  readonly anchor: number | null;
  /** Type 10. */
  readonly screenBounds: EmoteBounds | null;
  /** Type 12: labels of the layers composited into the stencil mask. */
  readonly stencilCompositeMaskLayerList: readonly string[] | null;
  readonly frames: readonly EmoteFrame[];
  readonly children: readonly EmoteLayer[];
  /** `exportSelf`, `metadata` and keys of other layer types: not read. */
  readonly unread: Readonly<Record<string, PsbValue>>;
}

export interface EmoteLayerMesh {
  readonly syncChildMask: number;
  readonly division: number;
  readonly combine: boolean;
}

export interface EmoteParticleSettings {
  readonly particle: number;
  readonly maxNum: number;
  readonly accelRatio: number;
  readonly inheritAngle: boolean;
  readonly inheritVelocity: number;
  readonly flyDirection: number;
  readonly applyZoomToVelocity: number;
  readonly deleteOutsideScreen: boolean;
  readonly motionList: PsbValue;
  readonly triVolume: boolean;
}

/** A layer keyframe (header 0x10035f50, content 0x100362b0). */
export interface EmoteFrame {
  readonly time: number;
  /**
   * 0: no content (the runtime skips `content`). 2 and 3 carry content; 3 also enables the
   * `ti` and per-channel easing keys. NEKOPARA uses 0, 2 and 3.
   */
  readonly type: number;
  readonly content: EmoteFrameContent | null;
}

/** `content.mask` bits; each gates the keys read (0x100362b0). */
export const EmoteContentMask = {
  Origin: 0x1, // ox, oy
  Coord: 0x2, // coord[3]
  FlipX: 0x4, // fx, fy (either bit reads both)
  FlipY: 0x8,
  Angle: 0x10,
  ZoomX: 0x20, // zx, zy (either bit reads both)
  ZoomY: 0x40,
  SlantX: 0x80, // sx, sy (either bit reads both)
  SlantY: 0x100,
  Color: 0x200,
  Opacity: 0x400,
  CoordEasing: 0x800, // ccc (type 3 frames)
  AngleEasing: 0x1000, // acc
  ZoomEasing: 0x2000, // zcc
  SlantEasing: 0x4000, // scc
  OpacityEasing: 0x8000, // occ
  Cp: 0x10000,
  BlendMode: 0x20000,
  Action: 0x40000, // act; nothing else is read
  Motion: 0x80000,
  Particle: 0x100000,
  Camera: 0x200000,
  Anchor: 0x800000,
  Model: 0x1000000,
  Mesh: 0x2000000,
  Ti: 0x4000000, // ti (type 3 frames)
  Feedback: 0x8000000,
} as const;

/**
 * Keyframe content with the runtime's defaults filled in. Field names are the PSB keys;
 * meanings beyond the key name are noted where the reader shows them.
 */
export interface EmoteFrameContent {
  readonly mask: number;
  /** Source name and icon key (layer types in `EMOTE_SOURCE_LAYER_TYPES`). */
  readonly src: string | null;
  readonly icon: string | null;
  /** Mask 0x40000: when set, the content is only this label. */
  readonly act: string | null;
  /** Default 0. */
  readonly ox: number;
  readonly oy: number;
  /** Default [0, 0, 0]. */
  readonly coord: readonly [number, number, number];
  readonly fx: boolean;
  readonly fy: boolean;
  /** Default 0. */
  readonly angle: number;
  /** Default 1. */
  readonly zx: number;
  readonly zy: number;
  /** Default 0. */
  readonly sx: number;
  readonly sy: number;
  /**
   * Four corner colours (uint32). Default 0x808080ff each; 0xffffffff when the colour group
   * (mask 0x20600) is present without `color` and `bm & 0xf0` is zero. A scalar fills all four.
   */
  readonly color: readonly [number, number, number, number];
  /** Default 255 (stored `& 0xff`). */
  readonly opa: number;
  /** Default 0x10. */
  readonly bm: number;
  /** Type 3 frames with mask 0x4000000; default 0. */
  readonly ti: number;
  /** Indices into the root `easing` table (type 3 frames); null when unset. */
  readonly ccc: number | null;
  readonly acc: number | null;
  readonly zcc: number | null;
  readonly scc: number | null;
  readonly occ: number | null;
  /** Mask 0x10000; parsed by a curve reader not yet mapped (0x1002a870). */
  readonly cp: PsbValue | null;
  readonly mesh: EmoteFrameMesh | null;
  readonly motion: EmoteFrameMotion | null;
  /** Masks 0x100000/0x200000/0x800000/0x1000000/0x8000000, raw (unused by NEKOPARA). */
  readonly prt: PsbValue | null;
  readonly camera: PsbValue | null;
  readonly anchor: PsbValue | null;
  readonly model: PsbValue | null;
  readonly feedback: PsbValue | null;
  readonly unread: Readonly<Record<string, PsbValue>>;
}

/** `mesh` (mask 0x2000000). */
export interface EmoteFrameMesh {
  /**
   * Bezier patch: 16 control points as 32 floats (x, y pairs, read two at a time), or null
   * when the frame does not deform.
   */
  readonly bp: Float32Array | null;
  /** Easing index for the mesh, or null. */
  readonly cc: number | null;
}

/** `motion` (mask 0x80000): nested-motion playback control. */
export interface EmoteFrameMotion {
  readonly mask: number;
  /** Bit 1. */
  readonly flags: number | null;
  /** Bit 2. */
  readonly dt: number | null;
  /** Bit 4. */
  readonly docmpl: boolean | null;
  /** Bit 8. */
  readonly dofst: number | null;
  /** Bit 0x10. */
  readonly dtgt: string | null;
  readonly timeOffset: number;
}

// ---------------------------------------------------------------------------------------

/** Parses a filtered E-mote PSB (`decryptPsbBody` output) or its root value. */
export function readEmoteModel(input: PsbFile | Uint8Array | PsbValue): EmoteModel {
  const root =
    input instanceof PsbFile
      ? input.root
      : input instanceof Uint8Array
        ? new PsbFile(input).root
        : input;
  const diag = new EmoteDiagnostics();
  const o = toObject(root, '$');
  const id = has(o, 'id') ? toText(o.id!, '$.id') : null;
  const spec = textField(o, 'spec', '$');
  const label = has(o, 'label') ? toText(o.label!, '$.label') : null;
  const version = has(o, 'version') ? toFloat(o.version!, '$.version') : null;
  if (id === 'motion') {
    if (!EMOTE_DRIVER_SPECS.has(spec))
      diag.add('message', '$.spec', `spec '${spec}' is not adaptive for emotedriver`);
    if (version === null || version < EMOTE_MOTION_VERSION)
      diag.add('message', '$.version', `version ${version} is too old`);
    else if (version > EMOTE_MOTION_VERSION)
      diag.add('message', '$.version', `version ${version} is too new`);
  }
  const model: EmoteModel = {
    id,
    label,
    spec,
    version,
    screenSize: readScreenSize(objectField(o, 'screenSize', '$')),
    sources: readSources(objectField(o, 'source', '$'), diag),
    objects: readObjects(objectField(o, 'object', '$'), diag),
    easing: has(o, 'easing') ? readEasingTable(listField(o, 'easing', '$')) : null,
    metadata: readEmoteMetadata(objectField(o, 'metadata', '$'), diag),
    diagnostics: diag.entries,
    unread: unreadKeys(o, ROOT_KEYS),
  };
  return Object.freeze(model);
}

const keys = (...k: string[]): ReadonlySet<string> => new Set(k);
const ROOT_KEYS = keys(
  'id',
  'spec',
  'label',
  'version',
  'screenSize',
  'source',
  'object',
  'easing',
  'metadata',
);

function readScreenSize(o: PsbObject): EmoteScreenSize {
  const p = '$.screenSize';
  return Object.freeze({
    width: floatField(o, 'width', p),
    height: floatField(o, 'height', p),
    originX: floatField(o, 'originX', p),
    originY: floatField(o, 'originY', p),
  });
}

/** Reads a key the D3D runtime requires; absent keys become null with an `abort` entry. */
function required<T>(
  diag: EmoteDiagnostics,
  o: PsbObject,
  key: string,
  path: string,
  read: (value: PsbValue, path: string) => T,
): T | null {
  if (!has(o, key)) {
    diag.add('abort', `${path}.${key}`, `psb: undefined object key '${key}' is referenced.`);
    return null;
  }
  return read(o[key]!, `${path}.${key}`);
}

const SOURCE_KEYS = keys('icon', 'texture');
const TEXTURE_KEYS = keys(
  'type',
  'width',
  'height',
  'truncated_width',
  'truncated_height',
  'ast',
  'mip_level',
  'pixel',
  'mipMapLevel',
  'mipMap',
);
const ICON_KEYS = keys('attr', 'originX', 'originY', 'left', 'top', 'width', 'height', 'pixel');

function readSources(o: PsbObject, diag: EmoteDiagnostics): ReadonlyMap<string, EmoteSource> {
  const out = new Map<string, EmoteSource>();
  for (const [name, value] of Object.entries(o)) {
    const p = `$.source.${name}`,
      s = toObject(value, p);
    const icons = new Map<string, EmoteIcon>();
    for (const [key, icon] of Object.entries(objectField(s, 'icon', p)))
      icons.set(key, readIcon(toObject(icon, `${p}.icon.${key}`), `${p}.icon.${key}`, diag));
    out.set(
      name,
      Object.freeze({
        texture: required(diag, s, 'texture', p, (v, tp) => readTexture(toObject(v, tp), tp)),
        icons,
        unread: unreadKeys(s, SOURCE_KEYS),
      }),
    );
  }
  return out;
}

function readTexture(o: PsbObject, p: string): EmoteTexture {
  const opt = <T>(key: string, read: (v: PsbValue, path: string) => T): T | null =>
    has(o, key) ? read(o[key]!, `${p}.${key}`) : null;
  const mipMapLevel = opt('mipMapLevel', toInt);
  const mipMap =
    mipMapLevel === null
      ? []
      : listField(o, 'mipMap', p).map((level, i) => {
          const lp = `${p}.mipMap[${i}]`,
            l = toObject(level, lp);
          return Object.freeze({
            height: intField(l, 'height', lp),
            width: intField(l, 'width', lp),
            pixel: toResource(field(l, 'pixel', lp), `${lp}.pixel`),
          });
        });
  return Object.freeze({
    type: textField(o, 'type', p),
    width: intField(o, 'width', p),
    height: intField(o, 'height', p),
    truncatedWidth: opt('truncated_width', toInt),
    truncatedHeight: opt('truncated_height', toInt),
    mipLevel: opt('mip_level', toInt),
    ast: opt('ast', toBool),
    pixel: toResource(field(o, 'pixel', p), `${p}.pixel`),
    mipMapLevel,
    mipMap: Object.freeze(mipMap),
    unread: unreadKeys(o, TEXTURE_KEYS),
  });
}

function readIcon(o: PsbObject, p: string, diag: EmoteDiagnostics): EmoteIcon {
  return Object.freeze({
    attr: readAttr(o, p, diag),
    originX: floatField(o, 'originX', p),
    originY: floatField(o, 'originY', p),
    left: required(diag, o, 'left', p, toInt),
    top: required(diag, o, 'top', p, toInt),
    width: intField(o, 'width', p),
    height: intField(o, 'height', p),
    pixel: has(o, 'pixel') ? toResource(o.pixel!, `${p}.pixel`) : null,
    unread: unreadKeys(o, ICON_KEYS),
  });
}

/** Optional int, default 0; a null value (krkr icons) is a conversion abort natively. */
function readAttr(o: PsbObject, p: string, diag: EmoteDiagnostics): number {
  if (!has(o, 'attr')) return 0;
  if (o.attr === null) {
    diag.add('abort', `${p}.attr`, "psb: can't convert value to int.");
    return 0;
  }
  return toInt(o.attr!, `${p}.attr`);
}

function readEasingTable(list: readonly PsbValue[]): readonly EmoteEasingCurve[] {
  return Object.freeze(
    list.map((curve, i) =>
      Object.freeze(
        toList(curve, `$.easing[${i}]`).map((segment, j) => {
          const p = `$.easing[${i}][${j}]`,
            s = toObject(segment, p),
            x = listField(s, 'x', p),
            y = listField(s, 'y', p),
            pv = listField(s, 'p', p);
          return Object.freeze({
            points: Object.freeze(
              pv.map((v, k) =>
                Object.freeze({
                  x: toFloat(x[k] ?? null, `${p}.x[${k}]`),
                  y: toFloat(y[k] ?? null, `${p}.y[${k}]`),
                  p: toFloat(v, `${p}.p[${k}]`),
                }),
              ),
            ),
          });
        }),
      ),
    ),
  );
}

const OBJECT_KEYS = keys('motion');
const MOTION_KEYS = keys(
  'priority',
  'tag',
  'loopTime',
  'lastTime',
  'bounds',
  'parameter',
  'parameterize',
  'layerIndexMap',
  'layer',
);
const PARAMETER_KEYS = keys('id', 'discretization', 'rangeBegin', 'rangeEnd', 'division');

function readObjects(o: PsbObject, diag: EmoteDiagnostics): ReadonlyMap<string, EmoteObject> {
  const out = new Map<string, EmoteObject>();
  for (const [name, value] of Object.entries(o)) {
    const p = `$.object.${name}`,
      obj = toObject(value, p),
      motions = new Map<string, EmoteMotion>();
    for (const [motionName, motion] of Object.entries(objectField(obj, 'motion', p)))
      motions.set(
        motionName,
        readMotion(
          toObject(motion, `${p}.motion.${motionName}`),
          `${p}.motion.${motionName}`,
          diag,
        ),
      );
    out.set(name, Object.freeze({motions, unread: unreadKeys(obj, OBJECT_KEYS)}));
  }
  return out;
}

function readBounds(v: PsbValue, p: string): EmoteBounds {
  const b = toObject(v, p);
  return Object.freeze({
    bottom: floatField(b, 'bottom', p),
    right: floatField(b, 'right', p),
    top: floatField(b, 'top', p),
    left: floatField(b, 'left', p),
  });
}

function readMotion(o: PsbObject, p: string, diag: EmoteDiagnostics): EmoteMotion {
  const priority = listField(o, 'priority', p),
    tag = listField(o, 'tag', p),
    loopTime = floatField(o, 'loopTime', p),
    lastTime = floatField(o, 'lastTime', p),
    bounds = required(diag, o, 'bounds', p, readBounds);
  const parameters = Object.freeze(
    listField(o, 'parameter', p).map((value, i) => {
      const pp = `${p}.parameter[${i}]`,
        e = toObject(value, pp);
      return Object.freeze({
        id: textField(e, 'id', pp),
        discretization: boolField(e, 'discretization', pp),
        rangeBegin: floatField(e, 'rangeBegin', pp),
        rangeEnd: floatField(e, 'rangeEnd', pp),
        division: floatField(e, 'division', pp),
        unread: unreadKeys(e, PARAMETER_KEYS),
      });
    }),
  );
  const parameterize = nullableIntField(o, 'parameterize', p);
  const layerIndexMap = required(diag, o, 'layerIndexMap', p, (v, mp) => {
    const map = new Map<string, number>();
    for (const [k, i] of Object.entries(toObject(v, mp))) map.set(k, toInt(i, `${mp}.${k}`));
    return map as ReadonlyMap<string, number>;
  });
  const layers = readLayers(listField(o, 'layer', p), `${p}.layer`, diag);
  return Object.freeze({
    priority,
    tag,
    loopTime,
    lastTime,
    bounds,
    parameters,
    parameterize,
    layerIndexMap,
    layers,
    unread: unreadKeys(o, MOTION_KEYS),
  });
}

const LAYER_KEYS_BASE = [
  'label',
  'parameterize',
  'frameList',
  'inheritMask',
  'transformOrder',
  'type',
  'stencilType',
  'coordinate',
  'joinTarget',
  'groundCorrection',
  'meshTransform',
  'children',
];
const LAYER_MESH_KEYS = ['meshSyncChildMask', 'meshDivision', 'meshCombine'];
const PARTICLE_KEYS = [
  'particle',
  'particleMaxNum',
  'particleAccelRatio',
  'particleInheritAngle',
  'particleInheritVelocity',
  'particleFlyDirection',
  'particleApplyZoomToVelocity',
  'particleDeleteOutsideScreen',
  'particleMotionList',
  'particleTriVolume',
];
const LAYER_TYPE_KEYS: Readonly<Record<number, readonly string[]>> = {
  0: ['objTriPriority'],
  1: ['shape'],
  3: ['motionIndependentLayerInherit'],
  4: PARTICLE_KEYS,
  9: ['anchor'],
  10: ['screenBounds'],
  12: ['stencilCompositeMaskLayerList'],
};
const layerKeySets = new Map<string, ReadonlySet<string>>();
function layerKeys(type: number, mesh: boolean): ReadonlySet<string> {
  const id = `${type}:${mesh}`;
  let set = layerKeySets.get(id);
  if (!set) {
    set = new Set([
      ...LAYER_KEYS_BASE,
      ...(mesh ? LAYER_MESH_KEYS : []),
      ...(LAYER_TYPE_KEYS[type] ?? []),
    ]);
    layerKeySets.set(id, set);
  }
  return set;
}

function readLayers(
  list: readonly PsbValue[],
  p: string,
  diag: EmoteDiagnostics,
): readonly EmoteLayer[] {
  return Object.freeze(
    list.map((v, i) => readLayer(toObject(v, `${p}[${i}]`), `${p}[${i}]`, diag)),
  );
}

function readLayer(o: PsbObject, p: string, diag: EmoteDiagnostics): EmoteLayer {
  const label = textField(o, 'label', p),
    parameterize = nullableIntField(o, 'parameterize', p),
    frameList = listField(o, 'frameList', p),
    inheritMask = intField(o, 'inheritMask', p),
    order = listField(o, 'transformOrder', p);
  if (order.length < 4) throw new EmoteModelError(`${p}.transformOrder: expected 4 entries`);
  const transformOrder = Object.freeze(
    [0, 1, 2, 3].map((i) => toInt(order[i]!, `${p}.transformOrder[${i}]`)),
  ) as unknown as readonly [number, number, number, number];
  const type = intField(o, 'type', p);
  const stencilType = has(o, 'stencilType') ? toInt(o.stencilType!, `${p}.stencilType`) : 0;
  const coordinate = intField(o, 'coordinate', p),
    joinTarget = boolField(o, 'joinTarget', p),
    groundCorrection = boolField(o, 'groundCorrection', p),
    meshTransform = intField(o, 'meshTransform', p);
  const mesh =
    meshTransform !== 0
      ? Object.freeze({
          syncChildMask: intField(o, 'meshSyncChildMask', p),
          division: intField(o, 'meshDivision', p),
          combine: boolField(o, 'meshCombine', p),
        })
      : null;
  const layer: EmoteLayer = {
    label,
    type,
    parameterize,
    inheritMask,
    transformOrder,
    stencilType,
    coordinate,
    joinTarget,
    groundCorrection,
    meshTransform,
    mesh,
    objTriPriority: type === 0 ? intField(o, 'objTriPriority', p) : null,
    shape: type === 1 ? intField(o, 'shape', p) : null,
    motionIndependentLayerInherit:
      type === 3 ? boolField(o, 'motionIndependentLayerInherit', p) : null,
    particle: type === 4 ? readParticle(o, p) : null,
    anchor: type === 9 ? intField(o, 'anchor', p) : null,
    screenBounds: type === 10 ? readBounds(field(o, 'screenBounds', p), `${p}.screenBounds`) : null,
    stencilCompositeMaskLayerList:
      type === 12
        ? Object.freeze(
            listField(o, 'stencilCompositeMaskLayerList', p).map((v, i) =>
              toText(v, `${p}.stencilCompositeMaskLayerList[${i}]`),
            ),
          )
        : null,
    frames: Object.freeze(
      frameList.map((f, i) => readFrame(f, type, `${p}.frameList[${i}]`, diag)),
    ),
    children: readLayers(listField(o, 'children', p), `${p}.children`, diag),
    unread: unreadKeys(o, layerKeys(type, meshTransform !== 0)),
  };
  return Object.freeze(layer);
}

function readParticle(o: PsbObject, p: string): EmoteParticleSettings {
  return Object.freeze({
    particle: intField(o, 'particle', p),
    maxNum: intField(o, 'particleMaxNum', p),
    accelRatio: floatField(o, 'particleAccelRatio', p),
    inheritAngle: boolField(o, 'particleInheritAngle', p),
    inheritVelocity: intField(o, 'particleInheritVelocity', p),
    flyDirection: intField(o, 'particleFlyDirection', p),
    applyZoomToVelocity: intField(o, 'particleApplyZoomToVelocity', p),
    deleteOutsideScreen: boolField(o, 'particleDeleteOutsideScreen', p),
    motionList: field(o, 'particleMotionList', p),
    triVolume: boolField(o, 'particleTriVolume', p),
  });
}

function readFrame(
  value: PsbValue,
  layerType: number,
  p: string,
  diag: EmoteDiagnostics,
): EmoteFrame {
  const o = toObject(value, p),
    time = floatField(o, 'time', p),
    type = intField(o, 'type', p);
  return Object.freeze({
    time,
    type,
    content:
      type === 0
        ? null
        : readContent(objectField(o, 'content', p), layerType, type, `${p}.content`, diag),
  });
}

const DEFAULT_COLOR = 0x808080ff;

function readContent(
  o: PsbObject,
  layerType: number,
  frameType: number,
  p: string,
  diag: EmoteDiagnostics,
): EmoteFrameContent {
  const mask = intField(o, 'mask', p) >>> 0;
  const consumed = new Set(['mask']);
  const get = (key: string): PsbValue => {
    consumed.add(key);
    return field(o, key, p);
  };
  const f = (key: string) => toFloat(get(key), `${p}.${key}`);
  const n = (key: string) => toInt(get(key), `${p}.${key}`);
  const easingRef = (key: string): number | null => {
    const v = get(key);
    return v === null ? null : toInt(v, `${p}.${key}`);
  };
  // Mask 0x40000: the runtime reads `act` and returns (0x10035f50).
  if (mask & EmoteContentMask.Action) {
    const act = toText(get('act'), `${p}.act`);
    return Object.freeze({...emptyContent(mask), act, unread: unreadKeys(o, consumed)});
  }
  const source = EMOTE_SOURCE_LAYER_TYPES.has(layerType);
  const src = source ? toText(get('src'), `${p}.src`) : null,
    icon = !source
      ? null
      : has(o, 'icon')
        ? toText(get('icon'), `${p}.icon`)
        : (diag.add('abort', `${p}.icon`, "psb: undefined object key 'icon' is referenced."), null);
  const has1 = (bits: number) => (mask & bits) !== 0;
  const ox = has1(0x1) ? f('ox') : 0,
    oy = has1(0x1) ? f('oy') : 0;
  let coord: readonly [number, number, number] = ZERO3;
  if (has1(0x2)) {
    const c = toList(get('coord'), `${p}.coord`);
    coord = Object.freeze([0, 1, 2].map((i) => toFloat(c[i] ?? null, `${p}.coord[${i}]`))) as never;
  }
  let opa = 255,
    bm = 0x10,
    color: readonly [number, number, number, number] = DEFAULT_COLOR4;
  if (has1(0x20600)) {
    if (has1(0x400)) opa = n('opa') & 0xff;
    if (has1(0x20000)) bm = n('bm');
    if (has1(0x200)) {
      const c = get('color');
      if (Array.isArray(c)) {
        const list = c as readonly PsbValue[];
        color = Object.freeze(
          [0, 1, 2, 3].map((i) => toInt(list[i] ?? null, `${p}.color[${i}]`) >>> 0),
        ) as never;
      } else {
        const v = toInt(c, `${p}.color`) >>> 0;
        color = Object.freeze([v, v, v, v]) as never;
      }
    } else if ((bm & 0xf0) === 0) color = WHITE4;
  }
  let fx = false,
    fy = false,
    angle = 0,
    zx = 1,
    zy = 1,
    sx = 0,
    sy = 0;
  if (has1(0x1fc)) {
    if (has1(0xc)) {
      fx = toBool(get('fx'), `${p}.fx`);
      fy = toBool(get('fy'), `${p}.fy`);
    }
    if (has1(0x10)) angle = f('angle');
    if (has1(0x60)) {
      zx = f('zx');
      zy = f('zy');
    }
    if (has1(0x180)) {
      sx = f('sx');
      sy = f('sy');
    }
  }
  const tweened = frameType === 3;
  const ti = tweened && has1(0x4000000) ? n('ti') : 0;
  const ease = (bit: number, key: string) => (tweened && has1(bit) ? easingRef(key) : null);
  const ccc = ease(0x800, 'ccc'),
    occ = ease(0x8000, 'occ'),
    acc = ease(0x1000, 'acc'),
    zcc = ease(0x2000, 'zcc'),
    scc = ease(0x4000, 'scc');
  const cp = has1(0x10000) ? get('cp') : null;
  let mesh: EmoteFrameMesh | null = null;
  if (has1(0x2000000)) {
    const m = toObject(get('mesh'), `${p}.mesh`),
      mp = `${p}.mesh`;
    const cc = field(m, 'cc', mp),
      bp = field(m, 'bp', mp);
    let points: Float32Array | null = null;
    if (bp !== null) {
      const list = toList(bp, `${mp}.bp`);
      if (list.length < 32) throw new EmoteModelError(`${mp}.bp: expected 32 values`);
      points = new Float32Array(32);
      for (let i = 0; i < 32; i++) points[i] = toFloat(list[i]!, `${mp}.bp[${i}]`);
    }
    mesh = Object.freeze({bp: points, cc: cc === null ? null : toInt(cc, `${mp}.cc`)});
  }
  const motion = has1(0x80000)
    ? readContentMotion(toObject(get('motion'), `${p}.motion`), `${p}.motion`)
    : null;
  const raw = (bit: number, key: string) => (has1(bit) ? get(key) : null);
  const prt = raw(0x100000, 'prt'),
    camera = raw(0x200000, 'camera'),
    anchor = raw(0x800000, 'anchor'),
    model = raw(0x1000000, 'model'),
    feedback = raw(0x8000000, 'feedback');
  const content: EmoteFrameContent = {
    mask,
    src,
    icon,
    act: null,
    ox,
    oy,
    coord,
    fx,
    fy,
    angle,
    zx,
    zy,
    sx,
    sy,
    color,
    opa,
    bm,
    ti,
    ccc,
    acc,
    zcc,
    scc,
    occ,
    cp,
    mesh,
    motion,
    prt,
    camera,
    anchor,
    model,
    feedback,
    unread: unreadKeys(o, consumed),
  };
  return Object.freeze(content);
}

const ZERO3 = Object.freeze([0, 0, 0]) as readonly [number, number, number];
const DEFAULT_COLOR4 = Object.freeze([
  DEFAULT_COLOR,
  DEFAULT_COLOR,
  DEFAULT_COLOR,
  DEFAULT_COLOR,
]) as readonly [number, number, number, number];
const WHITE4 = Object.freeze([0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff]) as readonly [
  number,
  number,
  number,
  number,
];

function emptyContent(mask: number): Omit<EmoteFrameContent, 'act' | 'unread'> {
  return {
    mask,
    src: null,
    icon: null,
    ox: 0,
    oy: 0,
    coord: ZERO3,
    fx: false,
    fy: false,
    angle: 0,
    zx: 1,
    zy: 1,
    sx: 0,
    sy: 0,
    color: DEFAULT_COLOR4,
    opa: 255,
    bm: 0x10,
    ti: 0,
    ccc: null,
    acc: null,
    zcc: null,
    scc: null,
    occ: null,
    cp: null,
    mesh: null,
    motion: null,
    prt: null,
    camera: null,
    anchor: null,
    model: null,
    feedback: null,
  };
}

function readContentMotion(o: PsbObject, p: string): EmoteFrameMotion {
  const mask = intField(o, 'mask', p);
  return Object.freeze({
    mask,
    flags: mask & 1 ? intField(o, 'flags', p) : null,
    dt: mask & 2 ? intField(o, 'dt', p) : null,
    docmpl: mask & 4 ? boolField(o, 'docmpl', p) : null,
    dofst: mask & 8 ? floatField(o, 'dofst', p) : null,
    dtgt: mask & 0x10 ? textField(o, 'dtgt', p) : null,
    timeOffset: floatField(o, 'timeOffset', p),
  });
}

/** Walks every layer of a motion depth-first, parents before children. */
export function* walkEmoteLayers(
  layers: readonly EmoteLayer[],
  depth = 0,
): Generator<{layer: EmoteLayer; depth: number}> {
  for (const layer of layers) {
    yield {layer, depth};
    yield* walkEmoteLayers(layer.children, depth + 1);
  }
}
