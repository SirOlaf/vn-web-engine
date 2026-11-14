import test from 'node:test';
import assert from 'node:assert/strict';
import {Lua51, LuaRuntimeError, luaText} from '../dist/core/lua51/runtime.js';
const bytes = (text) => new TextEncoder().encode(text);

test('Lua 5.1 executes closures, environments, byte strings and isolated states', () => {
  const a = new Lua51(),
    b = new Lua51();
  try {
    a.execute(
      bytes(`
      assert(_VERSION == 'Lua 5.1')
      function make(x) return function(y) return x+y end end
      f=make(12); result=f(8)
      local g=loadstring('return secret'); setfenv(g,{secret=42}); envresult=g()
      binary=string.char(0,255,128,65)
      unpackresult=unpack({3,4})
      tree={}; tree.self=tree
    `),
    );
    assert.equal(a.getGlobal('result'), 20);
    assert.equal(a.getGlobal('envresult'), 42);
    assert.equal(a.getGlobal('unpackresult'), 3);
    assert.deepEqual(a.getGlobal('binary'), Uint8Array.of(0, 255, 128, 65));
    const tree = a.getGlobal('tree');
    assert.equal(tree.get('self'), tree);
    assert.equal(b.getGlobal('result'), null);
    a.setGlobal(
      'incoming',
      new Map([
        ['name', bytes('雪')],
        [1, 7],
      ]),
    );
    a.execute(bytes('assert(incoming.name == "雪" and incoming[1] == 7)'));
  } finally {
    a.close();
    b.close();
  }
});

test('A stopped collector lets the heap grow past 64 MiB, as with the native realloc allocator', () => {
  // Game Lua stops the collector and only steps it once collectgarbage("count") reaches its own
  // threshold (100 MB on x64); the heap must hold that much live and dead data.
  const lua = new Lua51();
  try {
    lua.execute(
      bytes(`
      collectgarbage('stop')
      keep = {}
      for i = 1, 96 do
        local s = string.rep(string.char(64 + i % 26), 1048576 - i)
        if i % 2 == 0 then keep[#keep + 1] = s end
      end
      grown = collectgarbage('count')
      collectgarbage('step', 0.01)
      collectgarbage('collect')
      collected = collectgarbage('count')
    `),
    );
    assert.ok(lua.getGlobal('grown') > 96 * 1024);
    assert.ok(lua.getGlobal('collected') > 48 * 1024);
    assert.ok(lua.getGlobal('collected') < 50 * 1024);
  } finally {
    lua.close();
  }
});

test('Host callbacks preserve reentrant include, colon receiver and coroutine state', () => {
  const vm = new Lua51();
  const events = [];
  try {
    vm.bind('include', (args) => {
      events.push(luaText(args[0]));
      vm.execute(bytes('included = (included or 0) + 1'));
      return [];
    });
    vm.bind('echo', (args) => args);
    vm.execute(
      bytes(`
      function boot(e)
        e:include('first')
        assert(e:echo(string.char(0,255)) == string.char(0,255))
        local c=coroutine.create(function() engine:include('coroutine') end)
        assert(coroutine.resume(c))
      end
    `),
    );
    vm.call('boot');
    assert.deepEqual(events, ['first', 'coroutine']);
    assert.equal(vm.getGlobal('included'), 2);
  } finally {
    vm.close();
  }
});

test('Lua and host errors are protected and restore the VM stack', () => {
  const vm = new Lua51();
  try {
    vm.bind('failure', () => {
      throw new Error('host failure');
    });
    assert.throws(() => vm.execute(bytes('engine:failure()')), /host failure/);
    assert.throws(() => vm.execute(bytes('engine:missing()')), /Unsupported engine method/);
    assert.throws(() => vm.execute(bytes('function broken(')), /expected/);
    assert.throws(() => vm.execute(Uint8Array.of(27, 76, 117, 97)), /bytecode/);
    vm.execute(bytes(`ok,reason=pcall(function() engine:failure() end); result=123`));
    assert.equal(vm.getGlobal('ok'), false);
    assert.match(luaText(vm.getGlobal('reason')), /host failure/);
    assert.equal(vm.getGlobal('result'), 123);
    assert.throws(() => vm.call('noFunction'), /Missing Lua function/);
  } finally {
    vm.close();
  }
});

test('Instruction limit aborts even when Lua tries to catch errors, and invalidates the interrupted VM', () => {
  const vm = new Lua51(5000);
  assert.throws(
    () => vm.execute(bytes('while true do pcall(function() local x=1 end) end')),
    /instruction budget/,
  );
  assert.throws(() => vm.execute(bytes('result=1')), /closed or interrupted/);
  vm.close();
});

