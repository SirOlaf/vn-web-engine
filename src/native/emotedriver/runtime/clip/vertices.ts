import type {
  EmoteMeshKernel,
  EmoteX64MeshKernel,
  EmoteScalarMeshState,
  EmoteScalarVertexGrid,
} from '../interfaces.js';
import {EmoteUnsupportedError} from '../errors.js';
import {EmoteClipUnsupportedError} from './frame.js';

import {IDENTITY_PATCH, patchPoint, roundHalfEven} from './interpolate.js';
import {VertexGrid} from './node.js';
import type {EmoteTransformState} from './layer.js';

/**
 * Passes after the layer transforms in the layer pass 0x1003ece0 (`emotedriver.dll` SHA-256
 * `a3b693b6…5e70b3a86`): vertices 0x1003f9c0, mask links 0x10040840, clip rectangles
 * 0x10040e80 and shapes 0x10041160. The per-vertex loops run in the mesh kernel.
 */

const f = Math.fround;
const f32 = Math.fround;
const DEFAULT_MESH = IDENTITY_PATCH;

/** Array-layout input for the x86 CPU passes; independent of the clip implementation. */
export interface EmoteVertexHost {
  readonly nodes: readonly EmoteBlockVertexNode[];
  readonly kernel: EmoteMeshKernel;
  readonly meshDivisionRatio: number;
  readonly zProjection: number;
  readonly shapeNodes: readonly EmoteBlockVertexNode[];
}

/** Only the array-layout state consumed by vertex, mask and shape evaluation. */
export interface EmoteBlockVertexNode {
  readonly id: number;
  readonly parent: number;
  readonly type: number;
  readonly inheritMask: number;
  readonly stencilType: number;
  readonly cur: {readonly empty: boolean; readonly ox: number; readonly oy: number};
  readonly state: Pick<
    EmoteTransformState,
    'changed' | 'visible' | 'x' | 'y' | 'z' | 'zoomX' | 'zoomY'
  >;
  readonly matrix: Float32Array;
  readonly meshKind: number;
  readonly meshSync: number;
  readonly meshDivision: number;
  readonly meshCombine: boolean;
  readonly mesh: {
    readonly columns: number;
    readonly rows: number;
    readonly local: Float32Array;
    readonly world: Float32Array;
    readonly matrix: Float32Array;
    readonly inverse: Float32Array;
    translateX: number;
    translateY: number;
  } | null;
  readonly resolved: {
    readonly drawable: boolean;
    readonly hidden: boolean;
    readonly originX: number;
    readonly originY: number;
    readonly rect: Int32Array;
  };
  readonly meshPosition: Float32Array;
  readonly shape: Float32Array | null;
  readonly layer: {readonly shape: number | null} | null;
  gridData: {
    readonly columns: number;
    readonly rows: number;
    readonly positions: Float32Array;
    resize(columns: number, rows: number): void;
  } | null;
  meshDirty: boolean;
  meshParent: EmoteBlockVertexNode | null;
  meshParentId: number;
  meshActive: boolean;
  meshIndependent: boolean;
  isMask: boolean;
  maskNode: EmoteBlockVertexNode | null;
  clipRect: Float32Array | null;
}

/** Scalar-layout input for the x64 CPU passes. No node adapters or proxy reads. */
export interface EmoteScalarVertexNode {
  readonly parent: number;
  readonly id: number;
  readonly type: number;
  readonly inheritMask: number;
  readonly cur: {readonly empty: boolean; readonly ox: number; readonly oy: number};
  readonly meshKind: number;
  readonly meshCombine: boolean;
  readonly syncChildMask: number;
  readonly division: number;
  readonly mstate: EmoteScalarMeshState | null;
  readonly changed: boolean;
  readonly drawable: boolean;
  readonly hidden: boolean;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly zoomX: number;
  readonly originX: number;
  readonly originY: number;
  readonly w: number;
  readonly h: number;
  readonly m00: number;
  readonly m01: number;
  readonly m10: number;
  readonly m11: number;
  readonly layer: {readonly shape: number | null} | null;
  readonly anchor: Float32Array;
  readonly shapeInfo: number[] | null;
  meshParent: EmoteScalarVertexNode | null;
  meshParentId: number;
  modified: boolean;
  breaksChain: boolean;
  isDeformer: boolean;
  grid: EmoteScalarVertexGrid | null;
}
export interface EmoteScalarVertexResource {
  readonly kernel: EmoteX64MeshKernel;
  readonly zFactor: number;
}
/** One clip's fixed vertex inputs and reusable scratch storage. */
export interface EmoteScalarVertexHost extends EmoteScalarVertexScratch {
  readonly nodes: readonly EmoteScalarVertexNode[];
  readonly resource: EmoteScalarVertexResource;
  readonly top: {readonly meshDivisionRatio: number};
}
/** Reused by one clip, including the mapped-point result tuple. */
export interface EmoteScalarVertexScratch {
  readonly quadCorners: Float32Array;
  readonly mappedPoint: Float32Array;
  readonly mappedResult: [number, number];
}

