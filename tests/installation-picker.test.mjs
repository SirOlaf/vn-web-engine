import assert from 'node:assert/strict';
import test from 'node:test';
import {BlobSource} from '../dist/core/source.js';
import {subscribeSourceActivity} from '../dist/core/source-activity.js';
import {
  selectedInstallationFiles,
  pickInstallationDirectory,
  pickInstallationFiles,
  InstallationSelectionFiles,
} from '../dist/platform/installation-picker.js';

test('folder handles and input selection preserve File identity, nested paths and bounded reads', async () => {
  const file = new File([Uint8Array.of(1, 2, 3, 4)], 'archive.bin');
  Object.defineProperty(file, 'webkitRelativePath', {value: 'Game/Data/archive.bin'});
  const exe = new File(['executable'], 'Aokana.exe');
  Object.defineProperty(exe, 'webkitRelativePath', {value: 'Game/Aokana.exe'});
  const metadata = ['._Aokana.exe', '.DS_Store'].map((name) => {
    const file = new File(['metadata'], name);
    Object.defineProperty(file, 'webkitRelativePath', {value: `Game/${name}`});
    return file;
  });
  const nestedMetadata = new File(['metadata'], '._archive.bin');
  Object.defineProperty(nestedMetadata, 'webkitRelativePath', {value: 'Game/Data/._archive.bin'});
  const input = selectedInstallationFiles([...metadata, nestedMetadata, file, exe], true);
  const directory = (name, children) => ({
    kind: 'directory',
    name,
    async *values() {
      yield* children;
    },
  });
  const root = directory('Game', [
    directory('Data', [
      {kind: 'file', name: nestedMetadata.name, getFile: async () => assert.fail('Metadata read')},
      {kind: 'file', name: file.name, getFile: async () => file},
    ]),
    ...metadata.map((file) => ({
      kind: 'file',
      name: file.name,
      getFile: async () => assert.fail('Metadata read'),
    })),
    {kind: 'file', name: exe.name, getFile: async () => exe},
  ]);
  const handles = await pickInstallationDirectory({
    showDirectoryPicker: (options) => {
      assert.deepEqual(options, {mode: 'read'});
      return Promise.resolve(root);
    },
  });
  for (const selection of [input, handles]) {
    assert.deepEqual(
      selection.files.map(({path}) => path),
      ['/Data/archive.bin', '/Aokana.exe'],
    );
    assert.equal(selection.files[0].file, file);
    assert.equal(selection.files[0].path, '/Data/archive.bin');
    const activity = [];
    const unsubscribe = subscribeSourceActivity((value) => activity.push(value));
    try {
      const reading = new BlobSource(selection.files[0].file).read(1, 2);
      assert.equal(activity.at(-1).pendingLocal, 1);
      assert.equal(typeof activity.at(-1).oldestStartedAt, 'number');
      assert.deepEqual([...(await reading)], [2, 3]);
      assert.equal(activity.at(-1).pendingLocal, 0);
      assert.equal(activity.at(-1).oldestStartedAt, null);
      assert.equal(activity.at(-1).readBytes - activity[0].readBytes, 2);
    } finally {
      unsubscribe();
    }
  }
  assert.equal(selectedInstallationFiles([file], false).files[0].path, '/archive.bin');
  assert.deepEqual(
    selectedInstallationFiles([...metadata, exe], false).files.map(({file}) => file),
    [exe],
  );
  const picked = await pickInstallationFiles({
    showOpenFilePicker: async (options) => {
      assert.deepEqual(options, {multiple: true, excludeAcceptAllOption: false});
      return [{getFile: async () => file}];
    },
  });
  assert.equal(picked.files[0].file, file);
  assert.throws(() => selectedInstallationFiles([file, file], true), /Duplicate/);
  const other = new File([], 'other.bin');
  Object.defineProperty(other, 'webkitRelativePath', {value: 'Other/other.bin'});
  assert.throws(() => selectedInstallationFiles([file, other], true), /one installation/);
});

test('mobile single-file additions retain the folder and replace names using the engine casing policy', () => {
  const selected = new InstallationSelectionFiles((path) => path.toLowerCase());
  const archive = new File(['archive'], 'system.arc'),
    exe = new File(['exe'], 'Aokana.exe');
  selected.add({directory: true, files: [{path: '/system.arc', file: archive}]});
  const completed = selected.add(selectedInstallationFiles([exe], false));
  assert.deepEqual(
    completed.files.map(({path}) => path),
    ['/system.arc', '/Aokana.exe'],
  );
  const replacement = new File(['new'], 'aokana.EXE');
  const replaced = selected.add(selectedInstallationFiles([replacement], false));
  assert.equal(replaced.files.length, 2);
  assert.equal(replaced.files[1].file, replacement);
  assert.equal(selected.add({directory: true, files: []}).files.length, 0);
  selected.add(selectedInstallationFiles([archive], false));
  selected.clear();
  assert.deepEqual(
    selected.add(selectedInstallationFiles([exe], false)).files.map(({path}) => path),
    ['/Aokana.exe'],
  );
});
