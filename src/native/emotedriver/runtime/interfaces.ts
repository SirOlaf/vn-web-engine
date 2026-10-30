import type {EmoteX64Model} from '../../../formats/kirikiri/emote-model.js';

/**
 * Boundaries between the parts of the TypeScript `emotedriver.dll` implementation. They
 * follow the native class split (SHA-256 `a3b693b6…5e70b3a86`):
 *
 * - player core (`MEmotePlayer`, `player-core.ts`): Progress, queuing, timelines, variables,
 *   transform tweens; owns the clips and the controls;
 * - clip (`MMotionPlayer`, `clip.ts`): clip time, layer nodes, keyframes, layer pass;
 * - controls (`emote::EP*`, `controls/`): eye, eyebrow, mouth, selector, loop, wind and the
 *   bust/hair/parts physics;
 * - mesh kernel (`mesh/`): bezier-patch and mesh vertex evaluation;
 * - renderer (`MMotionRenderer`, `MMotionDevice`, `render/`): draw list and D3D9 calls.
 *
 * Scalar record offsets refer to the x64 image SHA-256
 * `80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051`.
 *
 * These interfaces are internal to `src/native/emotedriver/`; the library's public surface
 * is `../contract.ts`. Extend them additively.
 */

/** A motion variable cell in the player's variable map (map lookup 0x10020140). */
export interface EmoteVariableCell {
  readonly label: string;
  /** Current value, written by timelines, `SetVariable`, and controls. */
  value: number;
}

/** What a control sees of its player during one sub-step. */
export interface EmoteControlHost {
  /** Variable by label, or null when the model has none. */
  variable(label: string): EmoteVariableCell | null;
  /** Clips of the player; physics reads node state (base layers) from the current one. */
  readonly clips: readonly EmoteClipNodes[];
  /** Current clip index (`p+0x1cc`). */
  readonly currentClip: number;
  /** Root rotation in degrees, after the `SetRot` tween (root node +0x294). */
  readonly rootAngle: number;
  /** `hairScale` (`p+0x28`), `partsScale` (`p+0x2c`), `bustScale`. */
  readonly hairScale: number;
  readonly partsScale: number;
  readonly bustScale: number;
  /** Uniform random source shared by the player (blink intervals). */
  random(): number;
  /** Wind state (`p+0x138`); null when stopped. */
  readonly wind: EmoteWindState | null;
  /**
   * Physics base position of a layer (inside 0x10012210): the node found by label in the
   * main clip (`p+0x8`, 0x10033e10/0x10033f40) when its `type` (+0x18) is 1 and its shape
   * record (+0x2dc) has kind 0; returns the record's point (+0x4, +0x8). Null otherwise, in
   * which case the physics keeps the previous base position. Absent: always null.
   */
  shapePoint?(label: string): {readonly x: number; readonly y: number} | null;
  /** Root node coordinate (+0x288, +0x28c) of the main clip, read with `shapePoint` (0). */
  readonly rootX?: number;
  readonly rootY?: number;
  /** `p+0x20`: 1 / (`SetScale` scale · metadata `scale`) (default 1). */
  readonly inverseScale?: number;
  /** x64 0x18000e6d0: base point after outer rotation and coordinate-flag scaling. */
  physicsBasePosition?(label: string): {readonly x: number; readonly y: number} | null;
  /** x64 clip plus outer rotation in radians (0x180018cb0). */
  readonly physicsAngle?: number;
  /** x64 accumulated outer forces, integrated by the player before physics. */
  readonly outerForces?: {
    readonly bust: EmotePhysicsForce;
    readonly hair: EmotePhysicsForce;
    readonly parts: EmotePhysicsForce;
  };
}

export interface EmotePhysicsForce {
  readonly x: number;
  readonly y: number;
}

/** `StartWind` parameters and the wind control's running state (0x1001c340, 0x1000d780). */
export interface EmoteWindState {
  readonly start: number;
  readonly goal: number;
  readonly speed: number;
  readonly powerMin: number;
  readonly powerMax: number;
  /** Current wind output fed to the pendulum controls. */
  power: number;
}

/** Wind acceleration sampled by a pendulum joint; independent of gust storage. */
export interface EmoteWindField {
  query(x: number): number;
}