/** A point through an ancestor's mesh: its inverse frame, then its world patch (0x1002b320). */
function throughMesh(a: EmoteBlockVertexNode, x: number, y: number, out: number[]): void {
  const m = a.mesh!,
    i = m.inverse;
  const px = f(m.translateX + x),
    py = f(m.translateY + y);
  const u = f(px * i[0]! + py * i[1]!),
    v = f(py * i[3]! + i[2]! * px);
  patchPoint(m.world, u, v, out);
}

/** 0x1003f9c0: mesh links, bezier frames and vertex grids of every node. */
export function meshPass(clip: EmoteVertexHost): void {
  const nodes = clip.nodes,
    kernel = clip.kernel,
    ratio = clip.meshDivisionRatio,
    p2 = [0, 0];
  for (let i = 1; i < nodes.length; i++) {
    const node = nodes[i]!,
      parent = nodes[node.parent]!,
      cur = node.cur,
      mesh = node.mesh;
    const oldId = node.meshParentId;
    const mp = parent.meshActive || parent.meshIndependent ? parent : parent.meshParent;
    node.meshParent = mp;
    node.meshParentId = mp ? mp.id : 0;
    if (node.meshParentId === oldId && !node.state.changed && (!mp || !mp.meshDirty)) {
      node.meshDirty = false;
      if (node.meshCombine && node.meshActive) skipCombined(clip, node, parent, null);
      continue;
    }
    node.meshDirty = true;
    node.meshIndependent = mp !== null && !(node.inheritMask & 0x2000000);
    node.meshActive =
      !cur.empty &&
      node.meshKind !== 0 &&
      mesh !== null &&
      mesh.local.length !== 0 &&
      node.resolved.drawable &&
      (node.meshSync & 8) !== 0;
    const s = node.state;
    if ((1 << node.type) & 0x22) {
      if (!mp) {
        node.meshPosition[0] = s.x;
        node.meshPosition[1] = s.y;
      } else {
        let x = s.x,
          y = s.y;
        for (let a: EmoteBlockVertexNode | null = mp; a; a = a.meshParent)
          if (a.meshActive) {
            throughMesh(a, x, y, p2);
            x = p2[0]!;
            y = p2[1]!;
          }
        node.meshPosition[0] = x;
        node.meshPosition[1] = y;
      }
      node.meshPosition[2] = s.z;
    }
    if (cur.empty || !((1 << node.type) & 0x1c01) || !node.resolved.drawable) continue;
    let patch = mesh ? mesh.local : new Float32Array(0);
    if (node.meshCombine) {
      if (!node.meshActive) patch = new Float32Array(0);
      else {
        patch = mesh!.local.slice();
        skipCombined(clip, node, parent, patch);
      }
    }
    const lx = s.x,
      ly = f(s.z * clip.zProjection + s.y);
    const m = node.matrix,
      r = node.resolved;
    const ox = f(r.originX + cur.ox),
      oy = f(r.originY + cur.oy);
    const tlx = f(f(-f(ox * m[0]! + oy * m[1]!)) + lx),
      tly = f(ly + f(-f(oy * m[3]! + m[2]! * ox)));
    const w = r.rect[2]!,
      h = r.rect[3]!;
    if (node.meshKind === 1 && mesh) {
      const bm = mesh.matrix;
      bm[0] = w * m[0]!;
      bm[1] = h * m[1]!;
      bm[2] = w * m[2]!;
      bm[3] = h * m[3]!;
      if (node.meshActive) {
        const det = f(bm[3]! * bm[0]! - bm[2]! * bm[1]!);
        mesh.inverse[0] = bm[3]! / det;
        mesh.inverse[1] = -bm[1]! / det;
        mesh.inverse[2] = -bm[2]! / det;
        mesh.inverse[3] = bm[0]! / det;
        mesh.translateX = -tlx;
        mesh.translateY = -tly;
        for (let k = 0; k < 16; k++) {
          const px = patch[k * 2]!,
            py = patch[k * 2 + 1]!;
          mesh.world[k * 2] = f(py * bm[1]! + px * bm[0]! + tlx);
          mesh.world[k * 2 + 1] = f(py * bm[3]! + bm[2]! * px + tly);
        }
      }
    }
    if (!((1 << node.type) & 0x1401) || r.hidden) continue;
    const grid = (node.gridData ??= new VertexGrid());
    if (!mesh || patch.length === 0) {
      const zx = f(m[0]! * 0),
        zy = f(m[1]! * 0),
        zz = f(m[2]! * 0),
        zw = f(m[3]! * 0);
      const wx = f(w * m[0]!),
        wy = f(w * m[2]!),
        hx = f(h * m[1]!),
        hy = f(h * m[3]!);
      const corners = new Float32Array([
        f(f(zx + zy) + tlx),
        f(f(tly + zz) + zw),
        f(f(wx + zy) + tlx),
        f(f(tly + wy) + zw),
        f(f(hx + zx) + tlx),
        f(tly + f(hy + zz)),
        f(f(hx + wx) + tlx),
        f(f(tly + hy) + wy),
      ]);
      if (!node.meshParent) {
        grid.resize(1, 1);
        grid.positions.set(corners);
      } else {
        let division: number;
        if (node.meshKind === 0) {
          let a = mp!;
          while (!a.meshActive) a = a.meshParent!;
          const d = roundHalfEven(f(a.meshDivision >>> 0) * ratio) >>> 0;
          const aw = a.resolved.rect[2]!,
            ah = a.resolved.rect[3]!;
          division = Math.trunc((d * ((h + w) >>> 0)) / ((ah + aw) >>> 0)) >>> 0;
        } else division = roundHalfEven(f(node.meshDivision >>> 0) * ratio) >>> 0;
        const columns = Math.trunc((w * division) / ((h + w) >>> 0)) >>> 0;
        grid.resize(columns + 1, division - columns + 1);
        kernel.subdivideQuad(corners, grid.columns, grid.rows, grid.positions);
      }
    } else {
      grid.resize(mesh.columns, mesh.rows);
      const bm = mesh.matrix,
        cp = new Float32Array(32),
        local = mesh.local;
      for (let k = 0; k < 16; k++) {
        const px = local[k * 2]!,
          py = local[k * 2 + 1]!;
        cp[k * 2] = f(tlx + f(bm[0]! * px + bm[1]! * py));
        cp[k * 2 + 1] = f(tly + f(bm[3]! * py + bm[2]! * px));
      }
      kernel.evaluatePatch(cp, grid.columns, grid.rows, grid.positions);
    }
    // Deformation by mesh ancestors; past a translate-only link only the position follows.
    const count = (grid.columns + 1) * (grid.rows + 1);
    let x = lx,
      y = ly,
      a: EmoteBlockVertexNode | null = node.meshParent,
      translateOnly = node.meshIndependent;
    while (!translateOnly && a) {
      if (a.meshActive) {
        const am = a.mesh!;
        kernel.deformPoints(
          am.world,
          am.inverse,
          am.translateX,
          am.translateY,
          grid.positions,
          count,
        );
        throughMesh(a, x, y, p2);
        x = p2[0]!;
        y = p2[1]!;
      }
      translateOnly = a.meshIndependent;
      a = a.meshParent;
    }
    for (; a; a = a.meshParent)
      if (a.meshActive) {
        throughMesh(a, x, y, p2);
        x = p2[0]!;
        y = p2[1]!;
      }
    if (x !== lx || y !== ly) {
      const dx = f(x - lx),
        dy = f(y - ly),
        p = grid.positions;
      for (let k = 0; k < count; k++) {
        p[k * 2] = f(dx + p[k * 2]!);
        p[k * 2 + 1] = f(dy + p[k * 2 + 1]!);
      }
    }
  }
}

