import type {AsbTag} from '../../formats/artemis/asb.js';
import {ArtemisLinearFloatTween, ArtemisLinearIntegerTween} from './integer-tween.js';
import {artemisInteger} from './numbers.js';
import {artemisRevision} from './revision.js';

/** Raw image rows as the native image object exposes them (+0x10 width, +0x18 height,
 * +0x40 bytes per pixel, +0x60 row pointer). */
export interface ArtemisRuleBitmap {
  readonly width: number;
  readonly height: number;
  readonly bytesPerPixel: number;
  readonly pixels: Uint8Array;
}
export interface ArtemisRuleImage extends ArtemisRuleBitmap {
  /** Image virtual +0x20; nonzero formats are refused as non-gray rule images. */
  readonly format: number;
}

/** 0x140171140: each destination row repeats source row (y mod source height) across its
 * byte width in source-row-sized chunks, the last chunk truncated. Rows are tightly packed. */
export function tileArtemisRule(target: ArtemisRuleBitmap, source: ArtemisRuleBitmap): void {
  const targetRow = target.width * target.bytesPerPixel,
    sourceRow = source.width * source.bytesPerPixel;
  if (target.pixels.length < targetRow * target.height || sourceRow <= 0)
    throw Error('Invalid Artemis rule bitmap');
  let sourceY = 0;
  for (let y = 0; y < target.height; y++) {
    const row = source.pixels.subarray(sourceY * sourceRow, (sourceY + 1) * sourceRow);
    if (row.length !== sourceRow) throw Error('Invalid Artemis rule bitmap');
    for (let x = 0; x < targetRow; x += sourceRow)
      target.pixels.set(row.subarray(0, Math.min(sourceRow, targetRow - x)), y * targetRow + x);
    if (++sourceY >= source.height) sourceY = 0;
  }
}

export type ArtemisTransitionTween = ArtemisLinearFloatTween | ArtemisLinearIntegerTween;

export interface ArtemisTransitionHost {
  /** Script field +0x3520; nonzero makes trans return immediately. */
  captureMode(): number;
  /** Stage commit 0x14014f420 (ArtemisStage.commit). */
  commit(): void;
  /** Writes previous mode c74 and the run mode unless the current mode is 13. */
  enterRunMode(mode: 2 | 4): void;
  /** Completion callback 0x1400b7440 tail: run mode release 0x1400c6480. */
  releaseRunMode(): void;
  /** timeGetTime after the shared timeBeginPeriod(1), as uint32 milliseconds. */
  now(): number;
  /** Writes wait timestamp b94. */
  setWaitStart(ms: number): void;
  /** Script bytes +0x48 (skip allowed), +0x49 (command skip), +0x4a (control skip). */
  skipState(): {readonly allowed: boolean; readonly command: boolean; readonly control: boolean};
  /** Stage field +0x60. */
  setTransitionState(value: 1 | 2): void;
  /** Transition layer (stage +0x40) virtual +0xb0. */
  setCrossfade(value: number): void;
  /** Stage +0x108/+0x10c. */
  stageSize(): {readonly width: number; readonly height: number};
  /** Stage +0xf8 image factory +0x68, then loader (stage +0x10) virtual +0x20. Null is a
   * load failure. */
  loadRule(path: string): Promise<ArtemisRuleImage | null>;
  /** Replaces the stage +0x50 rule image (same size as the stage). */
  setRuleImage(image: ArtemisRuleImage): void;
  /** The existing stage +0x50 rule image, written in place by tiling. */
  ruleImage(): ArtemisRuleBitmap;
  /** Stage +0x68 vague and +0x64 rule threshold. */
  setVague(value: number): void;
  setRuleThreshold(value: number): void;
  /** Global tween registry 0x1400a5360; the frame owner ticks it. */
  registerTween(tween: ArtemisTransitionTween): void;
  /** c7260(script, 1, tag, message); message bytes are the native Shift-JIS literal. */
  reportError(tag: AsbTag, message: Uint8Array): void;
}

