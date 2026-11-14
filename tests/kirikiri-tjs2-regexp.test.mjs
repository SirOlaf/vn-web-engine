import assert from 'node:assert/strict';
import test from 'node:test';
import {corePreprocessorValues} from '../dist/engines/kirikiri/tjs2/compiler.js';
import {TjsEngine} from '../dist/engines/kirikiri/tjs2/runtime/engine.js';
import {NativeFunction} from '../dist/engines/kirikiri/tjs2/runtime/native.js';
import {OnigRegex} from '../dist/engines/kirikiri/tjs2/runtime/oniguruma.js';
import {VariantSlot} from '../dist/engines/kirikiri/tjs2/runtime/slot.js';
import * as V from '../dist/engines/kirikiri/tjs2/runtime/variant.js';
import {TjsVm} from '../dist/engines/kirikiri/tjs2/vm/executor.js';

const search = (pattern, subject, ignoreCase = false) =>
  new OnigRegex(pattern, ignoreCase).search(subject);

test('Oniguruma Perl syntax: anchors, dot, classes, escapes', () => {
  assert.deepEqual(search('^b', 'a\nb'), null, '^ is \\A');
  assert.deepEqual(search('(?m)^b', 'a\nb'), [2, 3]);
  assert.deepEqual(search('a$', 'a\n'), [0, 1], '$ is \\Z');
  assert.deepEqual(search('a\\z', 'a\n'), null);
  assert.deepEqual(search('.', '\r'), [0, 1], '. excludes only \\n');
  assert.deepEqual(search('.', '\n'), null);
  assert.deepEqual(search('(?s).', '\n'), [0, 1]);
  assert.deepEqual(search('\\d+', '１２3'), [0, 3], '\\d is Unicode Nd');
  assert.deepEqual(search('\\s', '﻿　'), [1, 2], '\\s is White_Space');
  // \xHH takes two digits: [\x0100-\xFFFF] is \x01, 0, 0-\xFF, F, F.
  assert.deepEqual(search('@([a-z_\\x0100-\\xFFFF]*)', '@ab漢'), [0, 3, 1, 3]);
  assert.deepEqual(search('\\x{3042}\\0101\\cA', 'あ\b1\x01'), [0, 4]);
  assert.deepEqual(search('[[:alpha:][:digit:]]+', '-a1-'), [1, 3]);
  assert.deepEqual(search('[^\\W_]+', '__ab'), [2, 4]);
  assert.deepEqual(search('\\p{Hiragana}+', 'aあい'), [1, 3]);
  assert.deepEqual(search('\\Qa.b\\E', 'axb a.b'), [4, 7]);
  assert.deepEqual(search('a{,2}', 'a{,2}'), [0, 5], 'an invalid interval is literal');
  assert.deepEqual(search('[]a]', ']'), [0, 1]);
});

test('Oniguruma: groups, atomic and possessive, options, empty matches', () => {
  assert.deepEqual(search('(a)|(b)', 'b'), [0, 1, -1, -1, 0, 1]);
  assert.deepEqual(search('(a)\\1', 'xaa'), [1, 3, 1, 2]);
  assert.deepEqual(search('(?>a+)a', 'aaa'), null);
  assert.deepEqual(search('a++b', 'aaab'), [0, 4]);
  assert.deepEqual(search('(a*+)(b)', 'aab'), [0, 3, 0, 2, 2, 3]);
  assert.deepEqual(search('a(?i:b)c', 'aBC aBc'), [4, 7]);
  assert.deepEqual(search('ab', 'xAB', true), [1, 3]);
  // FIND_NOT_EMPTY: empty matches are rejected by backtracking.
  assert.deepEqual(search('x*', 'abc'), null);
  assert.deepEqual(search('a*?', 'aa'), [0, 1]);
  assert.deepEqual(search('(?:)', 'abc'), null);
  assert.throws(() => new OnigRegex('*a', false), /target of repeat operator is not specified/);
  assert.throws(() => new OnigRegex('(a', false), /end pattern with unmatched parenthesis/);
  assert.throws(() => new OnigRegex('a)', false), /unmatched close parenthesis/);
  assert.throws(() => new OnigRegex('[b-a]', false), /empty range in char class/);
  assert.throws(() => new OnigRegex('\\2(a)', false), /invalid backref/);
});

function setup() {
  const logs = [];
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
    new NativeFunction((_r, args) => (logs.push(args.map((a) => V.asString(a)).join(' ')), 0)),
  );
  return {engine, logs};
}

async function logs(text) {
  const {engine, logs} = setup();
  await engine.suspender.run(() =>
    engine.runScript(
      {text, name: 'test.tjs', lineOffset: 0, mode: 'statements'},
      new VariantSlot(),
      null,
    ),
  );
  engine.shutdown();
  return logs;
}

test('RegExp: literals, test/exec state, global search, match', async () => {
  assert.deepEqual(
    await logs(`
      var re = /(\\d+)-(\\d+)/g;
      var s = "a 12-34 b 5-6";
      log(re.test(s), re.index, re.lastIndex, re.lastMatch, re.lastParen);
      log(re.leftContext + "|" + re.rightContext, re.matches[1], re.start);
      log(RegExp.last === re);
      // The second search starts at 7: offsets count from there.
      log(re.test(s), re.index, re.lastIndex, re.matches[0]);
      log(re.test(s), re.index, re.start);
      re.start = 0;
      var m = /x(y)?/.match("zx");
      log(m.count, m[0], m[1] === "");
      log(/a/.match("b").count, (new RegExp("A", "i")).test("a"));
    `),
    [
      '1 4 7 12-34 34',
      'a | b 5-6 12 7',
      '1',
      // index = start + 2 × offset; matches[0] takes the relative offsets from the whole text.
      '1 13 13 2-3',
      '0 13 13',
      '2 x 1',
      '0 1',
    ],
  );
});

test('RegExp: replace with strings and functions, split; String routes through them', async () => {
  assert.deepEqual(
    await logs(`
      log(/a/.replace("banana", "o"), /a/g.replace("banana", "o"));
      log(/^a/g.replace("aaa", "b"), "each search restarts at the rest of the text");
      log(/(\\w)(\\d)/g.replace("a1b2", function(m) { return m[2] + m[1]; }));
      log("x,y,,z".split(/,/).join("|"), "x,y,,z".split(/,/, , true).join("|"));
      log("a1b22c".replace(/\\d+/g, "#"), "aXbxc".split(new RegExp("x", "i")).count);
      var a = [];
      a.split(/-/, "1-2-3");
      log(a.count, a[2]);
    `),
    [
      'bonana bonono',
      'bbb each search restarts at the rest of the text',
      '1a2b',
      'x|y||z x|y|z',
      'a#b#c 3',
      '3 3',
    ],
  );
});
