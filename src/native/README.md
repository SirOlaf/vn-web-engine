# Native library reimplementations

`src/native/` holds browser reimplementations of native libraries: engine plugins
(`emotedriver.dll`, `drawdeviceD3DZ.dll`, …) and the system libraries they import
(`d3d9.dll`). Each library has one directory named after its file.

The loader is `src/platform/native-libraries.ts`. It provides `LoadLibrary`,
`FreeLibrary`, static imports and delay-load imports for these libraries.

## Contracts

Libraries compose only through contracts. A library's contract is
`src/native/<library>/contract.ts`. It holds:

- the export surface, as TypeScript interfaces, and the contract token
  (`defineNativeContract(fileName, revision)`);
- the C++/COM interfaces those exports return. Each member maps one-to-one to a vtable
  slot and records its slot number and native address;
- constants that are part of the interface.

A contract imports only other contracts and the loader types. Each contract names the
native build (SHA-256) that its slot numbers and addresses come from.

**Rule:** code outside `src/native/<library>/` imports only that library's
`contract.ts`. This covers other libraries, engines and shared layers. Implementation
modules are imported only by the runtime wiring (`ui/runtimes/`), which registers them
with the loader. `tests/native-libraries.test.mjs` enforces this rule.

The contract carries no implementation details, so a TypeScript implementation, a
Wasm-backed implementation and a test double are interchangeable.

## Contract value rules

A contract member must be implementable across a Wasm boundary:

- Arguments and results are numbers, booleans, strings, `Uint8Array`, plain records of
  these, and objects typed by a contract interface.
- Calls are synchronous. Native calls return before the caller continues, and the
  loader links libraries synchronously, as `DllMain` runs. Prepare asynchronous work
  (compiling a Wasm module, reading tables) before the implementation is registered.
- An object received through a contract is used only through that contract. An
  implementation may reject objects it did not create, where the native library
  requires its own objects (for example, `IEmotePlayer.assignState`).
- Callbacks appear only where the native export takes a function pointer
  (`emoteFilterTexture`). They receive views the implementation writes back.
- Ownership follows the native reference counts (`addRef` / `release`). GPU resources
  are freed when the count reaches zero.

## Implementations

An implementation is a `NativeLibraryImplementation`:

- `contract`: the contract it provides;
- `identities`: the native builds it reproduces, by SHA-256 for files shipped with a
  game and by file name for system libraries;
- `imports`: the contracts it uses, each `static` or `delay`, as in the native import
  tables;
- `link(context)`: returns the exports. Imports are reached through `context`, which
  rejects imports that were not declared.

The loader admits one implementation per identity. To switch an implementation, for
example TypeScript for Wasm, register the other one. A located file with no
implementation for its hash loads as `unsupported`. The runtime decides how to surface
that. Engine and library code do not.

## Libraries

| Library           | Contract                         | Implementation | Notes                                              |
| ----------------- | -------------------------------- | -------------- | -------------------------------------------------- |
| `emotedriver.dll` | `emotedriver/contract.ts`        | none yet       | E-mote D3D runtime; `IEmoteDevice`, `IEmotePlayer` |
| `d3d9.dll`        | `d3d9/contract.ts` (device only) | none yet       | `IDirect3DDevice9` members used by clients         |