// 0x1403723c8 and 0x140372420 (Shift-JIS).
const ruleLoadError = Uint8Array.from(
  '8347834e8358835e815b8369838b8367838983938357835683878393977082cc838b815b838b89e6919c82aa93c782dd8d9e82df82dc82b982f18142'
    .match(/../g)!
    .map((byte) => Number.parseInt(byte, 16)),
);
const ruleFormatError = Uint8Array.from(
  '8347834e8358835e815b8369838b8367838983938357835683878393977082cc838b815b838b89e6919c82cc83748348815b837d8362836782aa834f838c815b'
    .match(/../g)!
    .map((byte) => Number.parseInt(byte, 16)),
);
export const artemisTransitionErrors = {ruleLoad: ruleLoadError, ruleFormat: ruleFormatError};

/** Native trans tag 0x1400e10c0. Type compares exactly: "0" commits and waits in run mode
 * 4 with wait timestamp b94; "1" starts the stage crossfade (float 0 to 1); "2" starts the
 * rule transition (integer -vague to vague+255). Both tweens complete through 0x1400b7440
 * (stage commit, then run mode release). Other types do nothing. Missing time/vague read
 * as empty strings (atoi 0).
 */
export class ArtemisTransition {
  private current: ArtemisTransitionTween | null = null;
  constructor(
    private readonly hash: string,
    private readonly host: ArtemisTransitionHost,
  ) {
    artemisRevision(hash);
  }
  /** Script field +0x3858: the last registered transition tween, finished by the frame
   * owner's mode 2 click (0x1400a54b0). */
  get tween(): ArtemisTransitionTween | null {
    return this.current;
  }
  /** bf210: a54b0 finishes the registered tween (its completion runs synchronously),
   * then +0x3858 is cleared. */
  reset(): void {
    this.current?.finish();
    this.current = null;
  }
  /** False for other tags; a promise while a rule image loads. */
  dispatch(tag: AsbTag): boolean | Promise<void> {
    if (tag.name !== 'trans') return false;
    if (this.host.captureMode() !== 0) return true;
    const args = tag.args,
      type = args.get('type') ?? '',
      time = () => artemisInteger(args.get('time') ?? '');
    if (type === '0') {
      this.host.commit();
      this.host.enterRunMode(4);
      this.host.setWaitStart(this.host.now() >>> 0);
      return true;
    }
    if (type === '1') {
      this.host.setTransitionState(1);
      const tween = new ArtemisLinearFloatTween(
        this.hash,
        0,
        1,
        time(),
        (value) => this.host.setCrossfade(value),
        () => this.complete(),
      );
      this.host.setCrossfade(0);
      this.start(tween, tag);
      return true;
    }
    if (type !== '2') return true;
    return this.rule(tag, time);
  }
  private async rule(tag: AsbTag, time: () => number): Promise<void> {
    const image = await this.host.loadRule(tag.args.get('rule') ?? '');
    if (!image) return this.host.reportError(tag, ruleLoadError);
    if (image.format !== 0) return this.host.reportError(tag, ruleFormatError);
    const size = this.host.stageSize();
    if (image.width === size.width && image.height === size.height) this.host.setRuleImage(image);
    else tileArtemisRule(this.host.ruleImage(), image);
    this.host.setTransitionState(2);
    const vague = artemisInteger(tag.args.get('vague') ?? '');
    this.host.setVague(vague);
    this.host.setRuleThreshold(-vague | 0);
    const tween = new ArtemisLinearIntegerTween(
      this.hash,
      -vague | 0,
      (vague + 0xff) | 0,
      time(),
      (value) => this.host.setRuleThreshold(value),
      () => this.complete(),
    );
    this.start(tween, tag);
  }
  private complete(): void {
    this.host.commit();
    this.host.releaseRunMode();
  }
  /** Registration, then the input run mode: absent or other values 2; "0" 4; "2" 4 unless
   * skip is allowed and active, or capture mode is set. */
  private start(tween: ArtemisTransitionTween, tag: AsbTag): void {
    this.host.registerTween(tween);
    this.current = tween;
    const input = tag.args.get('input');
    let mode: 2 | 4 = 2;
    if (input === '0') mode = 4;
    else if (input === '2') {
      const skip = this.host.skipState();
      if (!((skip.allowed && (skip.command || skip.control)) || this.host.captureMode() !== 0))
        mode = 4;
    }
    this.host.enterRunMode(mode);
  }
}