/**
 * `meshCombine`: the ancestors' patch offsets from the unit patch add into `patch`
 * (0x1002ae80) and those ancestors stop being mesh parents of the node.
 */
function skipCombined(
  clip: EmoteVertexHost,
  node: EmoteBlockVertexNode,
  start: EmoteBlockVertexNode,
  patch: Float32Array | null,
): void {
  let a: EmoteBlockVertexNode | undefined = start;
  do {
    if (a.meshActive) {
      if (a === node.meshParent) node.meshParent = a.meshParent;
      if (patch) {
        const l = a.mesh!.local;
        for (let k = 0; k < patch.length; k++)
          patch[k] = f(patch[k]! + f(l[k]! - IDENTITY_PATCH[k]!));
      }
    }
    if (!a.meshCombine) break;
    a = clip.nodes[a.parent];
  } while (a);
}

/** 0x10040840: masking layers and each node's nearest masking ancestor. */
export function maskPass(clip: EmoteVertexHost): void {
  const nodes = clip.nodes;
  for (let i = 1; i < nodes.length; i++) {
    const node = nodes[i]!,
      parent = nodes[node.parent]!;
    node.maskNode = parent.isMask ? parent : parent.maskNode;
    node.isMask =
      !node.cur.empty &&
      node.stencilType !== 0 &&
      node.state.visible &&
      (!((1 << node.type) & 0x1801) || node.resolved.drawable);
  }
}

