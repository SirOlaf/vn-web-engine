# BGI bytecode processor for Ghidra

`tools/ghidra-bgi` is a Ghidra extension for BGI/Buriko program modules (`._bp`), the
bytecode run by `src/engines/buriko/bp`. It disassembles and decompiles modules, names
native calls, follows calls between modules and imports modules directly from game
archives. It reads bytecode only; nothing is executed.

| Component                                 | Purpose                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| SLEIGH languages `BGI:LE:32:<revision>`   | Instruction decoding and p-code for revisions 1.685.3, 1.665, 1.658.5 and 1.520.6       |
| `BgiLoader`                               | Maps a decoded `._bp` (16-byte header + payload) and selects the revision               |
| `BgiArchiveFileSystem`                    | Opens ARC20 and PackFile archives, lists `*_bp` entries and removes BSE/DSC layers      |
| `BgiStackAnalyzer` / `BgiProgramAnalysis` | Operand-stack depths, function parameter/result counts, call counts, functions, text    |
| `ghidra_scripts/BgiReanalyzeFolder.java`  | Re-runs the analysis over every BGI program in a project folder                         |
| `generate-sleigh.mjs`                     | Generates, at build time, native tables and repetitive SLEIGH from the engine's sources |

Compiled story files (`BurikoCompiledScriptVer1.00`) are a separate format interpreted by
program modules such as `scrdrv._bp`; this extension decodes the program modules.

## Build and install

Requires Java 21 or newer and a Ghidra installation; nothing is downloaded. `--out` must
name a directory that does not exist.

```sh
node tools/ghidra-bgi/build.mjs --ghidra-install /opt/homebrew/opt/ghidra/libexec --out /tmp/bgi-ghidra
```

The build generates the native tables and repetitive SLEIGH, compiles the four SLEIGH
specifications with the installation's `support/sleigh`, compiles the Java classes for
release 21 and writes `BGI-<version>.zip`. Install the ZIP with **File → Install
Extensions** and restart Ghidra. `extension.properties` records the Ghidra version used
for the build; rebuild for another Ghidra version.

## Importing modules

- **From an archive:** **File → Open File System** on `sysprg.arc` (or **Batch Import** on it)
  lists the program modules. Imported entries are already decompressed.
- **From files:** import an extracted `._bp`. The loader accepts files whose header gives a
  payload offset of at least 16, a payload that fits in the file and two zero reserved words.

The loader marks one revision as preferred. For a module opened from an archive, it is the
revision whose installed opcodes and native slots decode every module of that archive;
otherwise it is decided from the single module. Later revisions mostly extend earlier
tables, so ties go to the older revision. 1.520.6 and 1.658.5 tables differ only in native
slots `80:ec`–`80:ee` and in primary `7f`, so a single extracted module may not distinguish
them; choose the language explicitly when it matters.

| Language            | Engine                               | Example                 |
| ------------------- | ------------------------------------ | ----------------------- |
| `BGI:LE:32:1.685.3` | x64, compatibility 1.72, 28-bit tags | Aokana                  |
| `BGI:LE:32:1.665`   | x86, compatibility 1.72, 26-bit tags | Jewelry Hearts Academia |
| `BGI:LE:32:1.658.5` | x86, compatibility 1.72, 26-bit tags | 恋と選挙とチョコレート  |
| `BGI:LE:32:1.520.6` | x86, compatibility 1.69, 26-bit tags | 穢翼のユースティア      |