/** Read access to a clip's evaluated layer nodes. */
export interface EmoteClipNodes {
  /** Node index by layer label (`layerIndexMap`), or -1. */
  nodeIndex(label: string): number;
  readonly nodes: readonly EmoteNodeView[];
  /**
   * Physics base position (inside 0x10012210): the point (+0x4, +0x8) of the shape record
   * (+0x2dc) of the node with this label when its `type` is 1 and the record kind is 0;
   * otherwise null. Read by `EmoteControlHost.shapePoint`.
   */
  shapePoint?(label: string): {readonly x: number; readonly y: number} | null;

  // Draw-list fields read by the renderer (0x10044d70). Optional members default as noted.
  /**
   * +0x194: draw order, node indices of nodes 1..n−1 (the root excluded); the renderer walks
   * it in reverse. Default: 1..n−1 in index order.
   */
  readonly drawOrder?: readonly number[];
  /** +0x150: clip colour, RGBA (0x808080ff neutral). Default neutral. */
  readonly color?: number;
  /** +0x1b4: secondary sort key of the clip's draw items (float; default 0). */
  readonly drawPriority?: number;
  /** +0x2ac: indices of nodes with `stencilType & 4` (composite masks). */
  readonly stencilCompositeNodes?: readonly number[];
  /** +0x111: the clip adds nothing to the draw list (default false). */
  readonly drawSuppressed?: boolean;
}

/**
 * Evaluated state of one layer node (`MMotionPlayer` node, stride 0x2e0). Written by the
 * clip's layer pass; read by controls, the mesh kernel's caller and the renderer.
 */
export interface EmoteNodeView {
  readonly label: string;
  /** Layer `type` (+0x18). */
  readonly type: number;
  /** Parent node index (+0x1c), -1 for the root. */
  readonly parent: number;
  /** `inheritMask` (+0x20). */
  readonly inheritMask: number;
  /** Visible after evaluation (+0x254) and drawable (+0x84). */
  readonly visible: boolean;
  readonly drawable: boolean;
  /** World coordinate x, y, z (+0x25c..+0x264). */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Angle in degrees (+0x268), zoom (+0x26c/+0x270), slant (+0x274/+0x278). */
  readonly angle: number;
  readonly zoomX: number;
  readonly zoomY: number;
  readonly slantX: number;
  readonly slantY: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
  /** Composed 2×2 transform (+0x5c..+0x68), row-major. */
  readonly matrix: Float32Array;
  /** Coordinate velocity (+0x6c..+0x74). */
  readonly velocityX: number;
  readonly velocityY: number;
  /**
   * Opacity 0..255 (+0x27c) and four corner colours (+0x4c..+0x58), RGBA (0x808080ff neutral),
   * corners top-left, top-right, bottom-right, bottom-left.
   */
  readonly opacity: number;
  readonly colors: Uint32Array;
  /** Blend mode byte of the current content (`bm`). */
  readonly blendMode: number;
  /** Source atlas and icon of the current content, or null. */
  readonly source: string | null;
  readonly icon: string | null;
  /** `stencilType` (+0x2c8). */
  readonly stencilType: number;
  /** Evaluated vertex grid (+0x2d8), or null when the node draws a plain quad. */
  readonly grid: EmoteVertexGrid | null;
  /** Nested clip for motion-reference and child-player nodes (types 3 and 4), or null. */
  readonly child: EmoteClipNodes | null;