test('Live references observe later table edits, invoke closures and reject foreign or released handles', () => {
  const vm = new Lua51(),
    other = new Lua51();
  let retained;
  try {
    vm.bindReferences('keep', (refs) => {
      retained?.release();
      retained = refs[0].retain();
      return [];
    });
    vm.execute(
      bytes(
        'callbacks={}; engine:keep(callbacks); callbacks.run=function(e,p) return p+2, "ok" end',
      ),
    );
    const fn = retained.get('run');
    try {
      const result = fn.invoke([40], true);
      assert.equal(result[0], 42);
      assert.equal(luaText(result[1]), 'ok');
      assert.throws(() => other.setGlobal('foreign', fn), /Foreign/);
    } finally {
      fn.release();
    }
    assert.throws(() => fn.invoke(), /released/);
    const absent = retained.get('absent');
    assert.equal(absent.type, 0);
    assert.equal(absent.read(), null);
    absent.release();
    vm.execute(bytes('callbacks.run=function() error("callback failed") end'));
    const error = retained.get('run');
    try {
      assert.throws(() => error.invoke(), /callback failed/);
    } finally {
      error.release();
    }
    retained.release();
  } finally {
    vm.close();
    other.close();
  }
});

test('Host conversion bounds large Lua tables and restores the stack after refusal', () => {
  const vm = new Lua51();
  try {
    vm.execute(bytes('large={}; for i=1,60000 do large[i]=i end; marker=7'));
    assert.throws(() => vm.getGlobal('large'), /host conversion limit/);
    assert.equal(vm.getGlobal('marker'), 7);
    vm.execute(bytes('large=nil; marker=8'));
    assert.equal(vm.getGlobal('marker'), 8);
  } finally {
    vm.close();
  }
});

test('Host-owned Lua threads retain locals, yield byte requests and resume with asynchronous results', () => {
  const vm = new Lua51(),
    requests = [];
  vm.bind('request', (args) => {
    requests.push(luaText(args[0]));
    return [];
  });
  vm.execute(
    bytes(`
    function load(e, initial)
      local total = initial
      e:request('first')
      local result = coroutine.yield('first', nil, {offset = total})
      total = total + result
      e:request('second')
      local next = coroutine.yield('second')
      return total + next, 'complete'
    end
  `),
  );
  const callback = vm.referenceGlobal('load'),
    thread = vm.createThread(callback, true);
  callback.release();
  try {
    const first = thread.resume([4]);
    assert.equal(first.status, 'yielded');
    assert.equal(luaText(first.values[0]), 'first');
    assert.equal(first.values[1], null);
    assert.equal(first.values[2].get('offset'), 4);
    // An independent chunk/coroutine may run while this thread is suspended.
    vm.execute(bytes(`other = 77`));
    const second = thread.resume([8]);
    assert.equal(second.status, 'yielded');
    assert.equal(luaText(second.values[0]), 'second');
    const final = thread.resume([16]);
    assert.equal(final.status, 'done');
    assert.equal(final.values[0], 28);
    assert.equal(luaText(final.values[1]), 'complete');
    assert.deepEqual(requests, ['first', 'second']);
    assert.equal(vm.getGlobal('other'), 77);
    assert.throws(() => thread.resume(), /finished/);
  } finally {
    thread.close();
    thread.close();
    vm.close();
  }
});

test('Thread errors preserve other VM work; budgets abort loops after a yield and close safely', () => {
  const vm = new Lua51(10000);
  vm.execute(
    bytes(`function broken() coroutine.yield(); error('failed after yield') end
    function spin() coroutine.yield('ready'); while true do pcall(function() while true do end end) end end`),
  );
  const broken = vm.referenceGlobal('broken'),
    task = vm.createThread(broken);
  broken.release();
  assert.equal(task.resume().status, 'yielded');
  assert.throws(() => task.resume(), /failed after yield/);
  assert.throws(() => task.resume(), /finished/);
  task.close();
  vm.execute(bytes(`valid = 1`));
  assert.equal(vm.getGlobal('valid'), 1);
  const spin = vm.referenceGlobal('spin'),
    loop = vm.createThread(spin);
  spin.release();
  assert.equal(loop.resume().status, 'yielded');
  assert.throws(() => loop.resume(), /instruction budget exceeded/);
  assert.throws(() => vm.getGlobal('valid'), /closed or interrupted/);
  loop.close();
  vm.close();
});

