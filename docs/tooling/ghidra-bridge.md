# Dedicated Ghidra function export bridge

`tools/ghidra-bridge` provides a small Ghidra plugin that reads program state and
writes new export artifacts. Its HTTP operations are health, export to a file,
and legacy inline export. It exports decoded instructions, raw P-code, and
HighFunction SSA in a documented wire format. It does not expose
script execution, renaming, memory writes, saving, program opening, or native
target execution. It does not use `GHIDRA_MCP_ALLOW_SCRIPTS`.

The existing upstream clone is `targetgame/ghidra-mcp-src` (7.0.0), while the
running MCP integration identifies as the earlier release. A standalone plugin
keeps this narrow export operation independent of that larger upgrade and its
many mutation endpoints. The cloned upstream was inspected but not modified.
Its deployment tasks can save, stop, and force-close Ghidra; this bridge's build
script does none of those things.

## Build and install

Build with Java 21 or newer and an existing Ghidra installation. No packages or
dependencies are downloaded. `--out` must name a directory that does not exist:

```sh
node tools/ghidra-bridge/build.mjs \
  --ghidra-install /opt/homebrew/opt/ghidra/libexec \
  --out /absolute/path/to/new-bridge-build
```

`--java-home DIR` selects a JDK explicitly. The output contains an installable
`NativeExportBridge-0.2.0.zip` and `build-receipt.json`. The receipt records the
Ghidra version, Java target release, source hashes, and ZIP hash. Java classes
target release 21; JAR/ZIP timestamps are fixed for reproducibility. The installed
Ghidra version is written into `extension.properties`.

Install the ZIP with Ghidra's extension manager, then enable
`NativeExportBridgePlugin` in the desired CodeBrowser's plugin configuration.
If installation requires a Ghidra restart, perform that during the program
owner's normal save/close boundary. This project does not restart or close a live
Ghidra instance, save another agent's pending work, or patch the user's Ghidra
configuration as part of building. Existing game programs and annotations are
not changed by the exporter.

The plugin binds only `127.0.0.1:18493`. If that port is occupied, it reports a
startup error and uses no fallback port or external interface. Enable it in one
CodeBrowser per process. It searches that CodeBrowser's open programs by exact
project path and rejects zero or multiple matches; it never substitutes the
active program. A consumer reference keeps the chosen program open during the
read, then is released without saving.

## HTTP contract

`GET http://127.0.0.1:18493/v1/health` returns:

```json
{
  "schema": "ghidra-bridge-health/v1",
  "bridgeVersion": "0.2.0",
  "ghidraVersion": "12.1.3",
  "capabilities": ["function-export", "function-export-file"]
}
```

`POST /v1/function/file` requires `Content-Type: application/json` and
`X-VN-Bridge: 1`. Browser `Origin` headers are rejected, no CORS access is granted,
and other methods/routes are not supported. The request body is bounded to 16 KiB.

```json
{
  "schema": "ghidra-function-file-request/v1",
  "binary": {
    "programPath": "/aokana.exe",
    "executableSha256": "f585e28f79923b8aa487d8690165e45ce3377c7e1b8381d3b75c659c7e933d7a",
    "languageId": "x86:LE:64:default",
    "imageBase": "0x140000000"
  },
  "entryAddress": "0x1400de050",
  "representation": "both",
  "outputPath": "/absolute/existing/evidence/aokana-0x1400de050.json"
}
```

Every call explicitly identifies one binary and one exact function entry.
`representation` may be `raw`, `high`, or `both` (default). Optional `limits` are:

| Limit              |   Default |   Maximum |
| ------------------ | --------: | --------: |
| `decompileSeconds` |        30 |       120 |
| `maxBodyBytes`     | 1,048,576 | 8,388,608 |
| `maxInstructions`  |    20,000 |    50,000 |
| `maxPcodeOps`      |    50,000 |   100,000 |

The operation budget covers raw and high operations together. Limits are positive
integers. The exporter refuses incomplete decoding, limit exhaustion, decompiler
failure, inconsistent graph edges, or program changes during capture. It never
returns a truncated `status: "complete"` response. One export runs at a time.

The file route streams UTF-8 JSON plus a newline to disk on the **Ghidra host**
and returns only a `ghidra-function-file-receipt/v1` response with
`status: "complete"`. Its `file` object contains `path`, `byteLength`, `sha256`,
and `contentSchema: "ghidra-function-export/v1"`. The remaining fields are exact
binary/function identity, function body hash, selected representation, counts,
exporter version and stable live-state summary. There are no instruction, varnode
or block arrays in the receipt. Unrequested representation counts are `null`.

`outputPath` must name a new absolute `.json` file, without parent traversal or
control characters, in an existing directory. The parent is canonicalized.
After a complete, stable capture, JSON is streamed through a SHA-256 digest into
a same-directory temporary file (mode `0600` on POSIX). The file is synced and
published atomically using an exclusive hard link. No existing file or symlink
can be replaced, including one created after request validation. A collision
returns HTTP 409 with `code: "file-exists"`. Temporary files are cleaned up;
unsupported hard-link filesystems fail without a weaker publication fallback.
The graph itself is still assembled in bounded memory before serialization.

