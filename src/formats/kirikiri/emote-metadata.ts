import {emoteDriverImage, EMOTE_DRIVER_X64_SHA256} from './psb-filter.js';
import type {PsbObject, PsbValue} from './psb.js';
import {
  type EmoteDiagnosticSink,
  boolField,
  field,
  floatField,
  has,
  intField,
  listField,
  objectField,
  textField,
  toBool,
  toFloat,
  toInt,
  toList,
  toObject,
  toText,
  unreadKeys,
} from './emote-fields.js';

/**
 * `metadata` of an E-mote PSB as `emotedriver.dll` (SHA-256 `a3b693b6…5e70b3a86`) reads it.
 * Entry 0x1000e460 (`format`, `version`, `base`), controls 0x10010ee0; per-control readers
 * are noted on each type. Controls gated by `enabled` are skipped by the runtime when it is
 * false, without reading their other keys; such entries are `EmoteDisabledControl`.
 */
export interface EmoteMetadata {
  /** Optional; the runtime compares it with `"emote"`. */
  readonly format: string | null;
  /** Optional; read when `format` is `"emote"` and the value is at least 1, then unused. */
  readonly version: number | null;
  readonly base: {readonly chara: string; readonly motion: string};
  /** Initial horizontal mirroring. */
  readonly mirror: boolean;
  /** Model scale; the runtime also stores its reciprocal. */
  readonly scale: number;
  /** x64 metadata fields; absent on the x86 reader's result. */
  readonly suitableClearColor?: {readonly r: number; readonly g: number; readonly b: number} | null;
  readonly immediateControl?: readonly string[];
  readonly charaProfile?: EmoteCharaProfile | null;
  readonly orbitControl?: readonly (EmoteOrbitControl | EmoteDisabledControl)[];
  readonly bustControl: readonly (EmoteBustControl | EmoteDisabledControl)[];
  readonly hairControl: readonly (EmotePendulumControl | EmoteDisabledControl)[];
  readonly partsControl: readonly (EmotePendulumControl | EmoteDisabledControl)[];
  readonly eyeControl: readonly (EmoteEyeControl | EmoteDisabledControl)[];
  readonly eyebrowControl: readonly (EmoteEyebrowControl | EmoteDisabledControl)[];
  readonly mouthControl: readonly (EmoteMouthControl | EmoteDisabledControl)[];
  readonly transitionControl: readonly (EmoteTransitionControl | EmoteDisabledControl)[];
  /** Optional. */
  readonly selectorControl: readonly (EmoteSelectorControl | EmoteDisabledControl)[] | null;
  readonly clampControl: readonly (EmoteClampControl | EmoteDisabledControl)[];
  readonly loopControl?: readonly (EmoteLoopControl | EmoteDisabledControl)[];
  /** `mirrorControl.variableMatchList` (0x1001c4f0): variable-name fragments. */
  readonly mirrorControl: EmoteVariableMatch;
  /** Optional `instantVariableList` (0x10012c20). */
  readonly instantVariableList: readonly string[] | null;
  readonly timelineControl: readonly EmoteTimeline[];
  /** Optional `stereovisionControl` (0x1001f610). */
  readonly stereovisionControl: EmoteVariableMatch | null;
  /** Optional `variableList`: named frames of the motion variables (inline in 0x10010ee0). */
  readonly variableList: readonly EmoteVariableFrames[] | null;
  /** `catalog`, `customPartsOrder`, `editLock`, `psd*ImportInfo*`: editor data, not read. */
  readonly unread: Readonly<Record<string, PsbValue>>;
}

export interface EmoteCharaProfile {
  readonly height: number;
  readonly markers: readonly {readonly label: string; readonly value: number}[];
}

/** `orbitControl` entry: a value list cycled over `interval` frames. */
export interface EmoteOrbitControl {
  readonly enabled: true;
  readonly label: string;
  readonly interval: number;
  readonly tween: boolean;
  readonly orbitFrameList: readonly number[];
  readonly unread: Readonly<Record<string, PsbValue>>;
}

