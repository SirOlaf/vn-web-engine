# MAGES engine layout

Only behavior shared by MAGES titles belongs directly in this directory. Format
readers, asset identification, archive overlays, and MVL character composition
stay here because they do not encode a particular game's native control flow.

Game implementations live under `games/<game-id>` and may reproduce their native
paths, state layout, script behavior, rendering, and platform quirks without
turning those details into engine-wide abstractions. The current implementation
is `games/chaos-head-noah`; its SC3 runtime intentionally remains game-specific.

`executable.ts` selects the game image from an installation's root folder.
`Game.exe` is used directly; storefront renames such as Steam's `Game_Steam.exe`
are identified by the build's PE version resource. The image is mounted under
its original name and games receive its installation-relative path.

The executable is optional. Games read only presentation data from it, such as
cursor images; when it is absent or its resources are unrecognised, a note is
logged to the console and the system cursor is used.