/** 0x10040e80: type-7 layers clip their subtree to a 32-unit box; others inherit. */
export function clipRectPass(clip: EmoteVertexHost): void {
  const nodes = clip.nodes;
  for (let i = 1; i < nodes.length; i++) {
    const node = nodes[i]!,
      parentRect = nodes[node.parent]!.clipRect;
    if (node.type !== 7 || !node.state.visible) {
      node.clipRect = parentRect;
      continue;
    }
    const s = node.state,
      m = node.matrix,
      cur = node.cur;
    const ox = cur.ox,
      oy = cur.oy;
    const l40 = f(ox * m[0]! + oy * m[1]!),
      l3c = f(ox * m[2]! + m[3]! * oy);
    const x0 = f(s.x + f(f(m[1]! * -16 - m[0]! * 16) - l40)),
      y0 = f(s.y + f(f(m[3]! * -16 - m[2]! * 16) - l3c)),
      x1 = f(s.x + f(f(m[1]! * 16 + m[0]! * 16) - l40)),
      y1 = f(s.y + f(f(m[3]! * 16 + m[2]! * 16) - l3c));
    const rect = new Float32Array([
      x0 <= x1 ? x0 : x1,
      f(s.z + (y0 <= y1 ? y0 : y1)),
      x1 <= x0 ? x0 : x1,
      f(s.z + (y1 <= y0 ? y0 : y1)),
    ]);
    if (parentRect) {
      rect[0] = Math.max(rect[0]!, parentRect[0]!);
      rect[1] = Math.max(rect[1]!, parentRect[1]!);
      rect[2] = Math.min(rect[2]!, parentRect[2]!);
      rect[3] = Math.min(rect[3]!, parentRect[3]!);
    }
    node.clipRect = rect;
  }
}

/**
 * 0x10041160: shape records of type-1 layers from the mesh-deformed position: kind 0 point,
 * 1 circle (radius zoomX·8), 2 box, 3 rotated 16-unit quad.
 */