Import every module of a game into one project folder. Each analyzed module publishes the
global code slots it fills (see [Calls between modules](#calls-between-modules)); modules
analyzed later use them. After importing a whole set, run **Script Manager → BGI →
BgiReanalyzeFolder** once so that every module sees every other module's slots.

## Reading the result

The listing uses these mnemonics; operands show locals as `[fp-disp].size`, globals as
`[address].size` and code/data addresses as absolute addresses.

| Opcodes           | Mnemonics                                                                           |
| ----------------- | ----------------------------------------------------------------------------------- |
| 00–03             | `push`, `pushn` (list of varints)                                                   |
| 04, 05, 06        | `push.la` (local address), `push.da` (module data), `push.ca` (code address)        |
| 08–0f             | `load`, `store`, `store.r`, `store.inline`, `store.seq`, `store.i`, `mov`, `pop`    |
| 10–12             | `push.fp`, `pop.fp`, `frame` (adjust the frame cursor)                              |
| 13–17, ee, ef     | `jmp`, `jmp.ind`, `jz`/`jnz`/`jgt`/…, `call`, `call.ind`, `ret`                     |
| 18–1f, e2–fb      | local/global loads, stores and indexed forms (`push`, `load.local`, `store.add`, …) |
| 20–42             | integer arithmetic, comparisons, `jt.<op>`/`jf.<op>` compare-and-branch, `update`   |
| 43–5f             | fixed-point, 64-bit and vector arithmetic                                           |
| 60–71             | memory and text operations, `sprintf`, `alloc`, `free`                              |
| 73–7f             | `drop`, write watches and host dialogs                                              |
| 7f–e0 + secondary | native slots, named after their TypeScript definition (`LoadModule`, …)             |
| ff + secondary    | `ext.register`, `ext.unregister`, `ext.return`, `ext.call`                          |

In the decompiler, functions take `int` parameters and return `int` or `void`. Native
slots are calls to stub functions in the `natives` block, so they have names, typed
arguments (VM pointers are `char *`, which shows text constants) and cross-references:
the references to a stub list every call site of that native. A stub's comment names the
TypeScript file that implements it. Stubs have no body to decompile.

Bookmarks in the **BGI stack** category mark every call whose counts were estimated (see
below). The decompiler's "Removing unreachable block" warning reflects compiled dead code
such as `push 0; jz …`.

## Machine model

The SLEIGH specification uses one 32-bit `ram` space holding VM-tagged addresses:

| Block     | Address      | Contents                                          |
| --------- | ------------ | ------------------------------------------------- |
| `globals` | `0`          | Global bank (uninitialized)                       |
| `module`  | module tag   | The module: code and its data                     |
| `frames`  | frame tag    | Frame bank; `fp` is the tagged frame cursor       |
| `heap`    | heap tag     | Thread heap bank (uninitialized)                  |
| `natives` | `0xf0000000` | Native stubs at `primary * 0x400 + secondary * 4` |

Code addresses carry the module tag. The VM pushes untagged program counters for `06`,
`16` and `ee`; the model pushes the tagged address of the same byte. Return addresses are
kept in the frame bank by the VM; the model passes them in `ra`, which keeps them out of
decompiled frames.

The frame bank is the decompiler's stack: `frame N` allocates locals, a local descriptor
addresses `fp - displacement`, and locals appear as stack variables. The operand stack is
the register file `S0`–`S255`. Instruction context carries the depth before each
instruction (`sd`), so an instruction's operand cells are fixed registers and the
decompiler recovers expressions from pushes and pops. Function parameters are passed in
`P0`.., results in `R0`. The first instruction of a function copies its parameters into the
cells below the entry depth. Context fields:

| Field | Meaning                                                                                  |
| ----- | ---------------------------------------------------------------------------------------- |
| `sd`  | Operand-stack depth before the instruction                                               |
| `cn`  | Arguments of a call or estimated native; conversions of `sprintf`                        |
| `cm`  | Results of that call                                                                     |
| `fe`  | First instruction of a function; `fn` is its parameter count                             |
| `fm`  | Results a `ret` returns                                                                  |
| `jk`  | A `14`/`15`/`16` target is the constant pushed by the preceding `06`; `jo` is its offset |

Without the analysis every instruction has depth 0, so disassembly is correct but p-code
data flow is not. Re-run **BGI Stack Analysis** (one-shot analysis) after creating
functions by hand.

## Stack analysis

`BgiStackAnalysis` decodes from the module entry, every `ee` target and every code address
pushed by `06` that is not consumed by a jump. A `06` followed by `14`, `15` or `16`
resolves that jump or call; 1.520.6 code uses this form for all control flow.

Depth propagates through each function's control flow. The first path to reach an
instruction, fallthrough first, fixes its depth: BGI statements leave unused call results
on the operand stack, so merging paths legitimately disagree, and later statements only use
cells they pushed. A wrong estimate therefore stays local instead of accumulating around a
loop. A function's parameter count is the deepest cell it pops below its entry; it returns
the top cell when every return leaves at least one cell. Recursive calls are first
estimated, then the module is analyzed again with the previous pass's summaries until they
stop changing.

Call counts come from, in order:

1. the callee's summary for direct calls and `06`-resolved calls;
2. global code slots (`ef G`, `push [G]; call.ind`, `push G; load.4; call.ind`) filled by this
   module or by a module in the same folder;
3. the format string for `sprintf` with a constant format: `%[ -.0-9]*[scdxXf]` consumes a cell;
4. an estimate: the cells pushed since the last statement boundary in the basic block are
   the arguments, and a result is assumed when the next instruction pops.

Estimates (calls through computed code addresses, extension calls, recursion, natives
without a generated effect, results of natives that push from a wait process) are
bookmarked with their reason and assumed counts. A native with exact pops keeps them; only
its result is estimated.

### Calls between modules

A module publishes a function by storing its code address into a global
(`push G; push.ca F; store.4`). Each analyzed program records these slots in the Program
Information entry **BGI Global Code Slots** (`slot:params:results:name`). Programs in the
same project folder read it from file metadata without opening each other, use the counts
for calls through the slot and label the global, for example `scrdrv2_fn_011a`.

## Native tables

`generate-sleigh.mjs` reads the per-revision slot inventories in
`src/engines/buriko/native/inventory*.ts` and the TypeScript native definitions. A slot's
name and handler come from the definition whose verified native address matches the
revision's inventory, falling back to the 1.685.3 definition of the same slot. The
operand-stack effect is counted from the handler and the helpers it calls:

- `pop32`/`popDeferred32` pop, `push32`/`pushIndeterminate32` push;
- a popped cell passed to `memory.resolve`, directly or through a variable, is a pointer;
- every `return` is a completion with the effect up to that point. `return 0` (success) is
  preferred, then other returns and the end of the body. A `return` or `throw` that cannot
  complete (a call whose type is `never`/`Promise<never>`, such as
  `errors.threadFatal`) is ignored. The chosen completions must agree;
- a handler that only completes with `return <nonzero>` installs a wait process that pushes
  its result later: its pops are exact and its result count is recorded as unknown;
- effects inside loops, iteration callbacks or disagreeing completions are data-dependent
  and recorded as unknown.

The build writes the generated files into the staged extension's `data/languages`, next to
the hand-written sources from `tools/ghidra-bgi/languages` (`bgi.sinc`, the `.slaspec`
files, `bgi.ldefs`, `bgi.pspec`): `bgi_natives_<rev>.json` (names, effects, argument kinds,
installed primaries; read by the Java analysis), `bgi_natives_<rev>.sinc`, `bgi_stack.sinc`
and `bgi.cspec`. They are not kept in the source tree; rebuild after changing native
handlers or inventories. To inspect them without building:

```sh
node tools/ghidra-bgi/generate-sleigh.mjs --out /tmp/bgi-languages
```

## Extending

- **A changed native handler or new slot:** rebuild. A handler whose effect becomes
  data-dependent is estimated at call sites; keep pops outside loops where native behavior
  allows it.
- **A new opcode:** add its constructor to `languages/bgi.sinc`, its operand layout and effect to
  `BgiDecoder`, and, if it ends a statement, the `BOUNDARY` set in `BgiStackAnalysis`.
- **A new revision:** add it to `REVISIONS` in `generate-sleigh.mjs`, to `BgiRevision`,
  to `languages/bgi.ldefs` and as `languages/bgi_<id>.slaspec`, with `@if REV` blocks in `bgi.sinc` for
  encoding or stack-effect differences.

## Checks

```sh
node --test tests/tooling-ghidra-bgi.test.mjs
node tools/ghidra-bgi/build.mjs --ghidra-install <ghidra> --out <new-dir>
```

The build fails on SLEIGH or Java errors. For a behavioural check without a GUI, install
the built extension into a scratch settings directory (`XDG_CONFIG_HOME`) and run
`support/analyzeHeadless` with `-import <archive> -recursive` and a post-script that prints
listings or decompiler output. These are text outputs; they display no game assets.

## Limitations

- P-code models ordinary arithmetic: division by zero, shift counts of 32 or more and the
  VM's indeterminate-memory faults are not modeled. Fixed-point, vector, text and host
  operations are opaque p-code operations named after their behavior.
- Code addresses are tagged in the model and untagged in the VM; arithmetic on code
  addresses differs from the VM by the module tag.
- A module's own address space starts at its first byte. Modules attached later in the same
  thread are separate programs.
- Estimated call counts can be wrong; the bookmark at the call says which assumption was
  made.
- The decompiler rejects a store to a constant address at the top of the 32-bit space
  ("memory range beyond end of address space"); such functions show their listing only.
