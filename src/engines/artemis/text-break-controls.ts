import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisInteger} from './numbers.js';

export interface ArtemisIndentation {
  readonly pairs: ReadonlyMap<string, string>;
  readonly range: number;
  readonly logicalRange: boolean;
  readonly nest: boolean;
}
export interface ArtemisTextBreakHost {
  unindent?(count: number): void;
  /** Copies the pair map and scalar settings into the selected text resource. */
  setIndentation(value: ArtemisIndentation): void;
  /** Empty sets request native encoding-specific defaults, not disabled restrictions. */
  setProhibitedCharacters(head: ReadonlySet<string>, foot: ReadonlySet<string>): void;
  setWordParts(parts: ReadonlySet<string>): void;
  currentMessageLayer(): string;
  recordTextCommand(layer: string, tag: AsbTag): void;
  /** Copies this command into the corresponding native replay slot. */
  rememberTextCommand(layer: string, slot: 'prohibit' | 'indent', tag: AsbTag): void;
}
/** Valid UTF-8 character spans; native commands stop at the first NUL. Legacy encodings
 * and malformed byte sequences are outside this string-valued tag bridge.
 */
function characters(value: string): string[] {
  const text = value.split('\0', 1)[0]!;
  if (new TextDecoder('utf-8', {ignoreBOM: true}).decode(new TextEncoder().encode(text)) !== text)
    throw Error('Unsupported Artemis text-control UTF-8');
  return Array.from(text);
}
function enabled(args: ReadonlyMap<string, string>, key: string): boolean {
  return args.has(key) && args.get(key) !== '0';
}
/** d0510/cff50/d0d00 native text break configuration. Actual layout and selected
 * CLinkableTextLayer resource storage remain mandatory host effects.
 */
export class ArtemisTextBreakControls {
  constructor(
    private readonly host: ArtemisTextBreakHost,
    private readonly indentModify = false,
  ) {}
  dispatch(tag: AsbTag, recordHistory = true): boolean {
    if (tag.name === 'indentmodify') {
      if (!this.indentModify) return false;
      if (tag.args.has('unindent')) {
        if (!this.host.unindent) throw Error('Artemis unindent owner is not configured');
        this.host.unindent(artemisInteger(tag.args.get('unindent')!));
      }
      // d87a0 records history only; it does not change the persistent indent replay slot.
      if (recordHistory)
        this.host.recordTextCommand(this.host.currentMessageLayer(), {
          ...tag,
          args: new Map(tag.args),
        });
      return true;
    }
    if (!['indent', 'prohibit', 'wordparts'].includes(tag.name)) return false;
    const args = tag.args;
    if (tag.name === 'indent') {
      const spans = characters(args.get('pair') ?? '');
      const pairs = new Map<string, string>();
      for (let i = 0; i + 1 < spans.length; i += 2) pairs.set(spans[i]!, spans[i + 1]!);
      this.host.setIndentation({
        pairs,
        range: artemisInteger(args.get('range') ?? ''),
        logicalRange: enabled(args, 'logicalrange'),
        nest: enabled(args, 'nest'),
      });
    } else if (tag.name === 'prohibit') {
      this.host.setProhibitedCharacters(
        new Set(characters(args.get('head') ?? '')),
        new Set(characters(args.get('foot') ?? '')),
      );
    } else this.host.setWordParts(new Set(characters(args.get('parts') ?? '')));
    if (recordHistory) {
      const layer = this.host.currentMessageLayer();
      const copy = {...tag, args: new Map(args)};
      this.host.recordTextCommand(layer, copy);
      this.host.rememberTextCommand(layer, tag.name === 'prohibit' ? 'prohibit' : 'indent', {
        ...copy,
        args: new Map(args),
      });
    }
    return true;
  }
}

/** Encoding=2 branch of CLinkableTextLayer::194420. Each empty input independently
 * restores its native default set. A space is an explicit restriction, not empty.
 */
export function artemisUtf8Prohibition(
  head: ReadonlySet<string>,
  foot: ReadonlySet<string>,
): {head: Set<string>; foot: Set<string>} {
  return {
    head: new Set(head.size ? head : Array.from('!?%)]},.:;、。，．・：；！？」』）｝〕］】')),
    foot: new Set(foot.size ? foot : Array.from('([{「『（｛〔［【')),
  };
}
