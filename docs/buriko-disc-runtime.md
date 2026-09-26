# Buriko disc runtime view

Selecting a Buriko DVD folder mounts a browser runtime view directly over the
selected file sources. No installation copy, native installer execution, archive
rewrite, or browser-storage import is required. Directory handles and file/Blob
sources retain their ordinary range-read behavior.

Disc detection requires a root `<stem>ForInstalling.exe` and matching
`<stem>.hvl`. It does not inspect a game title or hardcode a disc marker name.
Folders without that pair expose their complete selected tree as before.

The disc view exposes all files named by the HVL catalog, the catalog itself,
and the selected main interpreter. Unlisted DVD files remain outside `/game`,
including installer archives, setup programs, DirectX redistributables, and
disc-only markers. The selected originals remain available to installation
selection and handle/cache restoration. Restoration repeats catalog validation
and creates the same source view. Normal persistent game writes continue through
the shared filesystem overlay; the game's save identity is unchanged.

HVL is an integrity catalog, **not an installation manifest**. This explicit
browser mounting policy does not reproduce installer scripts, registry writes,
shortcuts, or every file a native installer can create. An unlisted resource
needed by another game's runtime requires extending the installation metadata
policy with evidence from that game; it must not be guessed from its extension
or silently copied from the DVD. Selecting a complete installed folder continues
to expose such additional files without applying the disc policy.

`src/formats/buriko/hvl.ts` reads both native catalog versions: `BHV_____`
contains 64-byte records with 56-byte CP932 filename fields; `BHV_V2__` contains
256-byte records with 248-byte filename fields. Both end each record with an
8-byte little-endian checksum. Browser inspection reads only the 16-byte header
and bounded table, with a maximum of 65,536 records. It validates terminated
filenames and table bounds, but does not hash multi-GB resource files during
selection. Native installation checksum behavior remains in its existing owner.

`src/engines/buriko/installation-view.ts` normalizes Windows separators,
rejects absolute paths, traversal, ambiguous filename components and duplicate
case-insensitive entries, and requires every catalog file to exist. The catalog
must include `system.arc`. Projection returns the original file records and
sources for the existing `SourceFileSystem`; it introduces no platform filesystem
adapter.

`ui/runtimes/buriko-installation.ts` selects the main interpreter and exposes
the projected runtime records. `ui/runtimes/buriko.ts` uses those records for
fresh selection and cached restoration while retaining the raw selection for
the shared installation controls. `tests/buriko-installation-view.test.mjs`
validates both formats, source identity, installed-folder behavior and malformed
catalog rejection with generated metadata only.
