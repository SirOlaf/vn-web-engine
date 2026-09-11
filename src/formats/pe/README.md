# PE cursor resources

```ts
import {PeCursorReader} from './formats/pe/cursor.js';

// Read /game/Game.exe through the host filesystem at runtime, then pass its bytes.
const reader = new PeCursorReader(executableBytes);
const inventory = reader.list();
const active = reader.read(108);
const normal = reader.read(111);
```

`PeCursorReader` accepts a `Uint8Array` containing an on-disk PE32 or PE32+
executable (including a subarray with a nonzero byte offset). Construction parses
the resource tree synchronously. Keep the input unchanged for the reader's
lifetime; resource payloads are views into it. No filesystem, DOM, or game-specific
dependency is used by the parser.

`list(): PeCursorEntry[]` returns `{ kind: 'static' | 'ani', id: number | string,
language: number }` for every RT_GROUP_CURSOR (12) and RT_ANICURSOR (21) language
variant. Listing validates the PE resource tree but does not decode cursor data.

`read(id: number | string, language?: number)` returns:

- `undefined` if the ID has no cursor group or ANI resource.
- `PeStaticCursor`: `{ kind: 'static', id, language, bytes, images }`. `bytes` is an
  independent `Uint8Array` containing a complete multi-image CUR file. Every image
  has `{ resourceId, language, width, height, hotspotX, hotspotY, bitDepth,
encoding: 'dib' | 'png' }`. Dimensions and hotspots are intrinsic pixels.
- `PeAnimatedCursor`: `{ kind: 'ani', id, language, bytes }`, with an independent
  copy of the original RIFF/ACON resource. Only the RIFF envelope and top-level
  chunk bounds are validated. ANI animation is reported, not decoded or converted.

The optional language selects an exact LANGID, then neutral (0). With no language,
neutral is preferred, then the lowest LANGID. A group's referenced RT_CURSOR image
must match the selected group language or be neutral; other languages are never
silently substituted. Unavailable languages, ambiguous static/ANI IDs, malformed
data, limit violations, and unsupported encodings throw `Error`.

For CSS, put static CUR bytes in an `image/x-icon` Blob, create an object URL, and
use `url("...") , auto` (without explicit CSS hotspot coordinates). The CUR
directory contains each image's original hotspot. The caller owns URL lifetime
and revocation. The returned `Uint8Array` can be copied with
`new Uint8Array(cursor.bytes)` if the host's Blob typing requires an explicitly
ArrayBuffer-backed view. Multi-image output retains source group order.

`await reader.findByHash(sha256)` returns every matching cursor group/language.
`await reader.readByHash(sha256)` returns the first matching cursor (or
`undefined`), with independent copies of its bytes and image metadata. The hash
is 64 hexadecimal digits, case insensitive. SHA-256 covers the reconstructed
CUR bytes, including all images, masks and hotspots; for ANI it covers the
original RIFF bytes. PE IDs, internal image references, language IDs and file
layout are excluded from CUR identity. Image order and encoding remain significant.
This finds byte-identical content after resource renumbering; it is not a visual
similarity search and does not match edited or re-encoded artwork.

The reader builds and caches an in-memory content index on its first hash search;
concurrent and subsequent searches share it. As with `read`, keep the source
executable unchanged for the reader's lifetime. Malformed or unsupported cursor
entries fail index construction explicitly. Hashing uses Web Crypto (available
on localhost and HTTPS).

`parsePeResources(bytes)` in `resources.ts` is the generic lower-level API. It
returns `{ type, id, language, codePage, bytes }[]`, with payload views, including
non-cursor resources. Named type/name entries are supported. Language leaves must
be numeric. Resource-directory offsets are relative to the resource root; payload
RVAs are mapped through file-backed sections or headers, never virtual zero-fill.

## Supported static images and bounds

DIB extraction supports BITMAPCOREHEADER (12) and uncompressed BI_RGB
BITMAPINFOHEADER/V4/V5 (40/108/124), with 1/4/8/16/24/32-bit pixels, palettes,
DWORD-padded rows, and complete XOR/AND planes. Embedded profiles, compression,
bitfields, top-down DIBs, missing masks, and dimensions outside 1–256 are rejected
explicitly. PNG payloads retain compressed bytes; the reader validates chunk
bounds, CRCs, IHDR, basic palette/data ordering, and IEND. PNG decompression and
pixel-stream validation belong to the browser.

Limits: 512 MiB executable, 96 sections, 64 MiB resource directory or individual
resource, 4,096 directories, 65,536 entries, 4,096 UTF-16 units per name and 1 Mi
units across names, 256 images per group, 16 MiB per extracted cursor. Directory
depth is fixed at type/name/language; cycles, shared directories, duplicate keys,
overlapping file-backed RVA ranges, truncation, and out-of-range offsets fail.

Cursor resources prepend hotspot words to the image; CUR files instead put them
in the file directory. See Microsoft's [resource image format description](https://devblogs.microsoft.com/oldnewthing/20231025-00/?p=108925).

## Local Game.exe inventory

Verified by reading the user-owned executable locally, without writing assets:

| Group | Role supplied by caller | RT_CURSOR | LANGID | Dimensions | Hotspot | Encoding          | Resource bytes | CUR bytes |
| ----- | ----------------------- | --------- | ------ | ---------- | ------- | ----------------- | -------------- | --------- |
| 108   | active                  | 1         | 1041   | 32×32      | (9, 2)  | 24-bit BI_RGB DIB | 3,244          | 3,262     |
| 111   | normal                  | 2         | 1041   | 32×32      | (9, 2)  | 24-bit BI_RGB DIB | 3,244          | 3,262     |

Both groups are 20 bytes, contain one image, and record width 32 / combined height 64. Each image has a 4-byte hotspot prefix, 40-byte DIB header, 3,072-byte XOR
bitmap, and 128-byte AND mask. Each emitted CUR has a 22-byte directory/header
and the unchanged 3,240-byte DIB payload. No RT_ANICURSOR (21) or RT_ANIICON (22)
resources were present. Game IDs and role assignment are not embedded in the API.

Synthetic coverage is in `tests/pe-cursor.test.mjs`; run that test alone after
compiling the PE modules. Local verification additionally compared both emitted
DIB/mask payloads byte-for-byte with their source resources and checked CUR
hotspot fields. No visual verification or full test suite is required here.
