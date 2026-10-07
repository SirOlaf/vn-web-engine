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