export interface EmoteX64Metadata extends EmoteMetadata {
  readonly suitableClearColor: {readonly r: number; readonly g: number; readonly b: number} | null;
  readonly immediateControl: readonly string[];
  readonly charaProfile: EmoteCharaProfile | null;
  readonly orbitControl: readonly (EmoteOrbitControl | EmoteDisabledControl)[];
  readonly selectorControl: readonly (EmoteSelectorControl | EmoteDisabledControl)[];
}

export interface EmoteDisabledControl {
  readonly enabled: false;
  readonly raw: PsbObject;
}

export interface EmoteVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** `bustControl` entry (0x100131e0; `param` 0x10013070, physics 0x10012ef0). */
export interface EmoteBustControl {
  readonly enabled: true;
  /** Initial spring state: `op`, `p`, `pv` vectors and `ofs`. */
  readonly param: {
    readonly op: EmoteVec3;
    readonly p: EmoteVec3;
    readonly pv: EmoteVec3;
    readonly ofs: number;
  };
  readonly gravity: number;
  readonly spring: number;
  readonly friction: number;
  readonly scale_x: number;
  readonly scale_y: number;
  readonly baseLayer: string;
  readonly var_lr: string;
  readonly var_ud: string;
  /** `label`, `parameter`: not read. */
  readonly unread: Readonly<Record<string, PsbValue>>;
}

/**
 * `hairControl` and `partsControl` entries: a two-segment pendulum (0x10014900;
 * `param` 0x10013f40, physics 0x10014390).
 */
export interface EmotePendulumControl {
  readonly enabled: true;
  readonly param: {
    readonly op: EmoteVec3;
    readonly ofs: number;
    readonly bendR: number;
    readonly bendS: number;
    /** Two entries each. */
    readonly bp: readonly [EmoteVec3, EmoteVec3];
    readonly p: readonly [EmoteVec3, EmoteVec3];
    readonly pv: readonly [EmoteVec3, EmoteVec3];
  };
  readonly gravity: number;
  readonly friction_x: number;
  readonly friction_y: number;
  readonly b_rate: number;
  readonly v_bound: number;
  readonly ud_eft: number;
  readonly bend_spd: number;
  readonly bend_vol: number;
  /** Per segment (two entries each). */
  readonly length: readonly [number, number];
  readonly scale_x: readonly [number, number];
  readonly scale_y: readonly [number, number];
  readonly baseLayer: string;
  readonly var_lr: string;
  readonly var_lrm: string;
  readonly var_ud: string;
  readonly unread: Readonly<Record<string, PsbValue>>;
}

/** `eyeControl` entry: automatic blink (0x10015890). */
export interface EmoteEyeControl {
  readonly enabled: true;
  readonly label: string;
  readonly beginFrame: number;
  readonly endFrame: number;
  readonly blinkIntervalMin: number;
  readonly blinkIntervalMax: number;
  readonly blinkFrameCount: number;
  readonly blinkEnabled: boolean;
  /** Integer pairs. */
  readonly edge: readonly (readonly [number, number])[];
  readonly node: readonly (readonly number[])[];
  readonly unread: Readonly<Record<string, PsbValue>>;
}

/** `eyebrowControl` entry (0x100171f0). */
export interface EmoteEyebrowControl {
  readonly enabled: true;
  readonly label: string;
  readonly beginFrame: number;
  readonly edge: readonly (readonly [number, number])[];
  readonly node: readonly (readonly number[])[];
  readonly unread: Readonly<Record<string, PsbValue>>;
}

/** `mouthControl` entry: lip sync target (0x10018920). */
export interface EmoteMouthControl {
  readonly enabled: true;
  readonly label: string;
  readonly talkLabel: string;
  readonly beginFrame: number;
  readonly unread: Readonly<Record<string, PsbValue>>;
}

/** `transitionControl` entry: a variable whose changes are smoothed (0x100193d0). */
export interface EmoteTransitionControl {
  readonly enabled: true;
  readonly label: string;
  readonly unread: Readonly<Record<string, PsbValue>>;
}