  // Draw-list fields read by the renderer (0x10044d70). Optional members default as noted.
  /** +0x255: shown this frame; the draw-list walk skips nodes without it (default `visible`). */
  readonly shown?: boolean;
  /** +0x85: hidden; becomes the draw item's skip byte (default false). */
  readonly hidden?: boolean;
  /** +0x90: renderer texture index (`EmoteMotionRenderer.textureIndexOf(source)`). */
  readonly textureIndex?: number;
  /** +0x94: draw flags (bit 0 translucent, bit 1 opaque colour, bit 2 protect). */
  readonly drawFlags?: number;
  /** +0x98..+0xa4: source rect in the atlas, texels (u, v, w, h; ints). */
  readonly sourceRect?: readonly [number, number, number, number];
  /** +0x28: single colour (corner 0 used for all corners); +0x29: protect flag. */
  readonly singleColor?: boolean;
  readonly protectColor?: boolean;
  /**
   * +0x2ac: clip rect (x0, y0, x1, y1) in model space, or null. Projected through
   * WORLD·VIEW·PROJECTION to a scissor; compared by identity between items.
   */
  readonly clipRect?: Float32Array | null;
  /** +0x2cc: mask source node, or null. */
  readonly maskNode?: EmoteNodeView | null;
  /** +0x2c4 / +0x2c5: a motion-reference node (type 3) acts as a composite mask. */
  readonly stencilChild?: boolean;
  /** +0x2dc list for `stencilType & 4`: nodes whose draw items form the composite mask. */
  readonly compositeMaskNodes?: readonly EmoteNodeView[];
  /** +0x2dc → +0x4c: clips of the child players of a type-4 node. */
  readonly childPlayers?: readonly EmoteClipNodes[];
}

/** A clip event queued by `advance` (`+0x22c`, 12-byte entries). */
export interface EmoteClipEvent {
  /** 0: action (AMotionPlayer slot 1); 1: sync (slot 2). */
  readonly type: number;
  /** Layer label of a keyframe `act`, empty for motion `tag` actions. */
  readonly layer: string;
  /** Action label; empty for sync. */
  readonly label: string;
}

/** Evaluated mesh: (columns + 1) × (rows + 1) screen positions (draw item +0x60). */
export interface EmoteVertexGrid {
  readonly columns: number;
  readonly rows: number;
  /** x, y pairs, row-major. */
  readonly positions: Float32Array;
}

/**
 * Bezier-patch and mesh vertex kernel (0x1002cd90, 0x1002d960, 0x1003f680). Implemented in
 * Rust/Wasm with a TypeScript twin of identical output.
 */
export interface EmoteMeshKernel {
  /** True for the WebAssembly implementation; false for its TypeScript twin. */
  readonly accelerated?: boolean;
  /**
   * Evaluates a 4×4 bezier patch (`bp`: 16 control points as 32 floats) on a
   * (columns + 1) × (rows + 1) grid into `out` (x, y pairs).
   */
  evaluatePatch(
    controlPoints: Float32Array,
    columns: number,
    rows: number,
    out: Float32Array,
  ): void;
  /**
   * Maps `count` points (x, y pairs, in place) through a world-space patch (0x1003f680): each
   * point is offset by (translateX, translateY), mapped to patch coordinates by the 2×2
   * `inverse` (row-major) and evaluated on the patch.
   */
  deformPoints(
    controlPoints: Float32Array,
    inverse: Float32Array,
    translateX: number,
    translateY: number,
    points: Float32Array,
    count: number,
  ): void;
  /**
   * Bilinear (columns + 1) × (rows + 1) grid over a quad (0x1002d960). `corners` holds the
   * top-left, top-right, bottom-left and bottom-right x, y pairs.
   */
  subdivideQuad(corners: Float32Array, columns: number, rows: number, out: Float32Array): void;
}

/** X64 mesh operations used by the layer pass and its compatibility binding. */
export interface EmoteX64MeshKernel extends EmoteMeshKernel {
  /** Map x/y pairs in place through a patch; offset counts floats, not points. */
  mapPatchPoints(points: Float32Array, count: number, patch: Float32Array, offset?: number): void;
  /** Double products/offsets followed by a float32 point store. */
  affinePoints(
    points: Float32Array,
    count: number,
    matrix: ArrayLike<number>,
    x: number,
    y: number,
  ): void;
  /** Transform control points, then evaluate a grid into caller-owned output. */
  evaluateTransformedPatch(
    patch: Float32Array,
    columns: number,
    rows: number,
    matrix: ArrayLike<number>,
    x: number,
    y: number,
    out: Float32Array,
  ): void;
}

/** Events a clip queues during `advance` (`+0x2ec`) and dispatches to its player (0x10033fe0). */
export interface EmoteClipListener {
  /** Keyframe `act` label reached (AMotionPlayer slots 1 and 2 forward these). */
  action(clip: EmoteClipDriver, label: string): void;
  /** Motion `tag` frame with `sync` reached (AMotionPlayer slot 2). */
  sync?(clip: EmoteClipDriver): void;
}

