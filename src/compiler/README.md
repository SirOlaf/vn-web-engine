# Compiler infrastructure

`src/compiler/` holds the parts of a compiler that are not tied to one script language:
the NIF tree format, source positions and diagnostics. An engine that compiles a script
language (the Kirikiri TJS2 compiler in `src/engines/kirikiri/tjs2/` is the first) defines
a NIF dialect and writes each compiler stage as a NIF tree.

| File             | Contents                                                                  |
| ---------------- | ------------------------------------------------------------------------- |
| `nif/buffer.ts`  | `NifBuffer`: a NIF tree as a flat token stream; building and navigation   |
| `nif/pool.ts`    | `NifPool`: interned strings, pooled numbers, file names, packed positions |
| `nif/tags.ts`    | `NifTags`: the tag namespace of a dialect                                 |
| `nif/text.ts`    | NIF text form (nifspec 2027): `writeNif`, `writeNifTree`, `readNif`       |
| `source.ts`      | `SourceText` (offset → line and column), line-break normalisation         |
| `diagnostics.ts` | `Diagnostic`, `Diagnostics`                                               |

## NIF

NIF is the tree format of the Nimony compiler ([nifspec](https://github.com/nim-lang/nifspec),
[nimony](https://github.com/nim-lang/nimony)). A tree is a Lisp-like list of compound nodes
`(tag child …)` and atoms: identifiers, symbols (`x.3`), symbol definitions (`:x.3`), string,
char, integer, unsigned and float literals, and the empty node `.`. Tags and identifiers are
separate namespaces, so a dialect adds tags without reserving words. Every token carries a
source position.

Compiler stages communicate only through these trees. A pass reads one buffer and writes
another; it never mutates its input. This keeps every stage inspectable as text (with
positions), and leaves room for caching or incremental compilation keyed by a stage's tree.

### In memory

`NifBuffer` follows nimony's `nifcore` layout: a node is one tag token followed by its
children, and the tag token records the size of its subtree, so a subtree is skipped in
constant time and needs no closing token. Positions are plain indices:

```ts
for (let c = pos + 1, end = buf.end(pos); c < end; c = buf.next(c)) visit(c);
```

Three parallel `Uint32Array`s hold the token words (4-bit kind, 28-bit payload), the subtree
sizes and the positions. Strings live in the pool and are referenced by id. Integers of up to
27 bits are stored in the token; wider ones (64-bit and beyond) are pooled as `bigint`.
Floats are pooled. A position packs file, line and column into 32 bits, with a side table in
the pool for values that do not fit; `pool.unpack` returns `[file, line, column]`. Lines
count from 1, columns from 0.

Building: `open(tag, info)` returns the node's position and `close(pos)` fixes its size.
`openBefore(pos, tag, info)` opens a node whose first children are the trees already
written from `pos` on, for operands parsed before their operator. `copyTree` copies a subtree
from another buffer with the same pool (remapping tags by name if the registries differ).

Buffers that exchange subtrees share one `NifPool`. A pool only grows; one pool per engine
instance or per compilation are both valid choices.

### Text form

`writeNif` emits `(.nif27)` and the trees; `readNif` parses text back into a buffer. Line
information is a suffix: `@c,l` gives column and line differences (base 62, `~` for
negative) to the enclosing node, `@c,l,file` gives absolute values for the root, for a
change of file, and below a node without position. A token without suffix has no position.
Strings are escaped per byte of their WTF-8 form, so any JavaScript string, including lone
surrogates, survives a round trip. Comments (`#…#`) are skipped on reading; unknown directives
are kept as text and otherwise ignored.

## Dialects

A dialect is a `NifTags` instance created from a fixed list of tag names; `tags.id.<name>`
gives constant ids for switching. Document every node shape of a dialect next to the
compiler that produces it, per stage.

## Diagnostics

Passes report `Diagnostic`s (severity, stable code, message, file, line, column) into a
`Diagnostics` list and continue where the language allows; a result is usable when
`errorCount` is 0. Codes name the native condition they correspond to where there is one.
