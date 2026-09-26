import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BurikoNamedValueMap,
  burikoNamedValueHash,
  burikoCompareNamedBytes,
} from '../dist/engines/buriko/native/named-value-map.js';
import {BurikoLocalizedMessages} from '../dist/engines/buriko/native/localized-messages.js';
import {BurikoNativeLanguage} from '../dist/engines/buriko/native/group-81-language.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoImportedTextMaps} from '../dist/engines/buriko/native/imported-text-maps.js';

const pointer = (value) => ({bytes: new TextEncoder().encode(value + '\0'), offset: 0});
const output = (width) => ({bytes: new Uint8Array(width), offset: 0});
const decode = (value) =>
  new TextDecoder().decode(value.bytes.subarray(value.offset)).replace(/\0$/, '');

test('shared named map preserves copied keys, insertion order and fixed-width value updates', () => {
  const map = new BurikoNamedValueMap(4),
    first = pointer('First'),
    second = pointer('Second');
  map.insert(first, {bytes: Uint8Array.of(1, 2, 3, 4), offset: 0});
  map.insert(second, {bytes: Uint8Array.of(5, 6, 7, 8), offset: 0});
  first.bytes[0] = 88;
  const retained = map.findValue(pointer('First'));
  map.insert(pointer('First'), {bytes: Uint8Array.of(8, 7, 6, 5), offset: 0});
  assert.equal(map.findValue(pointer('First')), retained);
  const result = output(4);
  assert.equal(map.readByIndex(result, 0), 0);
  assert.deepEqual([...result.bytes], [8, 7, 6, 5]);
  assert.equal(map.readByName(result, second), 0);
  assert.deepEqual([...result.bytes], [5, 6, 7, 8]);
  assert.equal(map.readByIndex(null, 1), 0);
  assert.equal(burikoNamedValueHash({bytes: Uint8Array.of(0x80, 65, 0), offset: 0}), 0xffff8bc1);
  assert.equal(burikoCompareNamedBytes({bytes: Uint8Array.of(255, 0), offset: 0}, pointer('a')), 1);
});

test('string-width named maps retain complete terminated strings through ordinary updates and removal', () => {
  const map = new BurikoNamedValueMap(0);
  map.insert(pointer('a'), pointer('one'));
  map.insert(pointer('b'), pointer('two'));
  map.insert(pointer('a'), pointer('expanded'));
  assert.deepEqual([...map.valuePointers()].map(decode), ['expanded', 'two']);
  assert.equal(map.remove(pointer('a')), 0);
  const result = output(4);
  assert.equal(map.readByIndex(result, 0), 0);
  assert.equal(decode(result), 'two');
  map.clear();
  assert.deepEqual([...map.valuePointers()], []);
});

test('localized sections parse comments and language lists with newest matching section precedence', () => {
  const events = [],
    language = new BurikoNativeLanguage(() => {
      events.push('language');
      return 0x409;
    }),
    text = new BurikoNativeText();
  const imported = new BurikoImportedTextMaps(text),
    clear = imported.clear.bind(imported);
  imported.clear = () => {
    events.push('clear-imported');
    clear();
  };
  const messages = new BurikoLocalizedMessages(text, language, imported);
  const stored = new TextEncoder().encode(
    [
      '// ordinary synthetic system strings',
      'KEY = base',
      'FALLBACK = common',
      '@LanguageId = 411, 409',
      'KEY = paired',
      '@languageid = 411',
      'KEY = Japanese',
      '@other = ignored',
      '',
    ].join('\r\n'),
  );
  assert.equal(
    messages.loadPeResources([{type: 'TEXT', id: 131, language: 0, codePage: 0, bytes: stored}]),
    1,
  );
  assert.deepEqual(events, ['clear-imported', 'language']);
  assert.equal(decode(messages.lookup(pointer('KEY'))), 'paired');
  assert.equal(decode(messages.lookup(pointer('FALLBACK'))), 'common');
  language.select(0x411);
  assert.equal(decode(messages.lookup(pointer('KEY'))), 'Japanese');
  language.select(0x407);
  assert.equal(decode(messages.lookup(pointer('KEY'))), 'base');
});

test('an empty language section reuses its map and recognizes multibyte value boundaries', () => {
  const language = new BurikoNativeLanguage(() => 0x411),
    text = new BurikoNativeText(),
    messages = new BurikoLocalizedMessages(text, language, new BurikoImportedTextMaps(text));
  assert.equal(
    messages.load(new TextEncoder().encode('@languageid=411\n@languageid=0\nTEXT=青空\n')),
    1,
  );
  assert.equal(decode(messages.lookup(pointer('TEXT'))), '青空');
  language.select(0x409);
  // Native @languageid=0 does not clear IDs already attached to an empty section.
  assert.equal(messages.lookup(pointer('TEXT')), null);
});

test('eight-byte internal maps keep actual inner-map references in their shared value slots', () => {
  const outer = new BurikoNamedValueMap(8),
    first = new BurikoNamedValueMap(0),
    second = new BurikoNamedValueMap(0);
  first.insert(pointer('text'), pointer('first'));
  second.insert(pointer('text'), pointer('second'));
  outer.insertReference(pointer('group'), first);
  const value = outer.findValue(pointer('group'));
  assert.equal(outer.referenceFromValuePointer(value), first);
  outer.insertReference(pointer('group'), second);
  assert.equal(outer.findValue(pointer('group')), value);
  assert.equal(outer.findReference(pointer('group')), second);
  assert.equal(outer.readByIndex(null, 0), 0);
  assert.deepEqual(
    [...outer.valuePointers()].map((pointer) => outer.referenceFromValuePointer(pointer)),
    [second],
  );
});
