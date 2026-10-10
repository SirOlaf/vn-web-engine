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

/** Read access to a clip's evaluated layer nodes. */
export interface EmoteClipNodes {
  /** Node index by layer label (`layerIndexMap`), or -1. */
  nodeIndex(label: string): number;
  readonly nodes: readonly EmoteNodeView[];
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
  /** Opacity 0..255 (+0x27c) and four corner colours ARGB (+0x4c..+0x58). */
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
}

/** Events a clip queues during `advance` (`+0x2ec`) and dispatches to its player (0x10033fe0). */
export interface EmoteClipListener {
  /** Keyframe `act` label reached (AMotionPlayer slots 1 and 2 forward these). */
  action(clip: EmoteClipDriver, label: string): void;
}

/** What the player core drives on each clip (`MMotionPlayer`). Implemented by `clip.ts`. */
export interface EmoteClipDriver extends EmoteClipNodes {
  /** Applies one variable value to the clip's parameters (0x100129d0 → 0x100319f0). */
  applyVariable(label: string, value: number): void;
  /** Clears queued events, advances clip time by `frames` and loads frames (0x1003aaf0). */
  advance(frames: number): void;
  /** Layer pass (0x1003ece0). */
  evaluate(): void;
  /** Dispatches events queued by `advance` (0x10033fe0). */
  dispatchEvents(listener: EmoteClipListener): void;
  /** Player colour ARGB (`+0x150`), set by the `SetColor` tween. */
  color: number;
  /** Root tween targets written by the player (root node +0x283, +0x288..+0x2a8). */
  setRootTransform(transform: EmoteRootTransform): void;
  /** Copies time and node state from another clip of the same motion (`AssignState`). */
  assignState(source: EmoteClipDriver): void;
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
   */
  skip(): void;
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
) => EmoteControlSet;

/** Extra host members the player core provides (MSVC CRT `rand`). */
export interface EmoteControlHostRandom {
  /** MSVC CRT `rand()`: 0..0x7fff, process-wide sequence, seed 1. */
  rand(): number;
}
