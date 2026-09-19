# Small native export MCP

`tools/native-mcp/cli.mjs` is a dependency-free Node stdio MCP with two tools:
`native_bridge_health` and `native_export_function`. It talks only to the dedicated
[Ghidra export bridge](ghidra-bridge.md) on `127.0.0.1:18493`. Exports are written
directly by Ghidra to a new file on the same host. MCP returns a compact receipt;
assembly and graphs never pass through its stdout. It has no script, rename,
program-save/mutation, arbitrary HTTP URL, or game execution operation.

The implementation uses the
[2025-11-25 initialization lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle),
[newline-delimited stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports),
and [tools protocol](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
It negotiates that version explicitly; it does not advertise the later stateless
protocol, resources, prompts, sampling, or tasks. Tool failures use `isError`;
protocol failures use JSON-RPC errors. Health remains available while one bounded
export runs. Cancellation aborts the client request; Ghidra may finish the capture
and publish its file before accepting another export. After a disconnect or
timeout, inspect the requested output path before retrying; an existing artifact
is never replaced.

Start the bridge in Ghidra first, then use the CLI:

```sh
node tools/native-mcp/cli.mjs health
node tools/native-mcp/cli.mjs export file-request.json
node tools/native-mcp/cli.mjs serve
```

An MCP client launches `node` with absolute arguments
`/Users/daniel/vn-web-engine/tools/native-mcp/cli.mjs`, `serve`. A different local
bridge port can be selected with `--port PORT` before the command. No host or URL
override is supported. The stdio server writes only JSON-RPC messages to stdout.

Example file request, also used as the MCP tool's arguments (replace the exact
entry and choose a new path in an existing directory):

```json
{
  "schema": "ghidra-function-file-request/v1",
  "binary": {
    "programPath": "/aokana.exe",
    "executableSha256": "f585e28f79923b8aa487d8690165e45ce3377c7e1b8381d3b75c659c7e933d7a",
    "languageId": "x86:LE:64:default",
    "imageBase": "0x140000000"
  },
  "entryAddress": "0x140095bb0",
  "representation": "both",
  "outputPath": "/absolute/existing/evidence/aokana-0x140095bb0.json"
}
```

For older capture requests with `schema: "ghidra-function-request/v1"`, the CLI
also accepts `export capture-request.json /absolute/path/NEW-function.json`.
It adds the destination and uses the same `/v1/function/file` route. Neither form
downloads the graph or writes it through Node. Both print only the receipt.

The `ghidra-function-file-receipt/v1` receipt contains the canonical path, file
byte length and SHA-256, binary/function identity and body hash, representation
counts, exporter version and live-state summary. MCP returns it as structured
content and matching JSON text. The client rejects unexpected receipt fields,
identity/path mismatches, invalid counts and responses larger than 64 KiB.
The export tool is annotated as a non-destructive file write; health is read-only.

The `.json` destination must be absolute and its parent must exist. Parent
symlinks are resolved before the request. Ghidra streams the complete capture
into a private temporary file, syncs it, then publishes it through an exclusive
hard link. Existing files, symlinks and concurrent creations cause refusal.
Temporary files are removed after publication or failure. Filesystems without
hard-link support fail rather than fall back to overwriting. Graph construction
still uses the exporter's bounded in-memory representation.

The artifact retains `ghidra-function-export/v1`, so the existing graph importer
reads it directly. The receipt's SHA-256 covers the exact UTF-8 bytes, including
the final newline; it differs from the import review plan's canonical-JSON hash.
The client validates the receipt without reopening the large artifact. Downstream
consumers can verify the file hash before import. These checks do not prove native
equivalence or saved-state persistence; graph/ledger validation still applies.

The original MCP clone remains available for comparison. Its
`GHIDRA_MCP_ALLOW_SCRIPTS` switch is read by the Java Ghidra process at startup;
changing only a Python/client environment does not enable it in a running Ghidra
process. This bridge uses a fixed Java export service that reads program state and does not
depend on that setting.
