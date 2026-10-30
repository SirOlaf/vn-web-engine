import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisRevision} from './revision.js';

export interface ArtemisRubyHost {
  currentMessageLayer(): string;
  insertRuby(layer: string, main: Uint8Array, ruby: Uint8Array): Promise<number>;
  fontOverflowPolicy(layer: string): number;
  writeOverflowed(value: number): void;
  enqueue(tag: AsbTag): void;
  recordTextCommand(layer: string, tag: AsbTag): void;
  reportRubyError(
    tag: AsbTag,
    kind: 'nested' | 'inactive' | 'unprintable' | 'overflow',
    main: Uint8Array,
  ): void;
}
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
function bytes(value: string): Uint8Array<ArrayBuffer> {
  const encoded = encoder.encode(value);
  if (decoder.decode(encoded) !== value) throw Error('Unsupported Artemis ruby UTF-8');
  return encoded;
}
/** d1010/d1150 global ruby buffers. Each print records its selected layer, while
 * /ruby inserts the entire accumulated block into the layer selected at end.
 */
export class ArtemisRuby {
  private enabled = false;
  private main = new Uint8Array();
  private annotation = new Uint8Array();
  private pending = false;
  private generation = 0;
  private closed = false;
  close(): void {
    this.closed = true;
    this.generation++;
    this.pending = false;
    this.enabled = false;
    this.main = new Uint8Array();
    this.annotation = new Uint8Array();
  }
  /** bf210 clears 3770/3778/3798. */
  reset(): void {
    if (this.pending) throw Error('Overlapping Artemis ruby operations');
    this.enabled = false;
    this.main = new Uint8Array();
    this.annotation = new Uint8Array();
  }
  constructor(
    hash: string,
    private readonly host: ArtemisRubyHost,
  ) {
    artemisRevision(hash);
  }
  get active(): boolean {
    return this.enabled;
  }
  appendRubyBytes(input: Uint8Array): void {
    if (this.closed) throw Error('Artemis ruby closed');
    if (this.pending) throw Error('Overlapping Artemis ruby operations');
    if (!this.enabled) throw Error('Artemis ruby buffer inactive');
    if (this.main.length + input.length > 1024 * 1024)
      throw Error('Artemis ruby byte budget exceeded');
    const next = new Uint8Array(this.main.length + input.length);
    next.set(this.main);
    next.set(input, this.main.length);
    this.main = next;
  }
  async dispatch(input: AsbTag, recordHistory = true): Promise<boolean> {
    if (!['ruby', '/ruby'].includes(input.name)) return false;
    if (this.closed) throw Error('Artemis ruby closed');
    if (this.pending) throw Error('Overlapping Artemis ruby operations');
    const tag = {...input, args: new Map(input.args)},
      layer = this.host.currentMessageLayer();
    if (tag.name === 'ruby') {
      if (this.enabled) this.host.reportRubyError(tag, 'nested', Uint8Array.from(this.main));
      else {
        // d1010 reads the annotation from `text`, creating the key when absent.
        if (!tag.args.has('text')) tag.args.set('text', '');
        const annotation = bytes(tag.args.get('text')!);
        if (annotation.byteLength > 1024 * 1024) throw Error('Artemis ruby byte budget exceeded');
        this.enabled = true;
        this.main = new Uint8Array();
        this.annotation = annotation;
      }
      if (recordHistory) this.host.recordTextCommand(layer, tag);
      return true;
    }
    if (!this.enabled) {
      this.host.reportRubyError(tag, 'inactive', new Uint8Array());
      return true;
    }
    this.pending = true;
    const generation = this.generation;
    try {
      const result = await this.host.insertRuby(
        layer,
        Uint8Array.from(this.main),
        Uint8Array.from(this.annotation),
      );
      if (this.closed || generation !== this.generation) throw Error('Artemis ruby cancelled');
      if (!Number.isInteger(result) || result < -0x80000000 || result > 0x7fffffff)
        throw Error('Invalid Artemis ruby result');
      if (result === -1) {
        this.host.reportRubyError(tag, 'unprintable', Uint8Array.from(this.main));
        this.enabled = false;
        return true;
      }
      if (result === -2) {
        this.host.reportRubyError(tag, 'overflow', Uint8Array.from(this.main));
        this.host.writeOverflowed(1);
        if (this.host.fontOverflowPolicy(layer) === 0) {
          this.host.enqueue({kind: 'tag', name: '@', sourceLine: 0, args: new Map()});
          this.host.enqueue({kind: 'tag', name: 'rp', sourceLine: 0, args: new Map()});
          this.host.enqueue({...tag, args: new Map(tag.args)});
          // Native returns before disabling ruby or recording this command.
          return true;
        }
      }
      this.enabled = false;
      if (recordHistory) this.host.recordTextCommand(layer, tag);
      return true;
    } finally {
      if (generation === this.generation) this.pending = false;
    }
  }
}