export function shapePass(clip: EmoteVertexHost): void {
  for (const node of clip.shapeNodes) {
    if (!node.meshDirty) continue;
    const r = node.shape!,
      x = node.meshPosition[0]!,
      y = node.meshPosition[1]!,
      s = node.state,
      kind = node.layer?.shape ?? 0;
    r[0] = kind;
    if (kind === 0 || kind === 1) {
      r[1] = x;
      r[2] = y;
      if (kind === 1) r[3] = f(f(s.zoomX * 16) * 0.5);
    } else if (kind === 2) {
      const hx = f(f(s.zoomX * 16) * 0.5),
        hy = f(f(s.zoomY * 16) * 0.5);
      r[1] = f(x - hx);
      r[2] = f(y - hy);
      r[3] = f(x + hx);
      r[4] = f(hy + y);
    } else if (kind === 3) {
      const m = node.matrix,
        cur = node.cur;
      const ox = f(cur.ox * m[0]! + cur.oy * m[1]!),
        oy = f(cur.oy * m[3]! + m[2]! * cur.ox);
      const a = f(m[1]! * -8),
        b = f(m[0]! * -8),
        c = f(m[3]! * -8),
        d = f(m[2]! * -8),
        e = f(m[0]! * 8),
        g = f(m[2]! * 8),
        k = f(m[1]! * 8),
        l = f(m[3]! * 8);
      r[1] = f(x + f(f(b + a) - ox));
      r[2] = f(y + f(f(d + c) - oy));
      r[3] = f(f(f(e + a) - ox) + x);
      r[4] = f(f(f(g + c) - oy) + y);
      r[5] = f(f(f(k + e) - ox) + x);
      r[6] = f(f(f(l + g) - oy) + y);
      r[7] = f(x + f(f(k + b) - ox));
      r[8] = f(y + f(f(l + d) - oy));
    }
  }
}