/** `selectorControl` entry (0x10019a50); not gated by `enabled`. */
export interface EmoteSelectorControl {
  /** X64 gates selectors by this field; the x86 reader leaves it in unread. */
  readonly enabled?: true;
  readonly label: string;
  readonly optionList: readonly {
    readonly label: string;
    readonly offValue: number;
    readonly onValue: number;
  }[];
  readonly unread: Readonly<Record<string, PsbValue>>;
}

/** `clampControl` entry (0x1001b8c0). */
export interface EmoteClampControl {
  readonly enabled: true;
  readonly type: number;
  readonly var_lr: string;
  readonly var_ud: string;
  readonly min: number;
  readonly max: number;
  /** `label`: not read. */
  readonly unread: Readonly<Record<string, PsbValue>>;
}

/** `loopControl` entry (0x1001a7f0). */
export interface EmoteLoopControl {
  readonly enabled: true;
  /** Float triples. */
  readonly transitionList: readonly (readonly [number, number, number])[];
  readonly var_loop: string;
  readonly unread: Readonly<Record<string, PsbValue>>;
}

export interface EmoteVariableMatch {
  readonly variableMatchList: readonly string[];
}

/**
 * `timelineControl` entry. The list reader (0x1001d4a0) reads `label` and optional `diff`;
 * the body (0x1001d980) is read when the timeline is instantiated.
 */
export interface EmoteTimeline {
  readonly label: string;
  /** Optional, default false: a difference (additive) timeline. */
  readonly diff: boolean;
  readonly loopBegin: number;
  readonly loopEnd: number;
  /** A negative value is replaced by the latest frame time. */
  readonly lastTime: number;
  readonly variables: readonly EmoteTimelineVariable[];
  readonly unread: Readonly<Record<string, PsbValue>>;
}

export interface EmoteTimelineVariable {
  readonly label: string;
  readonly frames: readonly EmoteTimelineFrame[];
}

export interface EmoteTimelineFrame {
  readonly time: number;
  /** 0: no content. NEKOPARA uses 0 and 2. */
  readonly type: number;
  /**
   * Target value, or null for type 0. A string is kept raw: the D3D runtime cannot convert
   * it and aborts (it occurs only in `krkr` files).
   */
  readonly value: number | string | null;
  readonly easing: number | null;
}

export interface EmoteVariableFrames {
  readonly label: string;
  readonly frames: readonly {readonly label: string; readonly frame: number}[];
}

const keys = (...k: string[]): ReadonlySet<string> => new Set(k);
const METADATA_KEYS = keys(
  'format',
  'version',
  'base',
  'mirror',
  'scale',
  'bustControl',
  'hairControl',
  'partsControl',
  'eyeControl',
  'eyebrowControl',
  'mouthControl',
  'transitionControl',
  'selectorControl',
  'clampControl',
  'loopControl',
  'mirrorControl',
  'instantVariableList',
  'timelineControl',
  'stereovisionControl',
  'variableList',
);

const METADATA_X64_KEYS = keys(
  'format',
  'version',
  'base',
  'mirror',
  'scale',
  'variableList',
  'suitableClearColor',
  'bustControl',
  'hairControl',
  'partsControl',
  'eyeControl',
  'eyebrowControl',
  'mouthControl',
  'transitionControl',
  'selectorControl',
  'immediateControl',
  'clampControl',
  'mirrorControl',
  'instantVariableList',
  'timelineControl',
  'stereovisionControl',
  'charaProfile',
  'orbitControl',
);

/** x64 defaults (table 0x181fcc8a0), used when immediateControl is absent. */
export const EMOTE_DEFAULT_IMMEDIATE = Object.freeze(['face_cheek', 'face_tears', 'face_eye_hi']);

