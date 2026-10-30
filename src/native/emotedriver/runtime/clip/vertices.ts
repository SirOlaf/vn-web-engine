import type {EmoteClip} from './clip.js';
import {IDENTITY_PATCH, patchPoint, roundHalfEven} from './interpolate.js';
import {VertexGrid, type EmoteNode} from './node.js';

/**
 * Passes after the layer transforms in the layer pass 0x1003ece0 (`emotedriver.dll` SHA-256
 * `a3b693b6…5e70b3a86`): vertices 0x1003f9c0, mask links 0x10040840, clip rectangles
 * 0x10040e80 and shapes 0x10041160. The per-vertex loops run in the mesh kernel.
 */

const f = Math.fround;

/** A point through an ancestor's mesh: its inverse frame, then its world patch (0x1002b320). */
function throughMesh(a: EmoteNode, x: number, y: number, out: number[]): void {
  const m = a.mesh!,
    i = m.inverse;
  const px = f(m.translateX + x),
    py = f(m.translateY + y);
  const u = f(px * i[0]! + py * i[1]!),
    v = f(py * i[3]! + i[2]! * px);
  patchPoint(m.world, u, v, out);
}

/** 0x1003f9c0: mesh links, bezier frames and vertex grids of every node. */
export function meshPass(clip: EmoteClip): void {
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
        for (let a: EmoteNode | null = mp; a; a = a.meshParent)
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
      a: EmoteNode | null = node.meshParent,
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
  clip: EmoteClip,
  node: EmoteNode,
  start: EmoteNode,
  patch: Float32Array | null,
): void {
  let a: EmoteNode | undefined = start;
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
export function maskPass(clip: EmoteClip): void {
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
export function clipRectPass(clip: EmoteClip): void {
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
export function shapePass(clip: EmoteClip): void {
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
