# Native slot manifest and partial assembly audit

`tools/native-audit/workspace/aokana-slots.json` is the local, ignored,
binary-qualified accounting manifest for Aokana's 840 extension-bank slots.
Keep this work log in `tools/native-audit/workspace/`; it is not pushed with source.
`tools/native-audit/slots.mjs` is a
reusable static auditor. It parses source through the existing TypeScript 7 AST
API; it never imports or calls a game service factory, constructs a native bank,
runs a native probe, or runs tests. No dependency was added.

The manifest separates five questions for each slot:

| Field                  | Meaning of the initial state                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ownership`            | Explicit wrapper owner imported from the complete ownership partition. This does not assign ownership of every dependency used by a wrapper.     |
| `nativeEvidence`       | The pointer is attested by its complete native table hash. Exact entry/body review, naming, readback and save receipts have not been imported.   |
| `source`               | A returned slot declaration was recognized by the bounded AST projection, or no declaration was observed. This is not implementation acceptance. |
| `focusedTests`         | References to a factory in test files are recorded separately. Slot exercise, test review and current accepted receipts remain unreviewed.       |
| `aggregateIntegration` | No production constructor was observed, or an unverified constructor candidate was observed. Neither establishes startup integration.            |

The initial schema intentionally refuses invented reviewed/passed/complete state
labels. Evidence-backed promotion needs a verifier and a schema extension; editing
a state string is not sufficient. Historical accepted slices, including boundary
19, have not been converted into current hash-qualified receipts. The static source
count includes gated or unfinished factories, including the nine window factories
excluded by the handoff. It must not be described as accepted implementation coverage.

## Exact inventory and ownership

Addresses use canonical lowercase hexadecimal RVA strings. The executable SHA-256
and image base are stored once at the manifest root and qualify every row. Bank/slot
IDs, such as `90:00`, are lowercase hexadecimal bytes. Slot order is canonical.

The auditor compares every manifest `(slot, RVA)` pair with the tracked
`AOKANA_NATIVE_SLOT_ADDRESSES` literal in `native/inventory.ts`, verifies its source
hash, and reconstructs all eleven original 256-entry pointer tables. Each table
uses unsigned 64-bit little-endian virtual addresses and zero for every absent slot.
Their SHA-256 values match the imported native evidence. This checks every hole,
address and occupied slot; it does not merely compare a total of 840.

The imported provenance is preserved in the manifest:

- `aokana-vm-evidence.json`, investigation date 2026-09-12: binary identity and all
  eleven complete table hashes, table addresses, dispatcher addresses and counts.
- `aokana-resumption-2026-09-12.md`, “Complete ownership partition”: Runtime 208,
  Storage 321, Opcodes 311, including the exact Bank 80 lists and whole-bank rules.
- `aokana-scene-delegation.md`, Banks 90–92: the exact 342-slot partition, comprising
  Runtime 126, Storage 160 and Opcodes 56.

Those investigation files are ignored in this repository. Their imported hashes,
section names, excerpts, counts, and complete ownership rules are embedded in the
local manifest. Audits do not need the ignored files or a Ghidra connection.
The import does not claim a fresh read from the executable or current Ghidra state.

## Commands

Run from the repository root:

```sh
node tools/native-audit/slots.mjs audit tools/native-audit/workspace/aokana-slots.json --out /tmp/aokana-slot-audit.json
node tools/native-audit/slots.mjs audit tools/native-audit/workspace/aokana-slots.json --require-integrated
node tools/native-audit/slots.mjs docs tools/native-audit/workspace/aokana-slots.json --out docs/tooling/native-slots.md
node --test tests/tooling-native-slots.test.mjs
```

`audit` emits a deterministic JSON receipt with binary identity, observed counts,
missing source slots, duplicate declarations, factories referenced only from tests,
constructor candidates, and errors/warnings. Exit 0 means that static observations
match the manifest. It always includes `complete: false`. Exit 1 reports invalid
data or source/reference drift. `--require-integrated` exits 2 when observations
are consistent but complete integration is unverified; it cannot pass in this
version. A failure to satisfy that gate is an expected result for the current title.
Receipt files use exclusive creation: choose a new `--out` path for each audit.
Existing receipts and audit inputs cannot be overwritten by receipt output.

`docs` replaces only the generated block below when the destination contains its
markers, and refuses to write counts if the audit fails. `--root DIR` selects a
repository root for audit input; output paths are explicit CLI paths.
Existing documents without markers are preserved. Refresh may replace its own
manifest or create a new file; it cannot overwrite other existing files. Symlinked
source roots/entries and symlinked output files are rejected, and source-root
containment is checked against the canonical repository path.

After reviewing a source change, refresh the observed declarations and references:

```sh
node tools/native-audit/slots.mjs refresh tools/native-audit/workspace/aokana-slots.json --out /tmp/aokana-slots-next.json
```

Review that JSON diff before replacing the local manifest. Refresh does not
update ownership rules, native table evidence, or review/acceptance states. It
refuses inventory/address mismatches. A missing factory is recorded as missing
source in the new observations; refreshing is not acceptance of its removal.

## Partial assembly plans

The auditor can check a proposed set of factory slots before there is a complete
production aggregate. Supply a JSON plan via `--aggregate PLAN.json`:

```json
{
  "schemaVersion": 1,
  "binarySha256": "f585e28f79923b8aa487d8690165e45ce3377c7e1b8381d3b75c659c7e933d7a",
  "entries": [
    {
      "slot": "90:00",
      "rva": "0xde070",
      "owner": "runtime",
      "factory": "src/engines/buriko/games/aokana/native/group-90-display-base.ts#createGroup90DisplayBase"
    }
  ]
}
```

Plans are declarative review inputs. The audit reports missing slots, duplicate
slot entries, wrong wrapper owners, wrong RVAs, unregistered slots, and a factory
that does not declare the supplied slot. No plan means `no-aggregate-supplied`;
an empty supplied plan means `partial-plan`. Even all 840 valid declarations yield
`all-slots-declared-unverified`, never complete integration. Actual shared owner
identity, factory arguments, publication, worker lifecycle and startup still need
separate verification.

## Static analysis limits

Factory discovery currently recognizes directly exported functions returning the
configured `SlotDefinition[]` type, including a `readonly` return annotation.
Exported `const` declarations typed as one slot or a slot array are also recognized
and retain a distinct `constant-slot` or `constant-array` provider kind. The JSON
`factories` collection and slot reference lists can reference any of these provider
kinds; report counts distinguish factories from static providers. A plan's `factory`
field names that exported provider, whether it is callable or a constant.
Supported metadata syntax is literal objects,
literal arrays and spreads, local `const` tuple arrays with a one-parameter arrow
`.map`, literal-object arrow helpers, and local single-statement `array.push`
helpers. Runtime handler expressions remain opaque. Other syntax is reported as
unresolved when encountered in a recognized factory; it is never executed to
obtain a count. Conditional behavior and handler bodies are not proven.
When a returned array contains an unknown spread, directly written neighboring
slot objects remain observable, while the spread is recorded as unresolved.
Nothing is inferred about slots inside that spread.

Reference discovery records syntactic named imports, namespace/module imports and
direct re-exports. The Aokana configuration maps test imports from `dist` to `src`
without requiring a build. An unused test import is still only an observation.
Indirect barrel chains, dynamic imports, computed construction, aliases created
inside function bodies, and same-file call graphs are not resolved. Constructor
candidates use direct imported constructor syntax; their presence does not prove
reachability, and their absence is not a general program proof. Test-only means
only test references were observed within these documented limits.

Every observed factory and reference carries an exact source-file hash. Changes
to a factory body, its declarations, its test imports, or detected production
construction invalidate the saved observations. Dependency/lower hashes belong
in focused validation-boundary receipts; this tool does not claim to verify their
behavior.

The focused tooling tests are deterministic parser and accounting tests. They use
synthetic TypeScript text and JSON in temporary directories and read the tracked
pointer inventory. The full 840-slot check also reads the ignored local manifest
when it is present. They check table holes/hashes, supported/unsupported syntax,
references, source drift, omitted/duplicated slots, owner/address/factory mismatch,
and the refusal to turn a complete plan into integration success.

<!-- BEGIN GENERATED NATIVE SLOT COUNTS -->
Binary SHA-256: `f585e28f79923b8aa487d8690165e45ce3377c7e1b8381d3b75c659c7e933d7a`.

The manifest contains **840 native slots**. Ownership: runtime 208, storage 321, opcodes 311.

| Bank | Native slots | Source declarations observed | Provider referenced by tests | Accepted focused tests | Verified aggregate slots |
| --- | ---: | ---: | ---: | ---: | ---: |
| 7F | 12 | 12 | 12 | 0 | 0 |
| 80 | 182 | 167 | 160 | 0 | 0 |
| 81 | 92 | 92 | 88 | 0 | 0 |
| 90 | 187 | 181 | 180 | 0 | 0 |
| 91 | 109 | 100 | 99 | 0 | 0 |
| 92 | 46 | 41 | 41 | 0 | 0 |
| A0 | 30 | 29 | 29 | 0 | 0 |
| B0 | 68 | 68 | 43 | 0 | 0 |
| C0 | 45 | 45 | 45 | 0 | 0 |
| D0 | 58 | 58 | 58 | 0 | 0 |
| E0 | 11 | 11 | 11 | 0 | 0 |

230 exported factories and 3 static declaration providers were found; 16 factories and 0 static providers have references only in tests. 36 slots have no recognized source declaration. 7 slots have multiple source declarations.

Aggregate state: `no-aggregate-supplied`; production construction candidates: 0. Body-review, focused-test acceptance, and runtime integration are unreviewed in this manifest. These zero acceptance counts describe imported evidence, not a denial of historical test receipts.
<!-- END GENERATED NATIVE SLOT COUNTS -->