test('Lua 5.1 bytecode uses its exact ABI, validates instructions and preserves binary file bytes', async () => {
  const {windowsTextFileBytes} = await import('../dist/platform/windows-text-file.js');
  const vm = new Lua51();
  try {
    vm.execute(
      bytes(`binary=string.dump(function()
        local function add(x) return x+7 end
        result=add(35)
        payload="A\\r\\nB\\026\\000\\255"
      end)`),
    );
    const binary = vm.getGlobal('binary');
    assert.ok(binary instanceof Uint8Array);
    assert.deepEqual(
      binary.subarray(0, 12),
      Uint8Array.of(27, 76, 117, 97, 81, 0, 1, 4, 4, 4, 8, 0),
    );
    vm.compile(binary, 'binary-fixture');
    assert.equal(vm.getGlobal('result'), null);
    const raw = Uint8Array.from([...bytes('#!/lua\r\n'), ...binary]);
    const text = windowsTextFileBytes(raw);
    assert.ok(text.length < raw.length);
    vm.executeFile(raw, 'fixture.lub', text);
    assert.equal(vm.getGlobal('result'), 42);
    assert.deepEqual(vm.getGlobal('payload'), Uint8Array.of(65, 13, 10, 66, 26, 0, 255));
    for (const [at, value] of [
      [4, 82],
      [6, 0],
      [7, 8],
      [8, 8],
      [9, 8],
      [10, 4],
      [11, 1],
    ]) {
      const foreign = binary.slice();
      foreign[at] = value;
      assert.throws(() => vm.compile(foreign), /Unsupported Lua bytecode ABI/);
      assert.throws(() => vm.execute(foreign), /Unsupported Lua bytecode ABI/);
    }
    assert.throws(() => vm.compile(binary.subarray(0, binary.length - 1)), /unexpected end/);
    const invalid = binary.slice(),
      view = new DataView(invalid.buffer);
    let at = 12;
    at += 4 + view.getUint32(at, true); // Source string, including its NUL.
    at += 8 + 4; // Definition lines, upvalues/parameters/vararg/stack size.
    assert.ok(view.getUint32(at, true) > 0);
    view.setUint32(at + 4, 63, true); // An opcode outside Lua 5.1's instruction set.
    assert.throws(() => vm.compile(invalid), /bad code/);
    vm.execute(bytes('afterBinaryFailures=73'));
    assert.equal(vm.getGlobal('afterBinaryFailures'), 73);
  } finally {
    vm.close();
  }
});

test('Precompiled loops retain the shared instruction budget and invalidate interrupted states', () => {
  const producer = new Lua51();
  let binary;
  try {
    producer.execute(bytes('binary=string.dump(function() while true do end end)'));
    binary = producer.getGlobal('binary');
  } finally {
    producer.close();
  }
  const vm = new Lua51(1000);
  try {
    assert.throws(() => vm.execute(binary), /instruction budget exceeded/);
    assert.throws(() => vm.getGlobal('result'), /closed or interrupted/);
  } finally {
    vm.close();
  }
});

test('Prepared loadfile preserves header line numbers, text translation and binary ABI refusal', async () => {
  const {windowsTextFileBytes} = await import('../dist/platform/windows-text-file.js');
  const vm = new Lua51();
  try {
    const source = bytes('#!/lua\r\nresult=[[A\r\nB\rC]]\x1a invalid tail'),
      original = source.slice();
    vm.executeFile(source, 'module.lua', windowsTextFileBytes(source));
    assert.equal(luaText(vm.getGlobal('result')), 'A\nB\nC');
    assert.deepEqual(source, original);
    vm.executeFile(bytes('# header without newline'), 'empty.lua');
    const broken = bytes('# header\r\nfunction broken(');
    assert.throws(
      () => vm.compileFile(broken, 'broken.lua', windowsTextFileBytes(broken)),
      /broken.lua:2/,
    );
    assert.throws(
      () => vm.executeFile(Uint8Array.of(35, 10, 27, 76, 117, 97), 'binary.lua'),
      /bytecode/,
    );
    assert.throws(() => vm.execute(bytes('#!/lua\nresult=1')), /unexpected symbol/);
    assert.deepEqual(
      windowsTextFileBytes(Uint8Array.of(65, 13, 10, 66, 13, 67, 26, 68)),
      Uint8Array.of(65, 10, 66, 13, 67),
    );
  } finally {
    vm.close();
  }
});

