import assert from 'node:assert/strict';
import {test} from 'node:test';
import {BurikoBrowserSpeakerBuffer} from '../dist/engines/buriko/native/audio/browser-speaker-backend.js';
import {BurikoBrowserMoviePcmOutput} from '../dist/engines/buriko/native/movie-pcm-output.js';
import {burikoIsoTime} from '../dist/engines/buriko/native/movie-iso-timeline.js';
import {subscribeRuntimeAdvisories} from '../dist/platform/runtime-advisories.js';

test('worklet and LAN HTTP audio hosts preserve PCM, render-owned cursors, notifications, and movie completion', async () => {
  const names = ['AudioWorkletProcessor', 'AudioWorkletNode', 'registerProcessor', 'sampleRate'];
  const previous = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const processors = new Map();
  const ports = [];
  class WorkletProcessor {
    constructor() {
      const channel = new MessageChannel();
      ports.push(channel.port1, channel.port2);
      this.port = channel.port1;
      this.hostPort = channel.port2;
    }
  }
  class WorkletNode {
    constructor(context, name, options) {
      this.processor = new (processors.get(name))(options);
      this.port = this.processor.hostPort;
      this.channels = options.outputChannelCount[0];
      context.nodes.push(this);
    }
    connect() {}
    disconnect() {}
    render(frames) {
      const output = Array.from({length: this.channels}, () => new Float32Array(frames));
      this.processor.process([], [output]);
      return output.map((plane) => [...plane]);
    }
  }
  Object.assign(globalThis, {
    AudioWorkletProcessor: WorkletProcessor,
    AudioWorkletNode: WorkletNode,
    registerProcessor: (name, processor) => processors.set(name, processor),
    sampleRate: 48000,
  });
  const f = burikoIsoTime.fraction;
  const snapshots = [];
  const advisories = [];
  const unsubscribe = subscribeRuntimeAdvisories((advisory) => advisories.push(advisory));
  try {
    for (const worklet of [true, false]) {
      const context = {
        nodes: [],
        sampleRate: 48000,
        audioWorklet: worklet ? {addModule: (url) => import(url.href)} : undefined,
        createScriptProcessor(_size, inputs, channels) {
          assert.equal(inputs, 0);
          const node = {
            connect() {},
            disconnect() {},
            render(frames) {
              const output = Array.from({length: channels}, () => new Float32Array(frames));
              this.onaudioprocess?.({
                outputBuffer: {
                  numberOfChannels: channels,
                  getChannelData: (channel) => output[channel],
                },
              });
              return output.map((plane) => [...plane]);
            },
          };
          this.nodes.push(node);
          return node;
        },
      };
      context.destination = {context};
      const buffer = await BurikoBrowserSpeakerBuffer.create(context, {
        sampleRate: 48000,
        channels: 1,
        bits: 16,
        byteLength: 4,
      });
      const notifications = [];
      buffer.onNotification((event) => notifications.push(event));
      try {
        await buffer.command({
          kind: 'write',
          offset: 0,
          bytes: Uint8Array.of(0, 64, 0, 192),
          initialized: new Uint8Array(4).fill(1),
        });
        await buffer.command({kind: 'notifications', offsets: [0, 0xffffffff]});
        await assert.rejects(buffer.command({kind: 'seek', byteOffset: 4}), /exceeds buffer/);
        await buffer.command({kind: 'play', loop: false});
        assert.equal((await buffer.command({kind: 'status'})).renderFrame, 0);
        assert.equal((await buffer.command({kind: 'status'})).byteCursor, 0);
        const pcm = context.nodes[0].render(4);
        const status = await buffer.command({kind: 'status'});
        assert.deepEqual(pcm, [
          [0.5, -0.5, 0, 0],
          [0.5, -0.5, 0, 0],
        ]);
        assert.deepEqual(status, {playing: false, byteCursor: 0, renderFrame: 4});
        snapshots.push({pcm, status, notifications});
      } finally {
        await buffer.dispose();
      }

      const movie = await BurikoBrowserMoviePcmOutput.create(context, {
        channels: 1,
        capacityFrames: 8,
      });
      const completions = [];
      movie.onComplete((status) => completions.push(status));
      const command = (value) => movie.command({generation: 0, ...value});
      try {
        await command({
          kind: 'enqueue',
          span: {
            planes: [Float32Array.of(0.25, 0.75)],
            sampleRate: 48000,
            frameCount: 2,
            firstFrame: 0,
            endFrame: 2,
            editIndex: 0,
            start: f(0n),
            end: f(2n, 48000n),
          },
        });
        await command({kind: 'end', position: f(2n, 48000n)});
        await command({kind: 'run'});
        assert.equal((await command({kind: 'status'})).consumedFrames, 0n);
        const pcm = context.nodes[1].render(4);
        const status = await command({kind: 'status'});
        assert.deepEqual(pcm, [
          [0.25, 0.75, 0, 0],
          [0.25, 0.75, 0, 0],
        ]);
        assert.equal(status.ended, true);
        assert.equal(status.consumedFrames, 2n);
        assert.equal(completions.length, 1);
        snapshots.push({pcm, status, completions});
      } finally {
        await movie.dispose(0);
      }
    }
    assert.deepEqual(snapshots[0], snapshots[2]);
    assert.deepEqual(snapshots[1], snapshots[3]);
    assert.deepEqual(
      advisories.map(({id}) => id),
      ['audio-fallback'],
    );
    assert.match(advisories[0].message, /ScriptProcessor/);
  } finally {
    unsubscribe();
    for (const port of ports) port.close();
    names.forEach((name, index) => {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]);
      else delete globalThis[name];
    });
  }
});