export function readEmoteMetadata(
  o: PsbObject,
  diag: EmoteDiagnosticSink,
  driverSha256: typeof EMOTE_DRIVER_X64_SHA256,
): EmoteX64Metadata;
export function readEmoteMetadata(
  o: PsbObject,
  diag: EmoteDiagnosticSink,
  driverSha256?: string,
): EmoteMetadata;
export function readEmoteMetadata(
  o: PsbObject,
  diag: EmoteDiagnosticSink,
  driverSha256?: string,
): EmoteMetadata {
  if (emoteDriverImage(driverSha256) === EMOTE_DRIVER_X64_SHA256) return readX64Metadata(o, diag);
  const p = '$.metadata';
  const format = has(o, 'format') ? toText(o.format!, `${p}.format`) : null;
  let version: number | null = null;
  if (format === 'emote' && has(o, 'version')) {
    const v = toFloat(o.version!, `${p}.version`);
    if (v >= 1) version = v;
  }
  const base = objectField(o, 'base', p);
  const list = (key: string) => listField(o, key, p);
  const optionalList = (key: string) => (has(o, key) ? listField(o, key, p) : null);
  const selector = optionalList('selectorControl');
  const instant = optionalList('instantVariableList');
  const stereo = has(o, 'stereovisionControl')
    ? readVariableMatch(objectField(o, 'stereovisionControl', p), `${p}.stereovisionControl`)
    : null;
  const variables = optionalList('variableList');
  return Object.freeze({
    format,
    version,
    base: Object.freeze({
      chara: textField(base, 'chara', `${p}.base`),
      motion: textField(base, 'motion', `${p}.base`),
    }),
    mirror: boolField(o, 'mirror', p),
    scale: floatField(o, 'scale', p),
    bustControl: entries(list('bustControl'), `${p}.bustControl`, true, readBust),
    hairControl: entries(list('hairControl'), `${p}.hairControl`, true, readPendulum),
    partsControl: entries(list('partsControl'), `${p}.partsControl`, true, readPendulum),
    eyeControl: entries(list('eyeControl'), `${p}.eyeControl`, true, readEye),
    eyebrowControl: entries(list('eyebrowControl'), `${p}.eyebrowControl`, true, readEyebrow),
    mouthControl: entries(list('mouthControl'), `${p}.mouthControl`, true, readMouth),
    transitionControl: entries(
      list('transitionControl'),
      `${p}.transitionControl`,
      true,
      readTransition,
    ),
    selectorControl:
      selector &&
      (entries(selector, `${p}.selectorControl`, false, readSelector) as EmoteSelectorControl[]),
    clampControl: entries(list('clampControl'), `${p}.clampControl`, true, readClamp),
    loopControl: entries(list('loopControl'), `${p}.loopControl`, true, readLoop),
    mirrorControl: readVariableMatch(objectField(o, 'mirrorControl', p), `${p}.mirrorControl`),
    instantVariableList:
      instant && Object.freeze(instant.map((v, i) => toText(v, `${p}.instantVariableList[${i}]`))),
    timelineControl: Object.freeze(
      list('timelineControl').map((v, i) =>
        readTimeline(toObject(v, `${p}.timelineControl[${i}]`), `${p}.timelineControl[${i}]`, diag),
      ),
    ),
    stereovisionControl: stereo,
    variableList: variables && Object.freeze(variables.map((v, i) => readVariable(v, i))),
    unread: unreadKeys(o, METADATA_KEYS),
  });
}