test('Lua errors carry status, string bytes and the host exception they were raised from', () => {
  const vm = new Lua51();
  const refusal = new Error('Unsupported synthetic capability');
  try {
    vm.bind('refuse', () => {
      throw refusal;
    });
    vm.execute(
      bytes(`
      function luaOnly() local missing; missing() end
      function direct() engine:refuse() end
      function rethrown() local ok, e = pcall(engine.refuse, engine); error(e) end
      function handled() pcall(engine.refuse, engine); error('later') end
      function tableValue() error({}) end
      function embedded() error('a\\0b', 0) end
    `),
    );
    const failure = (name) => {
      const callback = vm.referenceGlobal(name);
      try {
        callback.invokeVoid();
      } catch (error) {
        return error;
      } finally {
        callback.release();
      }
      assert.fail('expected Lua error');
    };
    const luaOnly = failure('luaOnly');
    assert.ok(luaOnly instanceof LuaRuntimeError);
    assert.equal(luaOnly.status, 2);
    assert.equal(luaOnly.hostCause, undefined);
    assert.match(luaText(luaOnly.value), /attempt to call local 'missing'/);
    assert.equal(failure('direct').hostCause, refusal);
    assert.equal(failure('direct').message, refusal.message);
    assert.equal(failure('rethrown').hostCause, refusal);
    assert.equal(failure('handled').hostCause, undefined);
    const table = failure('tableValue');
    assert.equal(table.value, null);
    assert.equal(table.message, 'Lua error 2');
    assert.deepEqual(failure('embedded').value, Uint8Array.of(97, 0, 98));
    assert.equal(vm.usable, true);
  } finally {
    vm.close();
  }
});

test('Pluto persists the native x64 byte layout and restores shared, cyclic and running state', () => {
  const vm = new Lua51();
  try {
    vm.execute(
      bytes(`
      flat = pluto.persist({}, {a=true})
      ok, cfunction = pcall(pluto.persist, {}, string.format)
      perm = pluto.persist({[string.format]='fmt'}, {f=string.format})
      local shared = {n=1.5, s=string.char(0,1,2)}
      local root = {x=shared, y=shared, list={10,20,30}}
      root.self = root
      setmetatable(root, {kind='mt'})
      local up = 5
      root.inc = function() up = up + 1; return up end
      root.get = function() return up end
      root.env = setfenv(function() return marker end, {marker='own'})
      root.co = coroutine.create(function(a)
        local b = a * 2
        local c = coroutine.yield(b)
        return b + c
      end)
      assert(select(2, coroutine.resume(root.co, 4)) == 8)
      -- The suspended frame of the coroutine.yield C function is persisted as a permanent.
      data = pluto.persist({[coroutine.yield]=1}, root)
      local copy = pluto.unpersist({coroutine.yield}, data)
      assert(copy.self == copy and copy.x == copy.y and copy.x ~= shared)
      assert(copy.x.n == 1.5 and copy.x.s == string.char(0,1,2))
      assert(copy.list[1] == 10 and copy.list[3] == 30 and #copy.list == 3)
      assert(getmetatable(copy).kind == 'mt')
      assert(copy.inc() == 6 and copy.get() == 6 and up == 5)
      marker = 'global'
      assert(copy.env() == 'own')
      local ok2, sum = coroutine.resume(copy.co, 3)
      assert(ok2 and sum == 11 and coroutine.status(copy.co) == 'dead')
      assert(coroutine.status(root.co) == 'suspended')
      local p = pluto.unpersist({fmt=string.format}, perm)
      assert(p.f == string.format)
      bad = pcall(pluto.unpersist, {}, string.sub(data, 1, 20))
      collectgarbage('collect')
    `),
    );
    const flat = vm.getGlobal('flat');
    const view = new DataView(flat.buffer, flat.byteOffset, flat.byteLength);
    const ints = (offset, count) =>
      Array.from({length: count}, (_, index) => view.getInt32(offset + index * 4, true));
    // Table #1: not special, nil metatable (0, 0); key "a" (#2, size_t length 1);
    // true (#3); nil terminator.
    assert.deepEqual(ints(0, 9), [1, 1, 5, 0, 0, 0, 1, 2, 4]);
    assert.equal(view.getBigInt64(36, true), 1n);
    assert.equal(flat[44], 0x61);
    assert.deepEqual(ints(45, 6), [1, 3, 1, 1, 0, 0]);
    assert.equal(flat.length, 69);
    assert.equal(vm.getGlobal('ok'), false);
    assert.match(luaText(vm.getGlobal('cfunction')), /Attempt to persist a C function/);
    assert.equal(vm.getGlobal('bad'), false);
  } finally {
    vm.close();
  }
});
