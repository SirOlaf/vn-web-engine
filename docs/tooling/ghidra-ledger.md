# Exact-address Ghidra ledger

`tools/native-audit/ledger.mjs` compares reviewed function expectations with a
fresh, read-only Ghidra snapshot and prints a machine-readable receipt. It does
not rename, analyze, save, or execute native code. It uses only Node built-ins;
the exporter uses Java and Gson already distributed with Ghidra.

## Commands

From the repository root, this synthetic example succeeds:

```sh
node tools/native-audit/ledger.mjs verify \
  --ledger tools/native-audit/examples/ledger-synthetic.json \
  --snapshot tools/native-audit/examples/ledger-synthetic.snapshot.json
```

Add `--receipt /absolute/path/to/new-receipt.json` to preserve the JSON result.
Output files are created exclusively: existing files, symlinks, and hard-link
aliases are never overwritten. Standard output still contains the receipt.

| Exit | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| 0    | All expectations match the supplied live and persisted observations. |
| 1    | Missing, inconsistent, or mismatched evidence; inspect `findings`.   |
| 2    | CLI, input JSON, filesystem, or output-creation error.               |

Each verification receipt hashes the **exact input file bytes**, records the
capture time, and identifies its scope as `offline-snapshot-at-capture-time`.
It does not attest to Ghidra's state after that capture. The two synthetic example
files demonstrate the format only; they are not native evidence.

## Capturing a snapshot

The exporter is `tools/native-audit/ghidra/NativeLedgerExport.java`. Run it in the
already-open, explicitly selected program after the owner has finished any
transaction. It requires arguments in this exact order:

```text
/project/program-path executable-sha256 language-id 0ximage-base 0xentry [0xentry ...]
```

For the already named Aokana presentation wrapper:

```text
/aokana.exe f585e28f79923b8aa487d8690165e45ce3377c7e1b8381d3b75c659c7e933d7a x86:LE:64:default 0x140000000 0x1400de050
```

The existing MCP `run_script_inline` operation accepts the entire Java source as
`code`, the string above as `args`, and **`program: "/aokana.exe"`**. Never omit
that program argument or replace it with the currently active program. The script
independently checks the selected project's exact path, executable hash, language,
and image base against the arguments before inspecting a function. Alternatively,
add the project-local `ghidra` directory to Ghidra's Script Manager and run
`NativeLedgerExport.java` with the same arguments; the exporter requires script
arguments and does not guess a target or prompt for one.

Script Manager's ordinary Run button does not supply arguments. A small Java
launcher in that same directory can call the exporter with explicit arguments:

```java
import ghidra.app.script.GhidraScript;
public class CaptureReviewedLedger extends GhidraScript {
    public void run() throws Exception {
        end(true); // Close this launcher's own untouched wrapper as well.
        runScript("NativeLedgerExport.java", new String[] {
            "/aokana.exe",
            "f585e28f79923b8aa487d8690165e45ce3377c7e1b8381d3b75c659c7e933d7a",
            "x86:LE:64:default", "0x140000000", "0x1400de050"
        });
    }
}
```

The exporter prints one compact `NATIVE_LEDGER_SNAPSHOT_JSON=` line. Preserve
the captured script **text**, then extract its JSON:

```sh
node tools/native-audit/ledger.mjs extract \
  --capture /absolute/path/to/ghidra-script-output.txt \
  --output /absolute/path/to/new-snapshot.json
```

`extract` rejects zero or multiple snapshot markers. With MCP, save the decoded
script output text (the `result` text inside the tool response), not an escaped
JSON envelope containing it. Extraction does not verify the snapshot; run
`verify` separately. If script execution is disabled, retain the rejection and
leave verification pending. Enabling arbitrary-script execution is a separate
Ghidra configuration change; this tooling never enables it automatically.

## What the exporter records

For every requested address it calls `FunctionManager.getFunctionAt` directly,
requires that returned function's entry to be identical, and reads the complete
`Function.getBody()` address set. It never substitutes `getFunctionContaining`,
name search results, cached decompilations, min/max bounding spans, or prior prose.
It records fully qualified names (`getName(true)`). The verifier requires exactly
one readback per expected address in each observation; missing, duplicate, and
unexpected addresses all reject the receipt.

Addresses are lowercase `0x` hexadecimal strings with no unnecessary leading
zeroes. Java uses unsigned address formatting; Node uses `BigInt`. Numeric JSON
addresses are rejected. This version supports the default, non-overlay,
byte-addressed memory space up to 64 bits. It rejects body ranges in other spaces.

Body ranges are ascending, inclusive, disjoint, and maximally merged. Each has a
byte count and SHA-256. `bodySha256` is the SHA-256 of **all range bytes concatenated
in ascending address order, without gap bytes**. The verifier compares both the
hashes and the exact range layout. The script streams hashes in 64 KiB chunks,
limits a function body to 16 MiB, and emits no native bytes or disassembly.

The script reads live state before and after collection. Both states must report
`changed: false` and `transactionOpen: false`, and their modification counter,
domain-file ID, persisted modification time, version, and path must remain equal.
The decimal counters and times are strings to avoid integer precision loss.