function readX64Metadata(o: PsbObject, diag: EmoteDiagnosticSink): EmoteX64Metadata {
  const p = '$.metadata';
  const format = has(o, 'format') ? toText(o.format!, `${p}.format`) : null;
  let version: number | null = null;
  if (format === 'emote' && has(o, 'version')) {
    const v = toFloat(o.version!, `${p}.version`);
    if (v >= 1) version = v;
  }
  const base = objectField(o, 'base', p);
  const list = (key: string) => listField(o, key, p);
  const optionalList = (key: string) => (has(o, key) ? listField(o, key, p) : null);
  const gated = <T>(key: string, read: (o: PsbObject, path: string) => T) =>
    entries(list(key), `${p}.${key}`, true, read);
  const clear = has(o, 'suitableClearColor') ? objectField(o, 'suitableClearColor', p) : null;
  const cp = `${p}.suitableClearColor`;
  const variables = optionalList('variableList');
  const eye = has(o, 'eyeControl');
  const clamp = eye && has(o, 'clampControl');
  const timeline = clamp && has(o, 'timelineControl');
  const instant = clamp ? optionalList('instantVariableList') : null;
  const immediate = eye && has(o, 'immediateControl') ? list('immediateControl') : null;
  return Object.freeze({
    format,
    version,
    base: Object.freeze({
      chara: textField(base, 'chara', `${p}.base`),
      motion: textField(base, 'motion', `${p}.base`),
    }),
    mirror: boolField(o, 'mirror', p),
    scale: floatField(o, 'scale', p),
    suitableClearColor:
      clear &&
      Object.freeze({
        r: intField(clear, 'r', cp),
        g: intField(clear, 'g', cp),
        b: intField(clear, 'b', cp),
      }),
    bustControl: gated('bustControl', readBust),
    hairControl: gated('hairControl', readPendulum),
    partsControl: gated('partsControl', readPendulum),
    eyeControl: eye ? gated('eyeControl', readEye) : [],
    eyebrowControl: eye ? gated('eyebrowControl', readEyebrow) : [],
    mouthControl: eye ? gated('mouthControl', readMouth) : [],
    transitionControl: eye ? gated('transitionControl', readTransition) : [],
    selectorControl:
      eye && has(o, 'selectorControl')
        ? gated('selectorControl', (o, p) => readSelector(o, p, true))
        : [],
    immediateControl: !eye
      ? []
      : immediate
        ? Object.freeze(
            immediate.flatMap((v, i) => {
              const ip = `${p}.immediateControl[${i}]`,
                entry = toObject(v, ip);
              return boolField(entry, 'enabled', ip) ? [textField(entry, 'label', ip)] : [];
            }),
          )
        : EMOTE_DEFAULT_IMMEDIATE,
    clampControl: clamp ? gated('clampControl', readClamp) : [],
    mirrorControl: clamp
      ? readVariableMatch(objectField(o, 'mirrorControl', p), `${p}.mirrorControl`)
      : Object.freeze({variableMatchList: Object.freeze([])}),
    instantVariableList:
      instant && Object.freeze(instant.map((v, i) => toText(v, `${p}.instantVariableList[${i}]`))),
    timelineControl: timeline
      ? Object.freeze(
          list('timelineControl').map((v, i) =>
            readTimeline(
              toObject(v, `${p}.timelineControl[${i}]`),
              `${p}.timelineControl[${i}]`,
              diag,
            ),
          ),
        )
      : [],
    stereovisionControl:
      timeline && has(o, 'stereovisionControl')
        ? readVariableMatch(objectField(o, 'stereovisionControl', p), `${p}.stereovisionControl`)
        : null,
    charaProfile:
      timeline && has(o, 'charaProfile')
        ? readCharaProfile(objectField(o, 'charaProfile', p), `${p}.charaProfile`)
        : null,
    orbitControl: timeline && has(o, 'orbitControl') ? gated('orbitControl', readOrbit) : [],
    variableList: variables && Object.freeze(variables.map((v, i) => readVariable(v, i))),
    unread: unreadKeys(o, METADATA_X64_KEYS),
  });
}

function readCharaProfile(o: PsbObject, p: string): EmoteCharaProfile {
  const markers = objectField(o, 'pixelMarker', p);
  return Object.freeze({
    height: floatField(o, 'height', p),
    markers: Object.freeze(
      Object.keys(markers).map((label) =>
        Object.freeze({label, value: floatField(markers, label, `${p}.pixelMarker`)}),
      ),
    ),
  });
}

function readOrbit(o: PsbObject, p: string): EmoteOrbitControl {
  return Object.freeze({
    enabled: true,
    label: textField(o, 'label', p),
    interval: floatField(o, 'interval', p),
    tween: boolField(o, 'tween', p),
    orbitFrameList: Object.freeze(
      listField(o, 'orbitFrameList', p).map((v, i) => toFloat(v, `${p}.orbitFrameList[${i}]`)),
    ),
    unread: unreadKeys(o, ORBIT_KEYS),
  });
}
const ORBIT_KEYS = keys('enabled', 'label', 'interval', 'tween', 'orbitFrameList');

