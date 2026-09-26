import type {ByteSource} from '../core/source.js';
import {HcaStream} from '../formats/cri/hca/stream.js';
import {BrowserAudioContextHost} from './browser-audio-context-host.js';
/** One replaceable UI-sound voice. Reuses the from-scratch HCA decoder. */
export class SoundPlayer {
  private readonly context = new AudioContext();
  private readonly contextHost = new BrowserAudioContextHost(this.context, document);
  private gain = this.context.createGain();
  private node: AudioBufferSourceNode | undefined;
  private generation = 0;
  private readonly buffers = new Map<number, Promise<AudioBuffer>>();
  constructor(
    readonly source: (id: number) => Promise<ByteSource>,
    readonly error: (error: unknown) => void,
  ) {
    this.gain.connect(this.context.destination);
  }
  unlock(): void {
    void this.contextHost.resume().catch(this.error);
  }
  play(id: number, volume: number): void {
    const generation = ++this.generation;
    this.node?.stop();
    this.node?.disconnect();
    this.node = undefined;
    let buffer = this.buffers.get(id);
    if (!buffer) {
      buffer = this.source(id)
        .then((source) => HcaStream.open(source))
        .then((stream) => stream.decode())
        .then((clip) => {
          const b = this.context.createBuffer(
            clip.channels.length,
            clip.sampleCount,
            clip.sampleRate,
          );
          clip.channels.forEach((c, i) => b.copyToChannel(c as Float32Array<ArrayBuffer>, i));
          return b;
        });
      this.buffers.set(id, buffer);
    }
    void buffer
      .then(async (b) => {
        await this.contextHost.resume();
        if (generation !== this.generation) return;
        const node = this.context.createBufferSource();
        node.buffer = b;
        this.gain.gain.value = Math.min(1, Math.max(0, volume / 128));
        node.connect(this.gain);
        node.onended = () => {
          node.disconnect();
          if (this.node === node) this.node = undefined;
        };
        this.node = node;
        node.start();
      })
      .catch((e) => {
        this.buffers.delete(id);
        this.error(e);
      });
  }
  dispose(): void {
    this.generation++;
    this.contextHost.dispose();
    this.node?.stop();
    this.node?.disconnect();
    void this.context.close();
  }
}
