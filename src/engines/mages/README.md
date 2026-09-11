# MAGES engine layout

Only behavior shared by MAGES titles belongs directly in this directory. Format
readers, asset identification, archive overlays, and MVL character composition
stay here because they do not encode a particular game's native control flow.

Game implementations live under `games/<game-id>` and may reproduce their native
paths, state layout, script behavior, rendering, and platform quirks without
turning those details into engine-wide abstractions. The current implementation
is `games/chaos-head-noah`; its SC3 runtime intentionally remains game-specific.
