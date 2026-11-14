# Lua 5.1 embedding

`runtime.ts` embeds upstream Lua 5.1.5 in an isolated WebAssembly module per VM.
Strings remain `Uint8Array`; decode known UTF-8 text with `luaText`. Maps copy
values at the host boundary. `LuaReference` retains live tables/functions in the
Lua registry; owners release retained handles. Callback arguments from
`bindReferences` are temporary and must be retained to outlive the callback.

Base/coroutine, table, string, math and Pluto 2.4 (`pluto.persist(perms, value)`,
`pluto.unpersist(perms, bytes)`) libraries are available. Filesystem and process
services, package loading and debug are not exposed. Include and
other platform effects use explicit host bindings. The execute/compile entry APIs
accept Lua 5.1 bytecode only when its complete header matches the module ABI:
little-endian, 32-bit `int`/`size_t`/instructions and 64-bit floating-point numbers.
This matches PE32 Lua chunks. Upstream undump still validates prototypes and
instructions; compile does not execute the chunk, and execution keeps the shared
instruction budget. Foreign headers, including the Windows x64 `size_t` layout,
are rejected without conversion. It is not a full native Lua library replacement.

Host calls preserve coroutine state and reentrant execution. Protected Lua/host
errors restore the VM stack. A nonzero status throws `LuaRuntimeError` with the Lua
status, the error string bytes (null for non-string error values) and `hostCause`.
A host method exception becomes a Lua error carrying its message; when that message
reaches the outer call unchanged or rethrown with a `chunk:line:` prefix, `hostCause`
holds the original exception. Owners use it to keep host refusals distinct from
errors raised by Lua code. A per-call instruction budget is shared across nested
calls; exhaustion throws across the wasm import, preventing Lua pcall from
swallowing it, and invalidates that VM. Host table conversion is bounded to
100,000 visited values per conversion and nesting depth 64. Memory growth is bounded to 2 GiB: the native Artemis
allocator (Rev.3179 0x1401a1d70 = Rev.3139 0x1401a0710, `lua_newstate` inlined in
3179 0x14012a720 = 3139 0x1401293e0) is plain
`realloc`/`free`, and game Lua may stop the collector (`collectgarbage("stop")`) until
its heap reaches a threshold of its own, so a small bound fails scripts that run natively. These
limits do not bound every C library operation or claim a security sandbox.

`createThread` roots a callable in a separate Lua coroutine. Each `resume` returns
`yielded` or `done` plus byte/table values; resume arguments become the values of
Lua `coroutine.yield`. `invokeFirst` and an optional thread result limit avoid
converting extra returns that a native owner discards. Owners close the thread after completion, failure or
cancellation. A suspended thread keeps its Lua locals while other VM work runs.
The instruction budget applies per outer resume and is shared with nested calls.
Host C callbacks must return before Lua yields; yielding across a protected C-call
boundary remains Lua 5.1's error. The engine scheduler determines when a yielded
resource request has completed and when to resume it.

## Rebuilding

`wasm/lua51/vendor` contains unmodified C/header sources and COPYRIGHT from
[Lua 5.1.5](https://www.lua.org/ftp/lua-5.1.5.tar.gz), under its MIT license.
Upstream archive SHA-256:
`2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333`.
The standalone lua/luac executables and print.c are omitted. The build also excludes
io, os, package, debug and the upstream library initialization implementation.
Custom embedding code is in `wasm/lua51/bridge.c`.

`wasm/lua51/pluto.c` implements Pluto 2.4 against the Lua internals. Its byte stream
is the x64 Windows layout that Artemis executables use: C `int` fields take 4 bytes;
`size_t`, pointer and `ptrdiff_t` fields (string and userdata lengths, light userdata,
thread stack and frame offsets) take 8 bytes, little-endian. Every value starts with
an int first-time flag and an int reference; first occurrences add the type and its
payload, and type 101 marks a value found in the perms table. Function environments
equal to the globals table are stored as nil and restored to the loading state's
globals. Malformed or truncated input raises a Lua error and restarts the collector,
where the native library would read undefined data.

With Emscripten on PATH:

```sh
npm run build:lua51
npm run build:runtime
node --test tests/lua51-runtime.test.mjs
```

`EMCC` can select a compiler and `EM_CONFIG` its configuration. The checked-in
`wasm-binary.ts` was built with Emscripten 6.0.11 and wasm exception handling for
Lua longjmp. Normal runtime/web builds use the checked-in module and do not require
Emscripten. The standalone wasm host exposes no file descriptors or process exit
service. Missing host capabilities fail explicitly.