/** Reads a control list; with `gated`, entries whose `enabled` is false stay raw. */
function entries<T>(
  values: readonly PsbValue[],
  path: string,
  gated: boolean,
  read: (o: PsbObject, path: string) => T,
): readonly (T | EmoteDisabledControl)[] {
  return Object.freeze(
    values.map((value, i) => {
      const p = `${path}[${i}]`,
        o = toObject(value, p);
      if (gated && !boolField(o, 'enabled', p))
        return Object.freeze({enabled: false as const, raw: o});
      return read(o, p);
    }),
  );
}

function vec3(value: PsbValue, p: string): EmoteVec3 {
  const o = toObject(value, p);
  return Object.freeze({
    x: floatField(o, 'x', p),
    y: floatField(o, 'y', p),
    z: floatField(o, 'z', p),
  });
}

/** Exactly two entries are read (indices 0 and 1). */
function pair<T>(values: readonly PsbValue[], p: string, read: (v: PsbValue, p: string) => T) {
  return Object.freeze([
    read(values[0] ?? null, `${p}[0]`),
    read(values[1] ?? null, `${p}[1]`),
  ]) as readonly [T, T];
}

function readBust(o: PsbObject, p: string): EmoteBustControl {
  const param = objectField(o, 'param', p),
    pp = `${p}.param`;
  return Object.freeze({
    enabled: true,
    param: Object.freeze({
      op: vec3(field(param, 'op', pp), `${pp}.op`),
      p: vec3(field(param, 'p', pp), `${pp}.p`),
      pv: vec3(field(param, 'pv', pp), `${pp}.pv`),
      ofs: floatField(param, 'ofs', pp),
    }),
    gravity: floatField(o, 'gravity', p),
    spring: floatField(o, 'spring', p),
    friction: floatField(o, 'friction', p),
    scale_x: floatField(o, 'scale_x', p),
    scale_y: floatField(o, 'scale_y', p),
    baseLayer: textField(o, 'baseLayer', p),
    var_lr: textField(o, 'var_lr', p),
    var_ud: textField(o, 'var_ud', p),
    unread: unreadKeys(o, BUST_KEYS),
  });
}
const BUST_KEYS = keys(
  'enabled',
  'param',
  'gravity',
  'spring',
  'friction',
  'scale_x',
  'scale_y',
  'baseLayer',
  'var_lr',
  'var_ud',
);

function readPendulum(o: PsbObject, p: string): EmotePendulumControl {
  const param = objectField(o, 'param', p),
    pp = `${p}.param`;
  const floats = (key: string) => pair(listField(o, key, p), `${p}.${key}`, toFloat);
  return Object.freeze({
    enabled: true,
    param: Object.freeze({
      op: vec3(field(param, 'op', pp), `${pp}.op`),
      ofs: floatField(param, 'ofs', pp),
      bendR: floatField(param, 'bendR', pp),
      bendS: floatField(param, 'bendS', pp),
      bp: pair(listField(param, 'bp', pp), `${pp}.bp`, vec3),
      p: pair(listField(param, 'p', pp), `${pp}.p`, vec3),
      pv: pair(listField(param, 'pv', pp), `${pp}.pv`, vec3),
    }),
    gravity: floatField(o, 'gravity', p),
    friction_x: floatField(o, 'friction_x', p),
    friction_y: floatField(o, 'friction_y', p),
    b_rate: floatField(o, 'b_rate', p),
    v_bound: floatField(o, 'v_bound', p),
    ud_eft: intField(o, 'ud_eft', p),
    bend_spd: floatField(o, 'bend_spd', p),
    bend_vol: floatField(o, 'bend_vol', p),
    length: floats('length'),
    scale_x: floats('scale_x'),
    scale_y: floats('scale_y'),
    baseLayer: textField(o, 'baseLayer', p),
    var_lr: textField(o, 'var_lr', p),
    var_lrm: textField(o, 'var_lrm', p),
    var_ud: textField(o, 'var_ud', p),
    unread: unreadKeys(o, PENDULUM_KEYS),
  });
}
const PENDULUM_KEYS = keys(
  'enabled',
  'param',
  'gravity',
  'friction_x',
  'friction_y',
  'b_rate',
  'v_bound',
  'ud_eft',
  'bend_spd',
  'bend_vol',
  'length',
  'scale_x',
  'scale_y',
  'baseLayer',
  'var_lr',
  'var_lrm',
  'var_ud',
);