To establish saved state, it opens the selected domain file with
`getImmutableDomainObject(consumer, DomainFile.DEFAULT_VERSION, monitor)` and
repeats every exact-address lookup against that **separate persisted instance**.
The verifier requires that instance to be immutable and unchanged, with matching
binary identity, source-file stamp, entries, names, body ranges, and hashes.
The instance is released in `finally`. The script does not save the live program.
A dirty flag or a message saying "saved" cannot replace this readback. Ghidra's
[DomainFile API](<https://ghidra.re/ghidra_docs/api/ghidra/framework/model/DomainFile.html#getImmutableDomainObject(java.lang.Object,int,ghidra.util.task.TaskMonitor)>)
defines the independent immutable open; an incompatible database version fails
the export rather than being upgraded.

Ghidra normally starts an empty transaction around a Java script. The exporter's
first operation is `end(true)`, which closes its own untouched wrapper before
observing the program. In Ghidra 12.1.3, `FlatProgramAPI` keeps that transaction ID
in a private instance field; nested transactions get separate entry IDs, and
ending one does not close other active entries. If another transaction remains,
the exporter stops. It never starts a transaction itself or forces/rolls back
another owner's transaction. The ordinary wrapper behavior is visible in
[GhidraScript](https://github.com/NationalSecurityAgency/ghidra/blob/Ghidra_12.1.3_build/Ghidra/Features/Base/src/main/java/ghidra/app/script/GhidraScript.java)
and [FlatProgramAPI](https://github.com/NationalSecurityAgency/ghidra/blob/Ghidra_12.1.3_build/Ghidra/Features/Base/src/main/java/ghidra/program/flatapi/FlatProgramAPI.java).

## Expectation and observation formats

The ledger uses `schema: "native-address-ledger/v1"`:

```json
{
  "schema": "native-address-ledger/v1",
  "identity": {
    "programPath": "/aokana.exe",
    "executableSha256": "f585e28f79923b8aa487d8690165e45ce3377c7e1b8381d3b75c659c7e933d7a",
    "languageId": "x86:LE:64:default",
    "imageBase": "0x140000000"
  },
  "functions": [
    {
      "address": "0x1400de050",
      "entryAddress": "0x1400de050",
      "name": "AokanaNative90_01_SetPresentationEnabled",
      "bodyRanges": [
        {
          "start": "0x1400de050",
          "end": "0x1400de066",
          "byteLength": 23,
          "bytesSha256": null
        }
      ],
      "bodyByteLength": 23,
      "bodySha256": null
    }
  ]
}
```

This example intentionally has unknown hashes and **cannot pass**. Pin expected
boundaries, names, and hashes from a reviewed exact-entry/full-body inspection.
Do not copy an unreviewed current snapshot into an expectation and present its
self-comparison as new native research. After any authorized rename, obtain a
fresh export to compare with the pinned expectations.

The snapshot uses `schema: "ghidra-ledger-snapshot/v1"` and contains `identity`,
`capturedAt`, exporter provenance, `errors`, `stateBefore`, `stateAfter`, live
`readback`, and `savedReadback`. Each readback row has `address`, the literal
`lookup: "FunctionManager.getFunctionAt"`, and a `function` object with the same
entry/name/body fields as the ledger. The complete synthetic snapshot provides
an executable format example. Additional descriptive fields are ignored; all
required evidence is validated. Receipt status is `verified`, `rejected`, or
`error`; findings have stable `code`, `path`, and explanatory `message` fields.

The snapshot is an unsigned observation artifact, not an authenticated proof of
who ran Ghidra. Trust its capture source and retain the input hashes in review
receipts. The executable hash is Ghidra's imported `getExecutableSHA256()`
attribution; it is not a new hash of the executable currently at its old disk
path. Body hashes identify the bytes actually stored in the Ghidra program.

## Current Aokana capture and validation

Read-only MCP calls on 2026-09-19 confirmed `/aokana.exe`,
`x86:LE:64:default`, base `0x140000000`, the executable SHA-256 above, and the
already named `0x1400de050` presentation wrapper with reported body
`0x1400de050..0x1400de066`. The inline-script API returned
`Script execution disabled` because `GHIDRA_MCP_ALLOW_SCRIPTS` is not enabled.
No exporter ran, no save state was inferred, and no Ghidra name/save was changed.

`tools/native-audit/examples/ledger-aokana.pending.json` preserves the incomplete
expectation. `ledger-aokana.observations.json` preserves only the actual metadata
observed and the missing evidence; its distinct partial-observation schema is
rejected by the verifier. The earlier handoff's save prose remains historical
context, not a current machine-verifiable save claim.

Focused ordinary deterministic tests:

```sh
node --test tests/tooling-ghidra-ledger.test.mjs
```

The tests use synthetic metadata and invented bytes that are hashed but never
executed. They cover disjoint high-address bodies, identity and name drift,
containing-function substitution, missing/duplicate observations, persisted
readback, capture races, receipt hashes, exit statuses, and output preservation.
The Java exporter was compiled against installed Ghidra 12.1.3 jars. Live script
execution remains unvalidated because the MCP script gate is disabled.
