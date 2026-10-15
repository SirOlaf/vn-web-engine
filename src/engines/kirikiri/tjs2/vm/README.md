# TJS2 VM

Runs TJS2 code (`../code-block.ts`) on the object model of `../runtime/`, following krkrz
`tjsInterCodeExec.cpp` and the reference build `nekopara_vol1.exe`. The instruction set is the
native one (`../opcodes.ts`); code comes from the compiler or from TJS2 bytecode.

| File                | Contents                                                                    |
| ------------------- | --------------------------------------------------------------------------- |
| `executor.ts`       | `TjsVm`: the `TjsScriptExecutor` the core installs; compiling, caching      |
| `link.ts`           | Instantiation of a `CodeBlock` into context objects                         |
| `context.ts`        | `InterCodeContext` (`tTJSInterCodeContext`): functions, classes, properties |
| `vm.ts`             | `Vm`: frames and the instruction loop (`ExecuteAsFunction`, `ExecuteCode`)  |
| `variant-stack.ts`  | `VariantArrayStack` (`tTJSVariantArrayStack`): register files               |
| `object-proxy.ts`   | `ObjectProxy` (`tTJSObjectProxy`): register -2, `this` then `global`        |
| `string-methods.ts` | Members of strings and octets (`length`, `charAt`, `sprintf`, …)            |

## Running a script block

`TjsVm.run` compiles the block (`../compiler.ts`, `generateScriptBlock`), prints every
diagnostic to the console as the native compiler does and throws the first error as a
`TjsCompileError`. It instantiates the code (`instantiateBlock`) and calls the top-level
context with `this` = the given context or `global`; the top level is released when it returns.
Anonymous expressions (`eval`, the `!` operator) are cached by text, 64 at most, unless they
used the preprocessor or define functions (`tTJSScriptCache`). `runByteCode` reads `TJS2100`
data instead (`../bytecode.ts`).

Instantiation creates one `InterCodeContext` per compiled context and links them as the native
compiler leaves them: data areas hold their constants (contexts, and `(const)` arrays and
dictionaries built now), functions and classes declared in a function or class are members of
it, accessors belong to their property, the super-class getter to its class.

## Contexts

An `InterCodeContext` is a custom object. `funcCall` without a member runs its code: the top
level with `this` defaulting to `global`, functions, accessors and classes with the given
`this`. A property context answers `propGet`/`propSet` without a member through its getter
and setter. `new` of a class context creates a plain object, runs the class body on it (which
adds the class name, calls each base class on the object, copies the class's members bound to
the object, and runs the `var` initialisers) and then calls the member named after the class;
its result code is ignored. A class looks up members it lacks in its base classes, last base
first, by running the super-class getter's entry for each.

## Frames

`executeAsFunction` allocates a register file from the `VariantArrayStack`: locals below the
two reserved registers (`this` at -1, the this-proxy at -2), register 0 (void), temporaries
above. Arguments are copied into the first locals; missing ones are cleared; a collapsing
parameter (`a*`) receives a new Array of the rest. The frame holds references on its context,
`this` and the arguments while it runs.

Registers are owning slots. They are not cleared when a function returns, as natively: a value
left in a register keeps its object alive until a later call reuses the slot or the stack is
compacted (`stack.compact()`, natively at idle time through `tTJS::DoGarbageCollection`). This
decides when `finalize` runs for objects held only by locals of returned functions.

The loop executes one instruction at a time on the frame's record (code, registers, position,
condition flag, try handlers). Member access, calls, operations on members, `new`, property
objects, `typeof` of members, `delete` and the `!` operator go through the target's `Dispatch`
methods; strings and octets answer `length`, indexing and their methods in the VM. Calls to
script functions run on a new frame.

## Suspension

When a call made by an instruction returns `TJS_E_SUSPENDED`, the frame stays where it is: it
records how to finish the instruction (check the result code, store the new object, …),
registers a continuation with `suspender.defer` and returns `TJS_E_SUSPENDED` to its own caller.
When the callee completes, the continuation finishes the instruction and continues the loop; an
exception from the callee is raised at that instruction. Every frame between the suspending
native and `Suspender.run` does the same, so a suspension anywhere in a chain of script calls,
property getters, constructors, `eval` or class bodies resumes each frame in order.

The runtime's default member handlers follow the same protocol: calling a property's value
(`funcCallViaPropGet`, as in the lazily loading `property askYesNo { getter { … } }` of
`Initialize.tjs`) and read-modify-write operations on properties (`readModifyWrite`) continue
after a suspending getter or setter. Natives that call script and cannot resume themselves run
it under `nonSuspending`: super-class getters, the `message` of a thrown object, `finalize`,
`missing` and enumeration callbacks.

## Exceptions

An error raised by an instruction is handled where the native VM handles it:

- Inside a `try` block (`ENTRY` … `EXTRY`), the error becomes a TJS value in the block's
  exception register and execution continues at the catch position: a thrown value as is, a
  script error as `new Exception(message)` with its `trace`, any other TJS error as an
  `Exception` with the message and an empty trace.
- Otherwise a script error gets this frame appended to its trace
  (`name(line)[(function) f]`, joined by `<--`) and propagates; any other TJS error becomes a
  script error at this frame's position with an empty trace.

`throw` raises a `TjsScriptException` with `script exception : <message>` (the value's
`message` member, if it has one) and the value. `TjsSuspensionError` and errors that are not
TJS errors (bugs) are not catchable by scripts.

## Known gaps

- `Octet.unpack` needs OctPack (as `Array.pack` does).
- The console dump of a failing instruction (`DisplayExceptionGeneratedCode`: disassembly and
  registers) is not printed.

## Verification

- `tests/kirikiri-tjs2-vm.test.mjs`: code generation, operators, classes, properties,
  exceptions and traces, string methods, arguments, suspension, register lifetime, bytecode.
- `tools/probe-kirikiri-core.mjs <game folder>` boots the core and runs `startup.tjs` on the
  VM until it ends or stops at the first missing native class.
