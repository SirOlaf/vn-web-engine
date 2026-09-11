import test from 'node:test';
import assert from 'node:assert/strict';
import {NoahArchives} from '../dist/engines/mages/games/chaos-head-noah/archives.js';

test('Noah localized archive selectors cover MES, system, background, manual and movie', () => {
  const names = [
    'bg.cpk',
    'bg_eng.cpk',
    'system.cpk',
    'system_eng.cpk',
    'mes00.cpk',
    'mes01.cpk',
    'manual.cpk',
    'manual_eng.cpk',
    'movie.cpk',
    'movie_eng.cpk',
    'chara.cpk',
    'script.cpk',
    'mask.cpk',
  ];
  const archives = new Map(
    names.map((name, index) => [
      name,
      {
        name,
        byId: new Map([
          [7, {size: index + 1}],
          ...(name === 'system.cpk' ? [[8, {size: 99}]] : []),
        ]),
        read: async (id) => Uint8Array.of(index, id),
      },
    ]),
  );
  const set = new NoahArchives((name) => archives.get(name));
  for (const [base, english] of [
    ['bg.cpk', 'bg_eng.cpk'],
    ['system.cpk', 'system_eng.cpk'],
    ['mes00.cpk', 'mes01.cpk'],
    ['manual.cpk', 'manual_eng.cpk'],
    ['movie.cpk', 'movie_eng.cpk'],
  ])
    assert.equal(set.resolve(base).name, base);
  set.selectLanguage(1);
  for (const [base, english] of [
    ['bg.cpk', 'bg_eng.cpk'],
    ['system.cpk', 'system_eng.cpk'],
    ['mes00.cpk', 'mes01.cpk'],
    ['manual.cpk', 'manual_eng.cpk'],
    ['movie.cpk', 'movie_eng.cpk'],
  ])
    assert.equal(set.resolve(base).name, english);
  assert.equal(set.bank(0).name, 'bg_eng.cpk');
  assert.equal(set.bank(2).name, 'system_eng.cpk');
  assert.equal(set.bank(4).name, 'mes01.cpk');
  assert.equal(set.asset(2, 7).archive.name, 'system_eng.cpk');
  assert.equal(set.asset(2, 8).archive.name, 'system.cpk');
  assert.equal(set.size(2, 8), 99);
  assert.equal(set.asset('manual.cpk', 7).archive.name, 'manual_eng.cpk');
  archives.get('movie_eng.cpk').byId.delete(7);
  assert.equal(set.asset('movie.cpk', 7).archive.name, 'movie.cpk');
  assert.equal(set.bank(1).name, 'chara.cpk');
  assert.equal(set.bank(3).name, 'script.cpk');
  assert.equal(set.bank(5).name, 'mask.cpk');
  set.selectLanguage(10);
  assert.equal(set.resolve('movie.cpk').name, 'movie_eng.cpk');
  set.selectLanguage(0);
  assert.equal(set.resolve('movie.cpk').name, 'movie.cpk');
  assert.throws(() => set.bank(6), /Unknown native archive bank/);
});