/** What the player core drives on each clip (`MMotionPlayer`). Implemented by `clip.ts`. */
export interface EmoteClipDriver extends EmoteClipNodes {
  /** Applies one variable value to the clip's parameters (0x100129d0 → 0x100319f0). */
  applyVariable(label: string, value: number): void;
  /** Clears queued events, advances clip time by `frames` and loads frames (0x1003aaf0). */
  advance(frames: number): void;
  /** Layer pass (0x1003ece0). */
  evaluate(): void;
  /** Dispatches queued events (x86 0x10033fe0); the x64 host retires its actions internally. */
  dispatchEvents(listener: EmoteClipListener): void;
  /** Player colour RGBA (`+0x150`, 0x808080ff neutral), set by the `SetColor` tween. */
  color: number;
  /** Root tween targets (+0x283, +0x288..+0x2a8). Borrowed for this call; copy values to retain them. */
  setRootTransform(transform: EmoteRootTransform): void;
  /** Copies time and node state from another clip of the same motion (`AssignState`). */
  assignState(source: EmoteClipDriver): void;
  /** Events queued by `advance` and not yet dispatched (`+0x22c`). */
  readonly events: readonly EmoteClipEvent[];
}

export interface EmoteRootTransform {
  readonly x: number;
  readonly y: number;
  /** Degrees. */
  readonly angle: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly mirror: boolean;
}

// ---------------------------------------------------------------------------------------
// Player core boundaries (`MEmotePlayer`, `player-core.ts`).

/**
 * Clip members the player core needs beyond `EmoteClipDriver`. Kept separate so the clip
 * implementation can adopt them additively; `EmoteClipDriver & EmoteClipPlayerAccess` is
 * what the core drives.
 */
export interface EmoteClipPlayerAccess {
  /** Parameter value of the clip for a variable label, 0 when unknown (0x100320b0). */
  getVariable(label: string): number;
  /** Root node visible flag (+0x282); `Show`/`Hide` (0x10010850/0x100108a0) write it. */
  rootVisible: boolean;
  /** `meshDivisionRatio` (clip +0x358, slots 9/10). */
  meshDivisionRatio: number;
  /** Any node dirty (+0x25), `IsModified` (0x10032950). */
  isModified(): boolean;
}

/** Additional clip state used by the exact x64 player's transform and physics calls. */
export interface EmoteX64ClipPlayerAccess extends EmoteClipPlayerAccess {
  /** Native 0x180038480; required when stereovisionControl requests variable bounds. */
  getVariableRange?(label: string): readonly [number, number] | null;
  /** Root dirty byte (+0x340); x64 writes it even when the transform is unchanged. */
  rootDirty: boolean;
  smoothing: boolean;
  readonly ownRotation: boolean;
  readonly ownRotationAngle: number;
  setOwnRotation(degrees: number): void;
  setGrayscale(mode: number, level: number): void;
  readonly grayscaleMode: number;
  readonly grayscaleLevel: number;
  /** World position of a plain layer, or null when no such layer exists. */
  layerPosition(label: string): {readonly x: number; readonly y: number} | null;
}

/** Creates the clip for a motion (`MEmotePlayer` vtable[1] 0x1000f160). */
export type EmoteClipFactory = (
  motion: import('../../../formats/kirikiri/emote-model.js').EmoteMotion,
) => EmoteClipDriver & EmoteClipPlayerAccess;

/**
 * `SetVariable` (0x10012510) dispatch types of the player's control binding map (`p+0x54`):
 * 4 eye, 5 eyebrow, 6 mouth, 7 transition (player core), 8 selector.
 */
export type EmoteControlVariableType = 4 | 5 | 6 | 8;

/**
 * The controls the player core does not own (eye, eyebrow, mouth, selector, loop, wind, bust,
 * hair, parts), shaped by the native call sites in `MEmotePlayer`. One instance per player,
 * created by `EmoteControlSetFactory` from the metadata while the player loads (0x10010ee0).
 */
