import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisRevision} from './revision.js';

export interface ArtemisPrintResult {
  /** Native layer result: -1 unprintable block, -2 vertical overflow, otherwise count. */
  readonly result: number;
  /** Cursor at the first unconsumed token, measured in input UTF-8 bytes. */
  readonly consumedBytes: number;
}
export interface ArtemisPrintHost {
  currentMessageLayer(): string;
  rubyActive(): boolean;
  debugSkipActive(): boolean;
  /** Performs actual text insertion/layout on the captured selected resource. */
  print(layer: string, bytes: Uint8Array): Promise<ArtemisPrintResult>;
  appendRubyBytes(bytes: Uint8Array): void;
  fontOverflowPolicy(layer: string): number;
  writeOverflowed(value: number): void;
  reportPrintError(tag: AsbTag, kind: 'unprintable' | 'overflow', remainder: Uint8Array): void;
  /** Appends to the FIFO, including after tags already pending; must retain a copy. */
  enqueue(tag: AsbTag): void;
  recordPrintCommand(layer: string, tag: AsbTag): void;
}
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
function encoded(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  if (decoder.decode(bytes) !== value) throw Error('Unsupported Artemis print UTF-8');
  return bytes;
}
/** cc6c0 print dispatch, overflow splitting and command history. Actual native
 * CLinkableTextLayer insertion/layout is a required owner, never a recording noop.
 */
export class ArtemisPrint {
  private pending = false;
  private generation = 0;
  constructor(
    executableSha256: string,
    private readonly host: ArtemisPrintHost,
  ) {
    artemisRevision(executableSha256);
  }
  /** Script transfer discards later script effects. The layout owner independently
   * cancels its insertion job before reusing the selected text resources. */
  cancelPending(): void {
    this.generation++;
    this.pending = false;
  }
  async dispatch(input: AsbTag, recordHistory = true): Promise<boolean> {
    if (input.name !== 'print') return false;
    if (this.pending) throw Error('Overlapping Artemis print operations');
    this.pending = true;
    const generation = this.generation;
    try {
      const tag = {...input, args: new Map(input.args)},
        layer = this.host.currentMessageLayer();
      if (this.host.rubyActive()) {
        if (!tag.args.has('data')) tag.args.set('data', '');
        this.host.appendRubyBytes(encoded(tag.args.get('data')!));
      } else if (!this.host.debugSkipActive()) {
        if (!tag.args.has('data')) tag.args.set('data', '');
        const original = tag.args.get('data')!,
          bytes = encoded(original),
          nul = bytes.indexOf(0),
          data = nul < 0 ? bytes : bytes.subarray(0, nul);
        const result = await this.host.print(layer, Uint8Array.from(data));
        if (generation !== this.generation) throw Error('Artemis print cancelled');
        if (
          !Number.isInteger(result.result) ||
          result.result < -0x80000000 ||
          result.result > 0x7fffffff
        )
          throw Error('Invalid Artemis print result');
        if (result.result === -1 || result.result === -2) {
          const consumed = result.consumedBytes;
          if (!Number.isInteger(consumed) || consumed < 0 || consumed > data.length)
            throw Error('Invalid Artemis print cursor');
          const prefix = decoder.decode(data.subarray(0, consumed)),
            remainder = data.subarray(consumed);
          // Validate the native UTF-8 boundary before publishing any script effects.
          const tail = decoder.decode(remainder);
          this.host.reportPrintError(
            tag,
            result.result === -1 ? 'unprintable' : 'overflow',
            Uint8Array.from(remainder),
          );
          if (result.result === -1) return true;
          this.host.writeOverflowed(1);
          if (this.host.fontOverflowPolicy(layer) === 0) {
            this.host.enqueue({kind: 'tag', name: '@', sourceLine: 0, args: new Map()});
            this.host.enqueue({kind: 'tag', name: 'rp', sourceLine: 0, args: new Map()});
            const args = new Map(tag.args);
            args.set('data', tail);
            this.host.enqueue({...tag, args});
          }
          if (recordHistory) {
            tag.args.set('data', prefix);
            this.host.recordPrintCommand(layer, tag);
          }
          return true;
        }
      }
      if (recordHistory) this.host.recordPrintCommand(layer, tag);
      return true;
    } finally {
      if (generation === this.generation) this.pending = false;
    }
  }
}
