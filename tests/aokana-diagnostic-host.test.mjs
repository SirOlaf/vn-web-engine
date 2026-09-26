import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {
  BurikoEngineDialogs,
  BurikoNativeCursor,
} from '../dist/engines/buriko/native/engine-dialogs.js';
import {formatBurikoMemoryDump} from '../dist/engines/buriko/native/memory-dump.js';
import {createDiagnosticHostOpcodes} from '../dist/engines/buriko/bp/opcodes/diagnostic-host.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {BurikoBpThread, push32, pop32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
const encode = (s) => new TextEncoder().encode(s);

test('engine modal freezes title clock, updates native cursor, and restores input/device in native order', async () => {
  let tick = 100;
  const events = [],
    text = new BurikoNativeText(),
    clock = new BurikoNativeClock(() => tick);
  const display = new BurikoNativeDisplayState(1920, 1080),
    input = new BurikoNativeInput(display, clock);
  display.fullscreen = 1;
  display.displayFlag = 0;
  clock.suspensionEnabled = true;
  const element = {style: {cursor: ''}},
    cursor = new BurikoNativeCursor(element);
  cursor.setVisible(0);
  const clear = input.clearTransientKeys.bind(input);
  input.clearTransientKeys = () => {
    events.push('input');
    clear();
  };
  const dialogs = new BurikoEngineDialogs(
    {
      async show(message) {
        events.push('show');
        assert.equal(element.style.cursor, '');
        tick = 200;
        assert.equal(clock.read(), 100n);
        assert.equal(message.text, 'a\nb');
        assert.equal(message.defaultSecondButton, true);
        return 7;
      },
    },
    text,
    clock,
    input,
    cursor,
    {
      isPresent: () => true,
      refresh() {
        events.push('refresh');
      },
    },
    display,
    null,
    encode('fallback'),
  );
  assert.equal(await dialogs.show(encode('a\\nb'), null, 0x124), 7);
  assert.equal(element.style.cursor, 'none');
  assert.equal(clock.read(), 100n);
  assert.deepEqual(events, ['refresh', 'show', 'input', 'refresh']);
});

test('memory dump copies characters across row edges, then starts the next row with carry padding', () => {
  const data = new Uint8Array(32);
  data.fill(65, 0, 15);
  data.set([0x82, 0xa0], 15);
  const dump = formatBurikoMemoryDump({bytes: data, offset: 0}, 17, {
    bytes: encode('label\0'),
    offset: 0,
  });
  const expected = new Uint8Array([
    ...encode('label\n\n\n0x0000 : ' + '41 '.repeat(15) + '82  ' + 'A'.repeat(15)),
    0x82,
    0xa0,
    ...encode('\n0x0010 : A0   \0'),
  ]);
  assert.deepEqual(dump, expected);
  assert.throws(
    () => formatBurikoMemoryDump({bytes: Uint8Array.of(0x82), offset: 0}, 1, null),
    /outside/,
  );
});

test('host78/79/7A retain button defaults and scheduler results;7E decodes clipboard using title text', async () => {
  const text = new BurikoNativeText(),
    messages = [],
    copied = [];
  const dialogs = {
    async show(message, title, flags) {
      messages.push({message, title, flags});
      return messages.length === 1 ? 6 : 2;
    },
  };
  const opcodes = createDiagnosticHostOpcodes(
    text,
    dialogs,
    {
      threadFatal() {
        throw Error('Unexpected fatal');
      },
    },
    {
      clipboard: {
        async writeText(value) {
          copied.push(value);
        },
      },
    },
  );
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 32,
    frameCapacity: 32,
  });
  const memory = new BurikoBpMemory(new Uint8Array(64)),
    diagnostics = new BurikoBpDiagnostics(() => {});
  memory.globalMemory.set(text.encodeWide('あ', 0), 4);
  const context = {thread, memory, diagnostics};
  push32(thread, 4);
  push32(thread, 0);
  assert.equal(await opcodes[0x78](context), 0);
  assert.equal(pop32(thread), 1);
  assert.equal(messages[0].flags, 0x1124);
  push32(thread, 0);
  assert.equal(await opcodes[0x79](context), 6);
  assert.match(
    new TextDecoder().decode(messages[1].message),
    /<Null Pointer \( Address : \$00000000 \)>/,
  );
  push32(thread, 0xffffffff);
  assert.equal(await opcodes[0x7a](context), 6);
  assert.match(new TextDecoder().decode(messages[2].message), /Number : -1 \( \$ffffffff \)/);
  push32(thread, 4);
  assert.equal(await opcodes[0x7e](context), 0);
  assert.equal(pop32(thread), 1);
  assert.deepEqual(copied, ['あ']);
});
