import type {FrameSlot} from './frame.js';
import {EmoteClipUnsupportedError} from './frame.js';
import {EmoteUnsupportedError} from '../errors.js';
import type {EmoteClipNodes, EmoteClipEvent} from '../interfaces.js';
import type {EmoteTransformState} from './layer.js';
import type {EmoteMatrixValues} from './matrix.js';
import {lerpAngle} from './interpolate.js';
import {EMOTEDRIVER_X64_SHA256} from '../../build.js';

const f = Math.fround;
type EmoteNestedFrame = Pick<
  FrameSlot,
  'empty' | 'src' | 'icon' | 'time' | 'tween' | 'ox' | 'oy' | 'motion' | 'angleCurve'
>;

/** Parent clock state read by the native nested-motion passes. */
interface EmoteNestedClock {
  readonly timeRunning: number;
  readonly step: number;
  readonly jumped: boolean;
}
interface EmoteNestedClipClock {
  playing: boolean;
  readonly jumped: boolean;
  readonly loopTime: number;
  readonly lastTime: number;
  replay: boolean;
  color: number;
  motionName: string;
}

/** X86 child operations of MMotionPlayer, independent of its concrete class. */
export interface EmoteBlockNestedClip<Link>
  extends Omit<EmoteClipNodes, 'color'>, EmoteNestedClipClock {
  objectName: string;
  readonly root: {
    readonly adjust: EmoteTransformState;
    readonly matrix: Float32Array;
    meshParent: Link | null;
    maskNode: Link | null;
    clipRect: Float32Array | null;
  };
  events: EmoteClipEvent[];
  unload(): void;
  selectObject(name: string): void;
  selectMotion(name: string, flags: number): void;
  seek(time: number): void;
  advance(frames: number): void;
  evaluate(): void;
}
export interface EmoteBlockNestedNode<Link> {
  readonly child: EmoteBlockNestedClip<Link> | null;
  readonly state: EmoteTransformState;
  readonly matrix: Float32Array;
  readonly cur: EmoteNestedFrame;
  readonly next: EmoteNestedFrame;
  readonly parameter: {readonly position: number; readonly flags: number} | null;
  readonly framesDirty: boolean;
  readonly coordinate: number;
  readonly colors: Uint32Array;
  readonly meshParent: Link | null;
  readonly maskNode: Link | null;
  readonly clipRect: Float32Array | null;
}
export interface EmoteBlockNestedHost extends EmoteNestedClock {
  events: EmoteClipEvent[];
}

export interface EmoteScalarNestedRoot<Link> {
  readonly adjust: EmoteTransformState;
  m00: number;
  m01: number;
  m10: number;
  m11: number;
  meshParent: Link | null;
  stencilParent: Link | null;
  copyMatrix(source: EmoteMatrixValues): void;
}
/** X64 child operations; nested progress deliberately bypasses the outer clip queue. */
export interface EmoteScalarNestedClip<Link> extends EmoteNestedClipClock {
  playingName: string;
  readonly root: EmoteScalarNestedRoot<Link>;
  layerEvents: EmoteClipEvent[];
  reset(): void;
  selectObject(name: string): void;
  setMotion(name: string, flags: number): void;
  seekTo(time: number): void;
  progressSub(frames: number): void;
}
export interface EmoteScalarNestedNode<Link> extends EmoteTransformState, EmoteMatrixValues {
  readonly sub: EmoteScalarNestedClip<Link> | null;
  readonly cur: EmoteNestedFrame;
  readonly next: EmoteNestedFrame;
  readonly param: {readonly value: number; readonly flags: number} | null;
  readonly framesDirty: boolean;
  readonly coordinate: number;
  readonly colors: Uint32Array;
  readonly meshParent: Link | null;
  readonly stencilParent: Link | null;
}
export interface EmoteScalarNestedHost extends EmoteNestedClock {
  readonly time: number;
  layerEvents: EmoteClipEvent[];
}