function edges(o: PsbObject, p: string): readonly (readonly [number, number])[] {
  return Object.freeze(
    listField(o, 'edge', p).map((e, i) =>
      pair(toList(e, `${p}.edge[${i}]`), `${p}.edge[${i}]`, toInt),
    ),
  );
}

function nodes(o: PsbObject, p: string): readonly (readonly number[])[] {
  return Object.freeze(
    listField(o, 'node', p).map((n, i) =>
      Object.freeze(
        toList(n, `${p}.node[${i}]`).map((v, j) => toFloat(v, `${p}.node[${i}][${j}]`)),
      ),
    ),
  );
}

function readEye(o: PsbObject, p: string): EmoteEyeControl {
  return Object.freeze({
    enabled: true,
    beginFrame: intField(o, 'beginFrame', p),
    endFrame: intField(o, 'endFrame', p),
    blinkIntervalMin: floatField(o, 'blinkIntervalMin', p),
    blinkIntervalMax: floatField(o, 'blinkIntervalMax', p),
    blinkFrameCount: floatField(o, 'blinkFrameCount', p),
    blinkEnabled: boolField(o, 'blinkEnabled', p),
    edge: edges(o, p),
    node: nodes(o, p),
    label: textField(o, 'label', p),
    unread: unreadKeys(o, EYE_KEYS),
  });
}
const EYE_KEYS = keys(
  'enabled',
  'beginFrame',
  'endFrame',
  'blinkIntervalMin',
  'blinkIntervalMax',
  'blinkFrameCount',
  'blinkEnabled',
  'edge',
  'node',
  'label',
);

function readEyebrow(o: PsbObject, p: string): EmoteEyebrowControl {
  return Object.freeze({
    enabled: true,
    beginFrame: intField(o, 'beginFrame', p),
    edge: edges(o, p),
    node: nodes(o, p),
    label: textField(o, 'label', p),
    unread: unreadKeys(o, EYEBROW_KEYS),
  });
}
const EYEBROW_KEYS = keys('enabled', 'beginFrame', 'edge', 'node', 'label');

function readMouth(o: PsbObject, p: string): EmoteMouthControl {
  return Object.freeze({
    enabled: true,
    beginFrame: intField(o, 'beginFrame', p),
    label: textField(o, 'label', p),
    talkLabel: textField(o, 'talkLabel', p),
    unread: unreadKeys(o, MOUTH_KEYS),
  });
}
const MOUTH_KEYS = keys('enabled', 'beginFrame', 'label', 'talkLabel');

function readTransition(o: PsbObject, p: string): EmoteTransitionControl {
  return Object.freeze({
    enabled: true,
    label: textField(o, 'label', p),
    unread: unreadKeys(o, TRANSITION_KEYS),
  });
}
const TRANSITION_KEYS = keys('enabled', 'label');

function readSelector(o: PsbObject, p: string, x64 = false): EmoteSelectorControl {
  return Object.freeze({
    ...(x64 ? {enabled: true as const} : {}),
    optionList: Object.freeze(
      listField(o, 'optionList', p).map((v, i) => {
        const op = `${p}.optionList[${i}]`,
          option = toObject(v, op);
        return Object.freeze({
          offValue: floatField(option, 'offValue', op),
          onValue: floatField(option, 'onValue', op),
          label: textField(option, 'label', op),
        });
      }),
    ),
    label: textField(o, 'label', p),
    unread: unreadKeys(o, x64 ? SELECTOR_X64_KEYS : SELECTOR_KEYS),
  });
}
const SELECTOR_KEYS = keys('optionList', 'label');
const SELECTOR_X64_KEYS = keys('enabled', 'optionList', 'label');