/** 0x180043e00, exact x64 image: scalar anchors, deformers and vertex grids. */
export function meshPassX64(host: EmoteScalarVertexHost): void {
  const nodes = host.nodes,
    resource = host.resource,
    scratch = host;
  for (let k = 1; k < nodes.length; k++) {
    const n = nodes[k]!;
    let D = nodes[n.parent]!;
    const ms = n.mstate;
    const oldId = n.meshParentId;
    const mp = D.isDeformer || D.breaksChain ? D : D.meshParent;
    n.meshParent = mp;
    n.meshParentId = mp ? mp.id : 0;
    if (n.meshParentId === oldId && !n.changed && (!mp || !mp.modified)) {
      n.modified = false;
      if (n.meshCombine && n.isDeformer) {
        for (;;) {
          if (D.isDeformer && D === n.meshParent) n.meshParent = D.meshParent;
          if (!D.meshCombine) break;
          D = nodes[D.parent]!;
        }
      }
      continue;
    }
    n.modified = true;
    n.breaksChain = mp !== null && (n.inheritMask & 0x2000000) === 0;
    n.isDeformer =
      !n.cur.empty &&
      n.meshKind !== 0 &&
      ms !== null &&
      ms.bp !== null &&
      n.drawable &&
      (n.syncChildMask & 8) !== 0;
    if ((0x22 >> n.type) & 1) {
      if (!n.meshParent) {
        n.anchor[0] = n.x;
        n.anchor[1] = n.y;
      } else {
        const p = mapAnchorX64(resource.kernel, scratch, n.meshParent, n.x, n.y, false);
        n.anchor[0] = p[0];
        n.anchor[1] = p[1];
      }
      n.anchor[2] = n.z;
    }
    if (n.cur.empty || !((0x1c01 >> n.type) & 1) || !n.drawable) continue;
    let bpSrc: Float32Array | null;
    if (!n.meshCombine) bpSrc = ms?.bp ?? null;
    else if (!n.isDeformer) bpSrc = null;
    else {
      const temp = Float32Array.from(ms!.bp!);
      for (;;) {
        if (D.isDeformer) {
          if (D === n.meshParent) n.meshParent = D.meshParent;
          const dbp = D.mstate!.bp!;
          for (let i = 0; i < 32; i++) temp[i] = temp[i]! + dbp[i]! - DEFAULT_MESH[i]!;
        }
        if (!D.meshCombine) break;
        D = nodes[D.parent]!;
      }
      bpSrc = temp;
    }
    const yy = f32(resource.zFactor * n.z + n.y);
    const xx = n.x;
    const oy = f32(n.cur.oy + n.originY),
      ox = f32(n.cur.ox + n.originX);
    const ty = f32(-f32(ox * n.m10 + oy * n.m11) + yy);
    const tx = f32(xx - f32(oy * n.m01 + n.m00 * ox));
    if (n.meshKind === 1 && ms) {
      const a = f32(n.w * n.m00),
        b = f32(n.h * n.m01),
        c = f32(n.w * n.m10),
        d = f32(n.h * n.m11);
      ms.ms[0] = a;
      ms.ms[1] = b;
      ms.ms[2] = c;
      ms.ms[3] = d;
      if (n.isDeformer) {
        const det = f32(d * a - c * b);
        ms.inv[0] = d / det;
        ms.inv[1] = -b / det;
        ms.inv[2] = -c / det;
        ms.inv[3] = a / det;
        ms.negTx = -tx;
        ms.negTy = -ty;
        const src = bpSrc!;
        for (let i = 0; i < 16; i++) {
          const px = src[i * 2]!,
            py = src[i * 2 + 1]!;
          ms.world[i * 2] = px * a + py * b + tx;
          ms.world[i * 2 + 1] = c * px + d * py + ty;
        }
      }
    }
    if (!((0x1401 >> n.type) & 1) || n.hidden) continue;
    const grid = (n.grid ??= {cols: 1, rows: 1, points: new Float32Array(8)});
    if (!ms || !bpSrc) {
      const w = n.w,
        h = n.h;
      const p00x = f32(n.m00 * 0 + n.m01 * 0 + tx),
        p00y = f32(n.m10 * 0 + n.m11 * 0 + ty);
      const p10x = f32(w * n.m00 + n.m01 * 0 + tx),
        p10y = f32(w * n.m10 + n.m11 * 0 + ty);
      const p01x = f32(n.m01 * h + n.m00 * 0 + tx),
        p01y = f32(n.m11 * h + n.m10 * 0 + ty);
      const p11x = f32(w * n.m00 + n.m01 * h + tx),
        p11y = f32(w * n.m10 + n.m11 * h + ty);
      const corners = scratch.quadCorners;
      corners[0] = p00x;
      corners[1] = p00y;
      corners[2] = p10x;
      corners[3] = p10y;
      corners[4] = p01x;
      corners[5] = p01y;
      corners[6] = p11x;
      corners[7] = p11y;
      if (!n.meshParent) {
        grid.cols = 1;
        grid.rows = 1;
        if (grid.points.length !== 8) grid.points = new Float32Array(8);
        grid.points.set(corners);
      } else {
        let N: number;
        const ratio = host.top.meshDivisionRatio;
        if (n.meshKind === 0) {
          let anc: EmoteScalarVertexNode = n.meshParent;
          while (!anc.isDeformer && anc.meshParent) anc = anc.meshParent;
          const div = Math.trunc(f32(anc.division * ratio));
          N = Math.floor(((div * (w + h)) >>> 0) / ((anc.w + anc.h) >>> 0 || 1));
        } else N = Math.trunc(f32(n.division * ratio)) >>> 0;
        let c0 = Math.floor(((w * N) >>> 0) / ((w + h) >>> 0 || 1));
        let r0 = (N - c0) >>> 0;
        if (c0 === 0) c0 = 1;
        if (r0 === 0) r0 = 1;
        const cols = c0 + 1,
          rows = r0 + 1;
        grid.cols = cols;
        grid.rows = rows;
        const size = (rows + 1) * (cols + 1) * 2;
        if (grid.points.length !== size) grid.points = new Float32Array(size);
        resource.kernel.subdivideQuad(corners, cols, rows, grid.points);
      }
    } else {
      grid.cols = ms.cols;
      grid.rows = ms.rows;
      const size = (ms.rows + 1) * (ms.cols + 1) * 2;
      if (grid.points.length !== size) grid.points = new Float32Array(size);
      resource.kernel.evaluateTransformedPatch(
        ms.bp!,
        ms.cols,
        ms.rows,
        ms.ms,
        tx,
        ty,
        grid.points,
      );
    }
    // Deformation by the mesh-parent chain; the anchor follows the same chain.
    const count = grid.points.length >> 1;
    let ax = xx,
      ay = yy;
    let X = n.meshParent;
    let stopX = ax,
      stopY = ay;
    if (!n.breaksChain && X) {
      let broke = false;
      while (X) {
        if (X.isDeformer) {
          const xm = X.mstate!;
          resource.kernel.deformPoints(xm.world, xm.inv, xm.negTx, xm.negTy, grid.points, count);
          [ax, ay] = mapThroughX64(resource.kernel, scratch, X, ax, ay);
        }
        stopX = ax;
        stopY = ay;
        const next: EmoteScalarVertexNode | null = X.meshParent;
        if (X.breaksChain) {
          X = next;
          broke = true;
          break;
        }
        X = next;
      }
      if (broke)
        for (; X; X = X.meshParent)
          if (X.isDeformer) [ax, ay] = mapThroughX64(resource.kernel, scratch, X, ax, ay);
    } else {
      for (; X; X = X.meshParent)
        if (X.isDeformer) [ax, ay] = mapThroughX64(resource.kernel, scratch, X, ax, ay);
    }
    if (ax !== stopX || ay !== stopY) {
      const dx = f32(ax - stopX),
        dy = f32(ay - stopY);
      for (let i = 0; i < count; i++) {
        grid.points[i * 2]! += dx;
        grid.points[i * 2 + 1]! += dy;
      }
    }
  }
}