export interface EmoteControlSet {
  /**
   * Registers the variables of one control kind in the binding map, in the order the native
   * loaders insert them: eye 0x10015890 (4), eyebrow 0x100171f0 (5), mouth 0x10018920 (6),
   * selector 0x10019a50 (8). `index` is the entry index the loader stores with the binding
   * (its position in the PSB list). The core calls 4, 5, 6, registers its own transitions (7),
   * then calls 8; an existing label is not replaced.
   */
  bindVariables(type: EmoteControlVariableType, bind: (label: string, index: number) => void): void;
  /**
   * `SetVariable` on a bound variable (0x10012510): 4 → 0x10005460, 5 → 0x10007ce0,
   * 6 → mouth entry `index` (`label` selects the `label` or `talkLabel` branch; 0x1000a710),
   * 8 → 0x1000b7d0. `power` is the converted easing (`easingPower`); `queue` is `p+0x30`.
   */
  setVariable(
    type: EmoteControlVariableType,
    index: number,
    label: string,
    value: number,
    frames: number,
    power: number,
    queue: boolean,
  ): void;
  /** Progress sub-step 1, eye controls `p+0xb4` (0x10017160). */
  stepEyes(host: EmoteControlHost, frames: number): void;
  /** Sub-step 2, eyebrow controls `p+0xc4` (0x10018890). */
  stepEyebrows(host: EmoteControlHost, frames: number): void;
  /** Sub-step 3, mouth controls `p+0xd4` (0x10019310). */
  stepMouths(host: EmoteControlHost, frames: number): void;
  /** Sub-step 4, selector controls `p+0xf4` (0x1001a770). */
  stepSelectors(host: EmoteControlHost, frames: number): void;
  /** Sub-step 6 (after the core's transitions), loop controls `p+0x104` (0x1001b320). */
  stepLoops(host: EmoteControlHost, frames: number): void;
  /** Sub-step 8 gate: wind control `p+0x138` exists and its enabled byte (+0xc) is set. */
  windActive(): boolean;
  /** Sub-step 8, wind (0x1000d780). */
  stepWind(host: EmoteControlHost, frames: number): void;
  /**
   * Progress step 7, after the clips, only for frames ≠ 0: bust `p+0x84` (0x10013c30), hair
   * `p+0x94` with `hairScale` then parts `p+0xa4` with `partsScale` (0x10015500).
   */
  stepPhysics(host: EmoteControlHost, frames: number): void;
  /**
   * `StartWind` (0x1001c340) when start/goal changed or no wind exists: replaces the wind
   * control (0x1000d630). Arguments are already divided by the model scale (`p+0x1c`).
   */
  createWind(start: number, goal: number): void;
  /** `StartWind` (0x1001c340) → 0x1000d690(powerMin, powerMax, speed / scale). */
  configureWind(powerMin: number, powerMax: number, speed: number): void;
  /** `StopWind` and invalid `StartWind` arguments: deletes the wind control (`p+0x138` = 0). */
  destroyWind(): void;
  /**
   * `Skip` (0x10012190) for these controls, in native order: bust 0x10013b80, hair and parts
   * 0x10015480, eye 0x10017020, eyebrow 0x10018760, mouth 0x10019220, selector 0x1001a680.
   * The x64 caller supplies its host so the physics outputs are zeroed immediately.
   */
  skip(host?: EmoteControlHost): void;
  /**
   * `IsAnimating` (0x100108f0) for selectors, eyes, eyebrows and mouths: true when a control's
   * tween is running or queued and its variable is not in `timelineVariables` (the track labels
   * of all playing timelines).
   */
  isAnimating(timelineVariables: ReadonlySet<string>): boolean;
  /**
   * `AssignState` (0x1000f2a0): copies the eye, eyebrow, mouth and selector state from the
   * entry of `source` with the same label. Bust, hair, parts and loop state are not copied.
   */
  assignState(source: EmoteControlSet): void;
}

/** Builds the control set of a player from its metadata (loaders in 0x10010ee0). */
export type EmoteControlSetFactory = (
  metadata: import('../../../formats/kirikiri/emote-metadata.js').EmoteMetadata,
  links: EmoteControlLinks,
) => EmoteControlSet;

/** Blink API added by the x64 player image. */
export interface EmoteX64ControlSet extends EmoteControlSet {
  setBlinkEnabled(enabled: boolean): void;
  getBlinkEnabled(): boolean;
}

