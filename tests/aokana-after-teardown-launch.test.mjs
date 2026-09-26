import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoAfterTeardownLaunch} from '../dist/engines/buriko/native/after-teardown-launch.js';
import {BurikoExitLaunchHandoff} from '../dist/engines/buriko/native/exit-launch-handoff.js';
import {BurikoExternalProcesses} from '../dist/engines/buriko/native/external-process.js';
import {BurikoExternalMutexName} from '../dist/engines/buriko/native/external-mutex-name.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

const bytes = (value) => new TextEncoder().encode(value);

test('80:E1 launches its copied request through selected primitives after engine teardown', async () => {
  const events = [];
  const handle = (name) => ({name});
  const process = handle('shell-process'),
    sourceToken = handle('source-token');
  const primaryToken = handle('primary-token'),
    childThread = handle('child-thread');
  const childProcess = handle('child-process');
  const host = {
    isUserAdministrator: () => true,
    readShellWindowProcessId: () => 321,
    openProcess(access, inherit, pid) {
      assert.deepEqual([access, inherit, pid], [0x02000000, false, 321]);
      return process;
    },
    openProcessToken(found, access) {
      assert.equal(found, process);
      assert.equal(access, 0x02000000);
      return sourceToken;
    },
    duplicateTokenEx(found, access, attributes, level, type) {
      assert.deepEqual(
        [found, access, attributes, level, type],
        [sourceToken, 0x02000000, null, 3, 1],
      );
      return primaryToken;
    },
    createProcessWithTokenW(found, flags, request) {
      assert.equal(found, primaryToken);
      assert.equal(flags, 0);
      events.push(['token-launch', request.startup.showWindow]);
      return null;
    },
    createProcessW(request) {
      const line = String.fromCharCode(...request.commandLine.subarray(0, -1));
      assert.equal(line, '"D:\\Tools\\helper.exe" --flag');
      assert.equal(request.currentDirectory, 'D:\\Tools');
      assert.equal(request.startup.showWindow, 5);
      assert.equal(request.creationFlags, 0);
      assert.equal(request.inheritHandles, false);
      events.push(['launch', line]);
      return {process: childProcess, thread: childThread};
    },
    closeHandle(found) {
      events.push(['close', found.name]);
    },
  };
  const text = new BurikoNativeText();
  const version = new Uint8Array(32);
  const view = new DataView(version.buffer);
  view.setUint32(4, 10, true);
  view.setUint32(16, 2, true);
  const resources = {
    files: {text, media: {isAvailable: () => true}},
    configuration: {primaryRoot: bytes('C:\\game\\\0')},
    dialogs: {preferredTitle: null, fallbackTitle: bytes('Buriko\0')},
    loosePath(root, executable, separator) {
      const prefix = root.subarray(0, root.indexOf(0));
      const result = new Uint8Array(prefix.length + Number(separator) + executable.length);
      result.set(prefix);
      if (separator) result[prefix.length] = 92;
      result.set(executable, prefix.length + Number(separator));
      return result;
    },
  };
  const processes = new BurikoExternalProcesses(
    resources,
    {readVersionRecord: () => version},
    {lookup: () => bytes('unused\0')},
    host,
    {readShowState: () => 1, setShowState: () => {}, pumpMessages: () => 0},
    new BurikoExternalMutexName(),
  );
  const handoff = new BurikoExitLaunchHandoff({
    mainTarget: () => ({}),
    send(target, message, wParam, lParam) {
      events.push(['destroy', target, message, wParam, lParam]);
      return 0;
    },
  });
  assert.equal(handoff.request(bytes('D:\\Tools\0'), bytes('helper.exe --flag\0'), null), 6);
  const dialogs = {showInformation: () => assert.fail('successful launch showed failure dialog')};
  const continuation = BurikoAfterTeardownLaunch.capture(handoff, processes, dialogs);
  assert.ok(continuation);
  await processes.closeAndJoin();
  handoff.markEngineTornDown();
  assert.equal(await continuation.runAfterTeardown(), 1);
  assert.deepEqual(events, [
    ['destroy', 'main', 2, 0, 0],
    ['close', 'shell-process'],
    ['close', 'source-token'],
    ['token-launch', 5],
    ['launch', '"D:\\Tools\\helper.exe" --flag'],
    ['close', 'child-thread'],
    ['close', 'child-process'],
    ['close', 'primary-token'],
  ]);
});