function mapThroughX64(
  kernel: EmoteX64MeshKernel,
  scratch: EmoteScalarVertexScratch,
  X: EmoteScalarVertexNode,
  x: number,
  y: number,
): [number, number] {
  const xm = X.mstate!;
  const px = f32(x + xm.negTx),
    py = f32(y + xm.negTy);
  const p = scratch.mappedPoint;
  p[0] = f32(py * xm.inv[1]! + px * xm.inv[0]!);
  p[1] = f32(py * xm.inv[3]! + px * xm.inv[2]!);
  kernel.mapPatchPoints(p, 1, xm.world);
  scratch.mappedResult[0] = p[0]!;
  scratch.mappedResult[1] = p[1]!;
  return scratch.mappedResult;
}

/** The anchor walk of types 1 and 5. */
function mapAnchorX64(
  kernel: EmoteX64MeshKernel,
  scratch: EmoteScalarVertexScratch,
  start: EmoteScalarVertexNode,
  x: number,
  y: number,
  _unused: boolean,
): [number, number] {
  for (let X: EmoteScalarVertexNode | null = start; X; X = X.meshParent)
    if (X.isDeformer) [x, y] = mapThroughX64(kernel, scratch, X, x, y);
  return [x, y];
}

/** 0x180045900: x64 point/circle shapes retain integer radius and unsupported-kind errors. */
export function shapePassX64(nodes: readonly EmoteScalarVertexNode[]): void {
  for (const n of nodes) {
    if (!n.modified || !n.shapeInfo) continue;
    const info = n.shapeInfo;
    const shape = n.layer?.shape ?? 0;
    info[0] = shape;
    if (shape === 0 || shape === 1) {
      info[1] = n.anchor[0]!;
      info[2] = n.anchor[1]!;
      if (shape === 1) info[3] = Math.trunc(f32(n.zoomX * 16 * 0.5));
    } else throw new EmoteUnsupportedError(`shape ${shape}`);
  }
}

/** Only the frame, source and state read from an x86 mesh parent. */
export interface EmoteBlockMeshSyncParent extends Pick<
  EmoteBlockVertexNode,
  'mesh' | 'state' | 'resolved' | 'meshSync' | 'meshKind' | 'cur'
> {}
export interface EmoteBlockMeshSyncTarget {
  readonly coordinate: number;
  readonly inheritMask: number;
  readonly state: Pick<EmoteTransformState, 'x' | 'y' | 'z'>;
}
/** X64 projection uses the parent's coordinate flag. */
export interface EmoteScalarMeshSyncParent extends Pick<
  EmoteScalarVertexNode,
  'mstate' | 'drawable' | 'syncChildMask' | 'meshKind' | 'cur' | 'originX' | 'originY' | 'w' | 'h'
> {
  readonly visible: boolean;
  readonly coordinate: number;
}
export interface EmoteScalarMeshSyncTarget extends Pick<
  EmoteTransformState,
  'x' | 'y' | 'z' | 'angle' | 'zoomX' | 'zoomY'
