# Synthetic Ghidra exports

These are actual `NativeExportBridge` outputs from three invented x86-64 functions
constructed in isolated, temporary Ghidra `ProgramDB` instances on 2026-09-19 with
Ghidra 12.1.3. They contain no game bytes or game-derived code. The harness decoded
and decompiled the instructions; it never executed them.

`test/vn/bridge/SyntheticExportCheck.java` defines the synthetic instruction bytes,
Windows x64 ECX input storage, EAX return storage, and exact function bodies. The
captures are preserved byte-for-byte, including capture timestamps. No metadata
was replaced with an invented saved-state claim: these temporary programs report
their observed dirty state and `savedState: "unverified"`.

| File | Synthetic behavior | Actual high graph |
| --- | --- | --- |
| `synthetic-add.json` | `value + 5`, int32 wrapping | 1 block, 3 ops |
| `synthetic-branch.json` | `(value > 0 ? value + 5 : value - 3) + 1` | 4 blocks, 9 ops, 1 phi |
| `synthetic-loop.json` | Signed positive countdown sum, wrapping int32 | 3 blocks, 13 ops, 3 phis |

All captures contain full decoded instructions, raw P-code, HighFunction SSA,
storage/type hints, byte hashes, exact CFG edge order, conditional edge roles,
and explicit phi input-to-predecessor associations. They are tooling regression
fixtures, not evidence about any commercial engine.

The capture used exporter source SHA-256
`0d83cef27353ce04775016724353e0ccd12749b5ccd840f1eb38cc862459e0cf`.
Rebuild with `--with-harness` and run `vn.bridge.SyntheticExportCheck` to create
fresh captures; see `docs/tooling/ghidra-bridge.md`.