/** Player-owned objects controls refer to while loading. */
export interface EmoteControlLinks {
  /** Exact driver image; absent keeps the x86 control factory behavior. */
  readonly driverSha256?: string;
  /** Process-wide blink and wind generator, supplied by the runtime's device. */
  readonly random?: () => number;
  /** Transition control (`p+0xe4`) by label, for selector options (0x10019a50). */
  transition(label: string): EmoteSelectorTransition | null;
}

/** What a selector option drives: a transition tween (`EmoteTween`). */
export type EmoteSelectorTransition = import('./controls/selector.js').EmoteSelectorTransition;

/** Extra host members the player core provides (MSVC CRT `rand`). */
export interface EmoteControlHostRandom {
  /** MSVC CRT `rand()`: 0..0x7fff, process-wide sequence, seed 1. */
  rand(): number;
}

/** Current variables sampled by the x64 mesh-combinator registry. */
export interface EmoteCombinatorVariables {
  getVariable(label: string): number;
}

/** Mesh output of one layer, independent of the layer's concrete node storage. */
export interface EmoteCombinatorTarget {
  readonly meshType: number;
  /** The patch is borrowed for this synchronous call; null restores the neutral mesh. */
  applyCombinatorPatch(patch: Float32Array | null): void;
}

/** Mesh state of a `meshTransform` 1 layer (0x88 bytes at payload +0x10). */
export interface EmoteScalarMeshState {
  /** +0x20/+0x24: tessellation segments. */
  cols: number;
  rows: number;
  /** +0x30: the current patch (16 points), or null when the layer does not deform. */
  bp: Float32Array | null;
  /** +0x48: [w·m00, h·m01, w·m10, h·m11]. */
  readonly ms: Float32Array;
  /** +0x58: the patch in world coordinates (deformers only). */
  readonly world: Float32Array;
  /** +0x70: inverse of `ms`. */
  readonly inv: Float32Array;
  /** +0x80/+0x84: the negated translation. */
  negTx: number;
  negTy: number;
}

/** Vertex grid (node +0x3c0): (rows + 1)·(cols + 1) world points, rows outer. */
export interface EmoteScalarVertexGrid {
  cols: number;
  rows: number;
  points: Float32Array;
}

/** Draw item (0xa8 bytes at node +0x3b8), the renderer's input. */
export interface EmoteScalarDrawItem {
  /** +4: blank icons are skipped by the renderer. */
  blank: boolean;
  /** +8. */
  nodeId: number;
  /** +0xc: clip +0x250. */
  clipFlags: number;
  /** +0x10/+0x14: blend mode and parameter. */
  bm: number;
  bmParam: number;
  /** +0x18/+0x1c: clip grayscale mode (5 or 0) and level. */
  grayscaleMode: number;
  grayscaleLevel: number;
  /** +0x20/+0x24: clip +0x1d8/+0x1dc. */
  effectMode: number;
  effectLevel: number;
  /** +0x28. */
  z: number;
  /** +0x2c: texture (source) index in `file`. */
  texIndex: number;
  file: EmoteX64Model | null;
  source: string | null;
  /** +0x30: icon attributes; bit 1 opaque, bit 2 uniform per-vertex colour. */
  attr: number;
  /** +0x34..+0x40: icon rectangle in texels. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** +0x44. */
  opa: number;
  /** +0x48..+0x54: corner colours (alpha in the low byte, 0x80 = 1.0 for colour bytes). */
  readonly colors: Uint32Array;
  /** +0x58. */
  objTriPriority: number;
  /** +0x5c. */
  coordinate: number;
  /** +0x68: the mesh state when the layer deforms itself. */
  mesh: EmoteScalarMeshState | null;
  /** +0x70. */
  grid: EmoteScalarVertexGrid | null;
  /** +0x78. */
  stencilType: number;
  /** +0x7c..+0x84. */
  alphaTest: boolean;
  alphaScale: number;
  alphaOffset: number;
  /** +0x88: the stencil parent's item. */
  stencilParent: EmoteScalarDrawItem | null;
  /** +0x90: composite list (stencil masks and nested-clip items). */
  readonly composite: EmoteScalarDrawItem[];
}