> {
  readonly inheritMask: number;
}
/** The layer evaluator borrows the clip's kernel through its resource interface. */
export interface EmoteScalarMeshSyncHost {
  readonly resource: {readonly kernel: EmoteX64MeshKernel};
}

/** 0x1003e890: x86 position mapping and native unsupported angle/zoom error. */
export function syncToParentMeshX86(
  parent: EmoteBlockMeshSyncParent,
  node: EmoteBlockMeshSyncTarget,
): void {
  const mesh = parent.mesh;
  if (!mesh || mesh.local.length === 0 || !parent.state.visible || !parent.resolved.drawable)
    return;
  if (!(parent.meshSync & 1) || parent.meshKind !== 1) return;
  if (
    (parent.meshSync & 2 && node.inheritMask & 0x10) ||
    (parent.meshSync & 4 && node.inheritMask & 0x60)
  )
    throw new EmoteClipUnsupportedError('meshSyncChildMask angle/zoom (0x1003e890)');
  const cur = parent.cur,
    w = parent.resolved.rect[2]!,
    h = parent.resolved.rect[3]!;
  const ox = f(cur.ox + parent.resolved.originX),
    oy = f(cur.oy + parent.resolved.originY);
  const s = node.state,
    b = node.coordinate === 0 ? s.y : s.z;
  const p = [0, 0];
  patchPoint(mesh.local, f(f(ox + s.x) / w), f(f(oy + b) / h), p);
  s.x = f(w * p[0]! - ox);
  if (node.coordinate === 0) s.y = f(h * p[1]! - oy);
  else s.z = f(h * p[1]! - oy);
}

/** 0x180042bb0: x64 position and finite-difference angle/zoom mapping. */
export function syncToParentMeshX64(
  this: EmoteScalarMeshSyncHost,
  P: EmoteScalarMeshSyncParent,
  n: EmoteScalarMeshSyncTarget,
): void {
  const ms = P.mstate;
  if (!ms?.bp || !P.visible || !P.drawable || !(P.syncChildMask & 1) || P.meshKind !== 1) return;
  const f13 = f32(P.cur.ox + P.originX),
    f14 = f32(P.cur.oy + P.originY);
  const yz = P.coordinate === 0 ? n.y : n.z;
  const u = f32(f32(n.x + f13) / P.w),
    v = f32(f32(yz + f14) / P.h);
  const pt = new Float32Array([u, v]);
  this.resource.kernel.mapPatchPoints(pt, 1, ms.bp);
  const ny = f32(P.h * pt[1]! - f14);
  if (P.coordinate === 0) n.y = ny;
  else n.z = ny;
  n.x = f32(P.w * pt[0]! - f13);
  const bAng = (P.syncChildMask & 2) !== 0 && (n.inheritMask & 0x10) !== 0;
  const bZoom = (P.syncChildMask & 4) !== 0 && (n.inheritMask & 0x60) !== 0;
  if (!bAng && !bZoom) return;
  const d = f32(0.0001);
  const q = new Float32Array([u - d, v, u + d, v, u, v - d, u, v + d]);
  this.resource.kernel.mapPatchPoints(q, 4, ms.bp);
  const [xu0, yu0, xu1, yu1, xv0, yv0, xv1, yv1] = q as unknown as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (bAng) {
    const a1 = Math.atan2(-(xv1 - xv0), yv1 - yv0);
    const a2 = Math.atan2(yu1 - yu0, xu1 - xu0);
    n.angle = f32(f32(((a1 + a2) * 0.5 * 360) / f32(Math.PI * 2)) + n.angle);
  }
  if (bZoom) {
    const dx = xu1 - xu0,
      dy = yu1 - yu0;
    const t1 = Math.abs((yv0 - yu0) * dx - (xv0 - xu0) * dy) * 0.5;
    const t2 = Math.abs((yv1 - yu0) * dx - (xv1 - xu0) * dy) * 0.5;
    const s = f32(Math.sqrt(2 * (t1 + t2)) / f32(0.0002));
    if (n.inheritMask & 0x20) n.zoomX = f32(s * n.zoomX);
    if (n.inheritMask & 0x40) n.zoomY = f32(s * n.zoomY);
  }
}