/** 0x10041510, image a3b693b6…5e70b3a86: block state, matrix, mask and clip links. */
export function evaluateBlockMotions<Node extends EmoteBlockNestedNode<Node>>(
  host: EmoteBlockNestedHost,
  nodes: readonly Node[],
  clipFlags: number,
): void {
  for (const node of nodes) {
    const child = node.child!;
    const cur = node.cur,
      other = node.next;
    const time = node.parameter ? node.parameter.position : host.timeRunning;
    const stepRef = node.parameter ? node.parameter.position : host.step;
    const flags = node.parameter ? node.parameter.flags : clipFlags;
    if (node.state.changed || flags !== 0) {
      if (cur.empty || cur.src === '') {
        child.playing = false;
        child.unload();
        child.objectName = child.motionName = '';
        continue;
      }
      if (node.framesDirty || flags & 5) {
        child.selectObject(cur.src!);
        child.selectMotion(cur.icon!, cur.motion.flags);
        if (child.playing && child.jumped) {
          let t = f(f(time - cur.time) + cur.motion.timeOffset);
          if (host.step < 0 && child.loopTime > 0 && t > child.lastTime)
            do t = f(t - child.lastTime + child.loopTime);
            while (t > child.lastTime);
          child.seek(t);
          if (!host.jumped) child.replay = true;
        }
      }
      let dofst = cur.motion.dofst,
        angle = 0,
        apply = false;
      if (cur.motion.dt !== 0) {
        if (cur.motion.docmpl && cur.tween && !other.empty && other.motion.dt !== 0)
          dofst = lerpAngle(
            cur.angleCurve,
            dofst,
            other.motion.dofst,
            f((stepRef - cur.time) / (other.time - cur.time)),
          );
        if (cur.motion.dt !== 1)
          throw new EmoteClipUnsupportedError(`nested motion direction type ${cur.motion.dt}`);
        angle = f(node.state.angle + dofst);
        apply = true;
      }
      const s = node.state,
        m = node.matrix;
      let x = s.x,
        y = s.y,
        z = s.z;
      if (cur.ox !== 0 || cur.oy !== 0) {
        const ox = -cur.ox,
          oy = -cur.oy;
        const dx = f(ox * m[0]! + oy * m[1]!),
          dy = f(oy * m[3]! + m[2]! * ox);
        if (node.coordinate === 0) {
          x = f(x + dx);
          y = f(y + dy);
        } else if (node.coordinate === 1) {
          x = f(x + dx);
          z = f(z + dy);
        }
      }
      const ra = child.root.adjust;
      const set = <K extends keyof typeof ra>(key: K, value: (typeof ra)[K]) => {
        if (ra[key] !== value) {
          ra.changed = true;
          ra[key] = value;
        }
      };
      if (ra.x !== x || ra.y !== y || ra.z !== z) {
        ra.changed = true;
        ra.x = x;
        ra.y = y;
        ra.z = z;
      }
      if (ra.flipX !== s.flipX || ra.flipY !== s.flipY) {
        ra.changed = true;
        ra.flipX = s.flipX;
        ra.flipY = s.flipY;
      }
      if (ra.zoomX !== s.zoomX || ra.zoomY !== s.zoomY) {
        ra.changed = true;
        ra.zoomX = s.zoomX;
        ra.zoomY = s.zoomY;
      }
      if (apply) set('angle', angle);
      if (ra.slantX !== s.slantX || ra.slantY !== s.slantY) {
        ra.changed = true;
        ra.slantX = s.slantX;
        ra.slantY = s.slantY;
      }
      set('opacity', s.opacity);
      set('shown', s.visible);
      child.color = node.colors[0]!;
      const cm = child.root.matrix;
      if (!apply || s.angle === angle) cm.set(m);
      else {
        let rad = f(f((angle - s.angle) * 3.1415927410125732 * 2) / 360);
        if (s.flipY !== s.flipX) rad = -rad;
        const sn = f(Math.sin(rad)),
          cs = f(Math.cos(rad)),
          ns = -sn;
        const m0 = m[0]!,
          m1 = m[1]!,
          m2 = m[2]!,
          m3 = m[3]!;
        cm[0] = m1 * sn + cs * m0;
        cm[1] = m1 * cs + ns * m0;
        cm[2] = m2 * cs + m3 * sn;
        cm[3] = cs * m3 + m2 * ns;
      }
      ra.changed = true;
    }
    // LAB_10041f72: links, then the child steps with this clip and evaluates.
    const cr = child.root;
    cr.meshParent = node.meshParent;
    cr.maskNode = node.maskNode;
    cr.clipRect = node.clipRect;
    child.advance(host.step);
    child.evaluate();
    if (child.events.length) {
      host.events.push(...child.events);
      child.events = [];
    }
  }
}

