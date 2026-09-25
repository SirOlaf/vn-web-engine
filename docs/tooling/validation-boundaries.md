# Reviewed validation boundaries and handoff snapshots

`tools/native-audit/boundary.mjs` binds an explicitly reviewed selection of ordinary deterministic tests to exact repository input hashes. It runs each named file separately, requires the reviewed number of passing tests in each, and writes an accepted or rejected receipt. It does not discover a suite or invoke `npm test`.

This is a review and change-control guard, not a sandbox or a proof that arbitrary JavaScript is safe. Review tests, their reachable helpers, and their selected source roots before capture. Select every relevant source directory and add dependencies outside those directories to `extraInputs`. Hashes attest bytes; they cannot attest the quality of a review. Local receipts are unsigned records.

## Capture and execute

A review definition has this shape:

```json
{
  "schema": "native-validation-boundary/v1",
  "id": "my-reviewed-boundary",
  "safetyClass": "ordinary-deterministic",
  "reviewedBy": "Reviewer attribution",
  "reviewNotes": "What was reviewed and why the selected tests are ordinary and deterministic.",
  "build": "none",
  "timeoutMs": 30000,
  "sourceRoots": ["tools/native-audit"],
  "extraInputs": [],
  "tests": [{"path": "tests/tooling-validation-boundary.test.mjs", "expectedTests": 6}]
}
```

After review, capture a new manifest, then check or run it:

```sh
node tools/native-audit/boundary.mjs capture /path/to/review.json /path/to/manifest.json
node tools/native-audit/boundary.mjs check /path/to/manifest.json
node tools/native-audit/boundary.mjs run /path/to/manifest.json /path/to/receipt.json
```

Run commands from the repository root. Output files must be new, outside the pinned source roots, and distinct from inputs. Keep accepted manifests and receipts under `docs/tooling/boundaries` so a normal checkout preserves them. Do not recapture merely to clear a stale-hash failure: review the changed inputs first.

The runner permits 1–20 explicit `.test.mjs` paths beneath `tests/`. It refuses globs, directories, duplicate tests, paths outside the checkout, symlinked inputs, empty selections and other safety classes. It pins source files recursively within the declared roots, each selected test, explicit extra inputs, `package.json`, `package-lock.json`, and `tsconfig.json`. Adding or removing a source file also invalidates the manifest. Supported source extensions are `.ts`, `.js`, `.mjs`, `.cjs`, `.json`, `.java`, `.py` and `.lock`; other required files need explicit `extraInputs`.

The build-policy check uses the installed TypeScript AST API to distinguish actual import/export/URL expressions from synthetic code strings in parser tests. It does not evaluate those strings. Computed paths and indirect helpers remain part of the source review obligation.

For tests that import built runtime modules, use `"build": "typescript"` and include the entire `src` tree in `sourceRoots`. The initial build profile requires the repository's explicit `src/**/*.ts` to `dist` layout without inherited configs, project references, explicit file lists, excludes or bundled output. The runner invokes the installed TypeScript CLI with emission enabled, incremental compilation disabled, and an emitted-file inventory. Every source module must have a freshly emitted JavaScript module; orphaned or missing modules in `dist` reject the boundary. It records output hashes and rechecks them around tests. The installed toolchain remains a trusted prerequisite; pinning the lockfile does not authenticate every installed package byte. Build output is not independent native evidence.

The working checkout on September 19 contains historical and performance-baseline JavaScript under `dist` beyond the current 608 source modules. This tool does not delete those files. Its runtime build gate will refuse that mixed output tree; use a fresh checkout/build tree before capturing such a boundary. The tooling-only boundary uses `build: "none"` and never consumes `dist`.

Each child command uses fixed argument arrays without a shell. Node preload/search/coverage/test-context environment overrides are removed. Input hashes are checked before execution, before each test file, and afterward. Nonzero exits, timeouts, incomplete or ambiguous TAP summaries, mismatched counts, skipped/todo/cancelled tests, and source drift prevent acceptance. A receipt records command arguments, exits, output hashes, Node version, timing, manifest hash, source-hash digest and per-file totals.

`ordinary-deterministic` is the permitted review class, not an automated behavior classification. For Aokana, retain the handoff's restriction against native probes, game/media runs, screenshots, and allocation/lifetime defect reproducers. Metadata validation tests for these tools are unrelated to native allocation behavior.

## Handoff snapshot

```sh
node tools/native-audit/snapshot.mjs
node tools/native-audit/snapshot.mjs /path/to/manifest.json /path/to/receipt.json /path/to/snapshot.json
node tools/native-audit/snapshot.mjs --slots tools/native-audit/workspace/aokana-slots.json
```

The snapshot reads the current Git branch, HEAD, tracked/untracked changes and ignored investigation-document count. It validates an optional receipt against its exact manifest, input digest, commands and expected test results, then checks whether the source and compiled-output hashes still match the checkout. Historical acceptance and acceptance for the current checkout are separate: a later source or build-output change leaves the receipt historical and validation stale. Snapshot output uses the same canonical-path and source-root exclusions as the boundary runner.

Without a receipt, the snapshot records pending validation rather than inferring acceptance from prose. Append `--slots tools/native-audit/workspace/aokana-slots.json` to include a fresh static slot audit with missing source/aggregate slots, test-only factory counts, construction candidates and any observation drift. The slot manifest lives in the ignored local workspace and is not pushed. Without that option, integration is explicitly unassessed. Passing selected tests does not establish a complete native bank or playable startup. Snapshot generation neither stages nor commits files and never changes the Git checkout.
