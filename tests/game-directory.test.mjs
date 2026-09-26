import assert from 'node:assert/strict';
import test from 'node:test';

import {gameDirectoryFiles} from '../dist/game-directory.js';

const file = (webkitRelativePath) => ({
  name: webkitRelativePath.split('/').at(-1),
  webkitRelativePath,
});

test('game directory selection finds root executable and direct Data archives', () => {
  const selected = gameDirectoryFiles([
    file('CHAOS HEAD NOAH/readme.txt'),
    file('CHAOS HEAD NOAH/Data/script.cpk'),
    file('CHAOS HEAD NOAH/Data/._script.cpk'),
    file('CHAOS HEAD NOAH/._Game.exe'),
    file('CHAOS HEAD NOAH/Game.exe'),
    file('CHAOS HEAD NOAH/Data/mes00.CPK'),
    file('CHAOS HEAD NOAH/Data/cache/ignored.cpk'),
  ]);

  assert.equal(selected.executable.name, 'Game.exe');
  assert.deepEqual(
    selected.archives.map(({name}) => name),
    ['mes00.CPK', 'script.cpk'],
  );
});

test('game directory selection requires the installation layout', () => {
  assert.throws(() => gameDirectoryFiles([file('Data/script.cpk')]), /Game\.exe and Data\/\*\.cpk/);
  assert.throws(
    () => gameDirectoryFiles([file('Game/Game.exe'), file('Other/Data/script.cpk')]),
    /single game folder/,
  );
});