function readClamp(o: PsbObject, p: string): EmoteClampControl {
  return Object.freeze({
    enabled: true,
    type: intField(o, 'type', p),
    var_lr: textField(o, 'var_lr', p),
    var_ud: textField(o, 'var_ud', p),
    min: floatField(o, 'min', p),
    max: floatField(o, 'max', p),
    unread: unreadKeys(o, CLAMP_KEYS),
  });
}
const CLAMP_KEYS = keys('enabled', 'type', 'var_lr', 'var_ud', 'min', 'max');

function readLoop(o: PsbObject, p: string): EmoteLoopControl {
  return Object.freeze({
    enabled: true,
    transitionList: Object.freeze(
      listField(o, 'transitionList', p).map((v, i) => {
        const tp = `${p}.transitionList[${i}]`,
          t = toList(v, tp);
        return Object.freeze(
          [0, 1, 2].map((j) => toFloat(t[j] ?? null, `${tp}[${j}]`)),
        ) as unknown as readonly [number, number, number];
      }),
    ),
    var_loop: textField(o, 'var_loop', p),
    unread: unreadKeys(o, LOOP_KEYS),
  });
}
const LOOP_KEYS = keys('enabled', 'transitionList', 'var_loop');

function readVariableMatch(o: PsbObject, p: string): EmoteVariableMatch {
  return Object.freeze({
    variableMatchList: Object.freeze(
      listField(o, 'variableMatchList', p).map((v, i) => toText(v, `${p}.variableMatchList[${i}]`)),
    ),
  });
}

const TIMELINE_KEYS = keys('label', 'diff', 'loopBegin', 'loopEnd', 'lastTime', 'variableList');

function readTimeline(o: PsbObject, p: string, diag: EmoteDiagnosticSink): EmoteTimeline {
  const variables = Object.freeze(
    listField(o, 'variableList', p).map((v, i) => {
      const vp = `${p}.variableList[${i}]`,
        variable = toObject(v, vp);
      return Object.freeze({
        label: textField(variable, 'label', vp),
        frames: Object.freeze(
          listField(variable, 'frameList', vp).map((f, j) => {
            const fp = `${vp}.frameList[${j}]`,
              frame = toObject(f, fp),
              time = floatField(frame, 'time', fp),
              type = intField(frame, 'type', fp);
            if (type === 0) return Object.freeze({time, type, value: null, easing: null});
            const content = objectField(frame, 'content', fp),
              cp = `${fp}.content`,
              raw = field(content, 'value', cp);
            let value: number | string;
            if (typeof raw === 'string') {
              diag.add('abort', `${cp}.value`, "psb: can't convert value to float.");
              value = raw;
            } else value = toFloat(raw, `${cp}.value`);
            return Object.freeze({time, type, value, easing: floatField(content, 'easing', cp)});
          }),
        ),
      });
    }),
  );
  let lastTime = floatField(o, 'lastTime', p);
  if (lastTime < 0) {
    lastTime = 0;
    for (const v of variables) for (const f of v.frames) lastTime = Math.max(lastTime, f.time);
  }
  return Object.freeze({
    label: textField(o, 'label', p),
    diff: has(o, 'diff') ? toBool(o.diff!, `${p}.diff`) : false,
    loopBegin: floatField(o, 'loopBegin', p),
    loopEnd: floatField(o, 'loopEnd', p),
    lastTime,
    variables,
    unread: unreadKeys(o, TIMELINE_KEYS),
  });
}

function readVariable(value: PsbValue, i: number): EmoteVariableFrames {
  const p = `$.metadata.variableList[${i}]`,
    o = toObject(value, p);
  return Object.freeze({
    label: textField(o, 'label', p),
    frames: Object.freeze(
      listField(o, 'frameList', p).map((f, j) => {
        const fp = `${p}.frameList[${j}]`,
          frame = toObject(f, fp);
        return Object.freeze({
          label: textField(frame, 'label', fp),
          frame: floatField(frame, 'frame', fp),
        });
      }),
    ),
  });
}
