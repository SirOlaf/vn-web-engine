import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('selected CD host shares the native slots, main FIFO and graph close owner', async () => {
  let opens = 0;
  let releases = 0;
  const host = {
    open() {
      opens++;
      return {
        medium: {
          context: {currentTime: 0},
          destination: {},
          tracks: [{frames: 75, pcm: null}],
        },
        release() {
          releases++;
        },
      };
    },
  };
  const fixture = await createMountedVmFixture({cdMediaHost: host});
  const {graph, definitions, child, memory, invoke} = fixture;
  try {
    assert.equal(graph.cdMediaHost, host);
    assert.equal(graph.receiver.cdAudio, graph.cdAudio);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0xa0 && [0x80, 0x81, 0x84, 0x85, 0x86].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x80, 0x81, 0x84, 0x85, 0x86],
    );

    await invoke(0xa0, 0x80, [], 0);
    assert.equal(opens, 1);
    await invoke(0xa0, 0x86, [0x100], 0);
    assert.equal(pop32(child.state), 1);
    assert.equal(new DataView(memory.globalMemory.buffer).getUint32(0x100, true), 3);

    graph.messages.postCdSuccessfulNotification(17);
    const dispatched = await graph.queuedDispatcher.dispatchNext();
    assert.equal(dispatched?.event.kind, 'window');
    assert.equal(dispatched.event.message.message, 0x3b9);
    assert.equal(dispatched.result, 0);
    assert.equal(opens, 1, 'a notification without active playback cannot restart the medium');

    await invoke(0xa0, 0x81, [], 0);
    assert.equal(releases, 1);
    await invoke(0xa0, 0x80, [], 0);
    assert.equal(opens, 2);
  } finally {
    await fixture.close();
  }
  assert.equal(releases, 2, 'graph close releases an open CD lease');
});
