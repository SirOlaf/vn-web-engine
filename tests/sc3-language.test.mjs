import test from 'node:test';
import assert from 'node:assert/strict';
import {Sc3Runtime} from '../dist/engines/mages/games/chaos-head-noah/sc3/runtime.js';
import {
  languageCode,
  languageSetting,
} from '../dist/engines/mages/games/chaos-head-noah/sc3/opcodes/language.js';
import {NOAH_PATHS} from '../dist/engines/mages/games/chaos-head-noah/paths.js';
import {literal, mesBytes, platform, scriptBytes} from './sc3-fixtures.mjs';

function assets(code, selections) {
  const script = scriptBytes(code),
    messages = mesBytes();
  return {
    size: (bank) => (bank === 'script' ? script.length : messages.length),
    script: async () => script,
    messages: async () => messages,
    selectLanguage: (value) => selections.push(value),
  };
}

test('native platform/config language mapping covers all four startup branches', () => {
  assert.deepEqual([0, 1, 10, 11, 99].map(languageSetting), [0, 1, 3, 2, 0]);
  assert.deepEqual([0, 1, 2, 3, 99].map(languageCode), [0, 1, 11, 10, 0]);
});

test('00/5e persists config before switching all archive selectors', async () => {
  const selections = [],
    p = platform(),
    code = [0, 0x5e, ...literal(-42), 0, 3],
    vm = new Sc3Runtime(p, assets(code, selections), {
      language: 0,
      configEnabled: false,
      random15: () => 0,
    });
  await vm.boot();
  assert.deepEqual(selections, [0]);
  vm.storage.configuration.fill(0xa5);
  vm.context(0).setInt32(0x1c, 0x12345678, true);
  assert.equal(vm.runFrame(), 'blocked');
  assert.equal(vm.pc(0), 25);
  assert.equal(vm.context(0).getInt32(0x1c, true), 0x12345678);
  assert.equal(vm.state.get(0x1badfbc), 1);
  assert.equal(vm.state.get(0x17ac318), 1);
  assert.equal(vm.state.variable(0x34b8 / 4), 1);
  assert.equal(new DataView(vm.storage.configuration.buffer).getUint32(0x48, true), 1);
  assert.equal(vm.language, 0);
  assert.deepEqual(selections, [0]);
  await vm.waitHost();
  assert.equal(vm.runFrame(), 'complete');
  assert.equal(vm.language, 1);
  assert.deepEqual(selections, [0, 1]);
  assert.deepEqual(
    vm.storage.events.map((event) => [event.operation, event.path, event.status]),
    [
      ['write', NOAH_PATHS.config, 0],
      ['write', NOAH_PATHS.padConfig, 0],
    ],
  );
  const saved = await p.windowsFiles.open(NOAH_PATHS.config);
  assert.equal(new DataView((await saved.read(0, saved.size)).buffer).getUint32(0x48, true), 1);

  const restored = [],
    next = new Sc3Runtime(p, assets([0, 3], restored), {configEnabled: false, random15: () => 0});
  await next.boot();
  assert.equal(next.language, 1);
  assert.equal(next.state.get(0x1badfbc), 1);
  assert.equal(next.state.get(0x17ac318), 1);
  assert.deepEqual(restored, [1]);
});

test('00/5e zero branch writes Japanese state and leaves context result untouched', async () => {
  const selections = [],
    vm = new Sc3Runtime(platform(), assets([0, 0x5e, ...literal(0), 0, 3], selections), {
      language: 1,
      configEnabled: false,
      random15: () => 0,
    });
  await vm.boot();
  vm.context(0).setInt32(0x1c, -123, true);
  assert.equal(vm.runFrame(), 'blocked');
  assert.equal(vm.context(0).getInt32(0x1c, true), -123);
  assert.equal(vm.state.get(0x1badfbc), 0);
  assert.equal(vm.state.get(0x17ac318), 0);
  assert.equal(vm.state.variable(0x34b8 / 4), 0);
  await vm.waitHost();
  assert.equal(vm.runFrame(), 'complete');
  assert.equal(vm.language, 0);
  assert.deepEqual(selections, [1, 0]);
});