/** 0x180045c50, image80d28bd0…1e051: scalar state, parent matrix and nested events. */
export function evaluateScalarMotions<Node extends EmoteScalarNestedNode<Node>>(
  host: EmoteScalarNestedHost,
  nodes: readonly Node[],
  clipFlags: number,
): void {
  for (const n of nodes) {
    const sub = n.sub;
    if (!sub) continue;
    const tClamped = n.param ? n.param.value : host.time;
    const tTime = n.param ? n.param.value : host.timeRunning;
    const flags = n.param ? n.param.flags : clipFlags;
    const A = n.cur,
      B = n.next;
    if (n.changed || flags) {
      if (A.empty || !A.src) {
        sub.playing = false;
        sub.reset();
        sub.motionName = '';
        sub.playingName = '';
        continue;
      }
      if (n.framesDirty || flags & 5) {
        sub.selectObject(A.src);
        sub.setMotion(A.icon ?? '', flags | A.motion.flags);
        if (sub.playing && sub.jumped) {
          let t = f(f(tTime - A.time) + A.motion.timeOffset);
          if (host.step < 0 && sub.loopTime >= 0 && sub.lastTime > sub.loopTime)
            while (sub.lastTime <= t) t = f(f(t - sub.lastTime) + sub.loopTime);
          sub.seekTo(t);
          if (!host.jumped) sub.replay = true;
        }
      }
      let bAng = false;
      let angle = 0;
      const dt = A.motion.dt;
      if (dt !== 0) {
        let dofst = A.motion.dofst;
        if (A.motion.docmpl && A.tween && !B.empty && B.motion.dt !== 0) {
          const e = f(f(tClamped - A.time) / f(B.time - A.time));
          dofst = lerpAngle(null, dofst, B.motion.dofst, e, EMOTEDRIVER_X64_SHA256);
        }
        if (dt === 1) {
          angle = f(dofst + n.angle);
          bAng = true;
        } else throw new EmoteUnsupportedError(`nested-motion direction mode ${dt}`);
      }
      let cx = n.x,
        cy = n.y,
        cz = n.z;
      if (A.ox !== 0 || A.oy !== 0) {
        const ox = -A.ox,
          oy = -A.oy;
        const rx = f(oy * n.m01 + ox * n.m00),
          ry = f(oy * n.m11 + ox * n.m10);
        if (n.coordinate === 0) {
          cx = f(cx + rx);
          cy = f(cy + ry);
        } else if (n.coordinate === 1) {
          cx = f(rx + cx);
          cz = f(ry + cz);
        }
      }
      const r = sub.root;
      if (r.adjust.x !== cx || r.adjust.y !== cy || r.adjust.z !== cz) {
        r.adjust.changed = true;
        r.adjust.x = cx;
        r.adjust.y = cy;
        r.adjust.z = cz;
      }
      if (r.adjust.flipX !== n.flipX || r.adjust.flipY !== n.flipY) {
        r.adjust.changed = true;
        r.adjust.flipX = n.flipX;
        r.adjust.flipY = n.flipY;
      }
      if (r.adjust.zoomX !== n.zoomX || r.adjust.zoomY !== n.zoomY) {
        r.adjust.changed = true;
        r.adjust.zoomX = n.zoomX;
        r.adjust.zoomY = n.zoomY;
      }
      if (bAng && r.adjust.angle !== angle) {
        r.adjust.changed = true;
        r.adjust.angle = angle;
      }
      if (r.adjust.slantX !== n.slantX || r.adjust.slantY !== n.slantY) {
        r.adjust.changed = true;
        r.adjust.slantX = n.slantX;
        r.adjust.slantY = n.slantY;
      }
      if (r.adjust.opacity !== n.opacity) {
        r.adjust.changed = true;
        r.adjust.opacity = n.opacity;
      }
      if (r.adjust.shown !== n.visible) {
        r.adjust.changed = true;
        r.adjust.shown = n.visible;
      }
      sub.color = n.colors[0]!;
      if (bAng && angle !== n.angle) {
        const d = f(f(f(f(angle - n.angle) * f(Math.PI)) * 2) / 360);
        const s = f(Math.sin(d)),
          c = f(Math.cos(d));
        r.m00 = f(-s * n.m10 + c * n.m00);
        r.m01 = f(c * n.m01 + -s * n.m11);
        r.m10 = f(c * n.m10 + s * n.m00);
        r.m11 = f(s * n.m01 + c * n.m11);
      } else r.copyMatrix(n);
      r.adjust.changed = true;
    }
    const r = sub.root;
    r.meshParent = n.meshParent;
    r.stencilParent = n.stencilParent;
    sub.progressSub(host.step);
    if (sub.layerEvents.length) {
      host.layerEvents.push(...sub.layerEvents);
      sub.layerEvents = [];
    }
  }
}
