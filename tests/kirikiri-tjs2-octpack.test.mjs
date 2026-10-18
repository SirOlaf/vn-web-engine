import assert from 'node:assert/strict';
import test from 'node:test';
import {corePreprocessorValues} from '../dist/engines/kirikiri/tjs2/compiler.js';
import {TjsEngine} from '../dist/engines/kirikiri/tjs2/runtime/engine.js';
import {NativeFunction} from '../dist/engines/kirikiri/tjs2/runtime/native.js';
import {pack} from '../dist/engines/kirikiri/tjs2/runtime/octpack.js';
import {VariantSlot} from '../dist/engines/kirikiri/tjs2/runtime/slot.js';
import * as V from '../dist/engines/kirikiri/tjs2/runtime/variant.js';
import {TjsVm} from '../dist/engines/kirikiri/tjs2/vm/executor.js';

async function logs(text) {
  const out = [];
  const engine = new TjsEngine({
    readText: () => '',
    openTextWrite: () => ({write() {}, close() {}}),
    print: () => {},
    time: () => 0,
  });
  engine.executor = new TjsVm(engine, {
    compiler: {preprocessor: corePreprocessorValues([2, 4, 28])},
  });
  engine.registerGlobal(
    'log',
    new NativeFunction((_r, args) => (out.push(args.map((a) => V.asString(a)).join(' ')), 0)),
  );
  await engine.suspender.run(() =>
    engine.runScript(
      {text, name: 'test.tjs', lineOffset: 0, mode: 'statements'},
      new VariantSlot(),
      null,
    ),
  );
  engine.shutdown();
  return out;
}

const bytes = (template, ...items) => Array.from(pack(template, items) ?? []);

test('pack: numbers, strings, bit and hex strings, counts and *', () => {
  assert.deepEqual(
    bytes('CnvN', V.int(0x1ff), V.int(0x1234), V.int(0x1234), V.int(0x01020304)),
    [0xff, 0x12, 0x34, 0x34, 0x12, 1, 2, 3, 4],
  );
  assert.deepEqual(bytes('C*', V.int(1), V.int(2), V.int(3)), [1, 2, 3]);
  assert.deepEqual(bytes('a4A4', V.str('ab'), V.str('cd')), [97, 98, 0, 0, 99, 100, 32, 32]);
  assert.deepEqual(bytes('B8b8', V.str('10000001'), V.str('10000000')), [0x81, 0x01]);
  assert.deepEqual(bytes('H4h2', V.str('a1b2'), V.str('1c')), [0xa1, 0xb2, 0xc1]);
  assert.deepEqual(bytes('Cx2C', V.int(1), V.int(2)), [1, 0, 0, 2]);
  assert.deepEqual(bytes('f', V.real(1.5)), [0, 0, 0xc0, 0x3f]);
  assert.deepEqual(bytes('m', V.str('AQID')), [1, 2, 3]);
  assert.equal(pack('C', []), null);
  assert.throws(() => pack('H', [V.str('F')]), /Hex/, 'upper-case F is not a hex digit');
  assert.throws(() => pack('q', [V.int(1)]), /TEMPLATE/);
});

test('Array.pack and Octet.unpack round trip through scripts', async () => {
  assert.deepEqual(
    await logs(`
      var o = [258, 3, "ab"].pack("vCa2");
      log(typeof o, o.length);
      var a = o.unpack("vCa2");
      log(a.count, a[0], a[1], a[2]);
      log(<% 41 42 00 43 %>.unpack("a*")[0], <% ff 7f %>.unpack("cc").join(","));
      log(<% 01 02 03 04 05 %>.unpack("N").count, <% 01 02 %>.unpack("H4")[0]);
      log(<% 00 01 02 %>.unpack("m")[0], <% 81 %>.unpack("B8")[0]);
      log([].pack("C") === null);
    `),
    ['Octet 5', '3 258 3 ab', 'ABC -1,127', '1 0102', 'AAEC 10000001', '1'],
  );
});