The file hash covers the exact bytes, including the newline; it is separate from
the importer review plan's canonical-JSON hash. Artifacts retain the existing
export schema and work directly with the graph importer. If a client disconnects,
the bounded capture/file write can still finish; check the requested destination
before retrying.

`POST /v1/function` remains an explicit inline HTTP inspection route. It accepts
`ghidra-function-request/v1` without `outputPath` and returns the full
`ghidra-function-export/v1` object. The MCP and CLI always use the file route.

Error responses have an HTTP error status and
`schema: "ghidra-bridge-error/v1"`, `status: "error"`, `code`, and `message`.
The full contract is `tools/ghidra-bridge/wire.d.ts`; actual synthetic responses
are in `tools/ghidra-bridge/fixtures`.

## Evidence and representation details

The binary identity uses the same project path, imported executable SHA-256,
language ID, and image base as the exact-address ledger. Addresses are canonical
lowercase unsigned `0x` strings, never JSON numbers. Function body ranges are
complete, inclusive, ordered, and individually hashed. `bodySha256` hashes the
concatenation of all range bytes without gap bytes. The exporter emits hashes,
decoded instruction text, and P-code; it does not emit native instruction bytes.
Native captures belong in local evidence storage, not source control. The checked
in captures are entirely synthetic.

`function.parameters` and `returnValue` describe the database signature, including
calling convention, compiler specification, parameter source, and ordered storage
pieces. They remain distinct from inferred `high.parameters`. Type information
is explicitly a hint; it is not an implementation proof. Address-space IDs,
names, sizes, and addressable units accompany the graph, while each storage
varnode records its own space and offset. Compound storage piece order is kept.
The special VARIABLE/join space is included even though Ghidra omits it from
`getAllAddressSpaces()`; compound high varnodes additionally carry `joinStorage`.

`raw` is `Instruction.getPcode(true)`, including stored flow overrides, with
`ssa: false`. Each decoded instruction retains its address, length, mnemonic,
operand text, flow metadata, and ordered raw operations. Raw varnodes describe
storage. Reusing the same register or temporary location does not establish an
SSA identity.

`high` is a fresh `DecompInterface` HighFunction using the fixed `normalize`
simplification style, with `ssa: true`. Basic blocks retain original indices;
operations retain their exact block-list order, input slot order, and Ghidra
sequence address/time/order. Varnode IDs use object identity and include the
Ghidra AST unique ID, definition, input flags, storage, and high-variable hints.
Block predecessors/successors retain reverse-edge indices. `conditionalTargets`
comes directly from Ghidra's false/true outgoing edges for a terminating
`CBRANCH`. Every `MULTIEQUAL` input explicitly names its corresponding predecessor
edge, including that predecessor's successor index; this preserves parallel
edges and loop backedges without sorting away their meaning.

The exporter uses membership in `PcodeBlockBasic.getIterator()` plus matching
parent identity to identify attached operations. In installed Ghidra 12.1.3,
`PcodeSyntaxTree.decodeBasicBlock` inserts decoded operations without clearing
`PcodeOpAST.bDead`; filtering by `isDead()` would incorrectly erase the complete
graph. The actual synthetic integration test exposed this, and an empty attached
graph now rejects export.

Open transactions are refused. Live program state is captured before and after
analysis, and its dirty flag, modification counter, domain-file stamp, and binary
identity must remain unchanged. A stable dirty program can be exported for
research; `savedState` is explicitly `unverified`. This bridge does not replace
the ledger's independent persisted-database readback or imply that a captured
function's behavior has been implemented.

## Focused validation

The ordinary default tests inspect actual synthetic capture fixtures:

```sh
node --test tests/tooling-ghidra-bridge.test.mjs
```

That command registers exactly three tests, with no skipped integration test.
To additionally build the extension and create isolated synthetic Ghidra programs:

```sh
VN_GHIDRA_TEST_INSTALL=/opt/homebrew/opt/ghidra/libexec \
  node --test tests/tooling-ghidra-bridge.test.mjs
```

The opt-in command registers four tests. The Java harness constructs three
invented functions (add, diamond, countdown loop), decodes/decompiles them, checks
the real exported phi/edge/SSA graph, and checks exact-entry/hash/limit/transaction
refusals. It additionally verifies five direct file exports across all three
representation modes, exact byte hashes/counts, graph parity with inline capture,
private permissions, and exclusive publication (including a concurrent creation,
symlink/hardlink destinations and failed-capture cleanup). Temporary cache/settings
directories isolate it from the user's live
Ghidra. The instructions are never executed. The test harness is excluded from
the installable extension JAR.

For a reusable manual harness build, add `--with-harness` to the build command.
Run `vn.bridge.SyntheticExportCheck GHIDRA_INSTALL NEW_OUTPUT_DIRECTORY` with the
generated `classes` directory and installed Ghidra JARs on the Java classpath.
The opt-in Node test demonstrates this exact invocation without shell-generated
classpath quoting.

Validation on 2026-09-19: Java compilation and the actual synthetic integration
passed against Ghidra 12.1.3. After installation and CodeBrowser activation, the
live bridge health check reported both capabilities and `/v1/function/file`
exported Aokana `0x140095bb0` to ignored local evidence storage. The 9,042-byte
file had mode `0600`; its exact byte hash matched the compact receipt, and the
graph importer accepted its stable one-block HighFunction graph. No target code
was executed and the Ghidra program was not mutated or saved.
