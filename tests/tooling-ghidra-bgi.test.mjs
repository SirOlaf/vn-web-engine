/** The BGI Ghidra processor module's generated SLEIGH and native tables. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {collectNatives, generatedFiles} from '../tools/ghidra-bgi/generate-sleigh.mjs';

const tables = collectNatives();

test('every SLEIGH include is a language source or a generated file', () => {
  const generated = generatedFiles(tables);
  const languages = new URL('../tools/ghidra-bgi/languages/', import.meta.url);
  const sources = new Set(readdirSync(languages));
  for (const spec of [...sources].filter((name) => name.endsWith('.slaspec'))) {
    const pending = [spec];
    while (pending.length) {
      const name = pending.pop();
      const text = generated.get(name) ?? readFileSync(new URL(name, languages), 'utf8');
      for (const [, include] of text.matchAll(/@include "([^"]+)"/g)) {
        assert.ok(sources.has(include) || generated.has(include), `${name} includes ${include}`);
        pending.push(include);
      }
    }
  }
  assert.ok(generated.has('bgi.cspec'));
});

test('native stack effects and pointer arguments follow the handlers', () => {
  const slot = (revision, name) => tables[revision].natives.find((n) => n.name === name);
  const thread = slot('1685', 'StartProgramThread');
  assert.equal(thread.pops, 5);
  assert.equal(thread.pushes, 1);
  // Push order: archive and resource names, then the operand/module/frame capacities.
  assert.deepEqual(thread.params, ['ptr', 'ptr', 'int', 'int', 'int']);
  assert.deepEqual(slot('1685', 'LoadModule').params, ['ptr', 'ptr']);
  assert.equal(slot('1685', 'PointerPosition').pops, 0);
  assert.equal(slot('1685', 'PointerPosition').pushes, 2);
  // A handler that pops inside a loop has a data-dependent effect.
  assert.equal(slot('1685', 'AppendBacklog').pops, null);
});

test('every revision lists its installed primaries and native banks', () => {
  for (const {primaries, natives} of Object.values(tables)) {
    for (const {primary} of natives) assert.ok(primaries.includes(primary));
    assert.ok(primaries.includes(0x17) && primaries.includes(0xff));
  }
  assert.ok(tables['1685'].primaries.includes(0xee));
  assert.ok(!tables['1520'].primaries.includes(0xee));
});
