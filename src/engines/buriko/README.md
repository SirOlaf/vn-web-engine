# Buriko / BGI

The BP interpreter and native services belong to this engine directory. They do
not select a game. Installation selection, executable metadata, persistent-store
namespaces and legacy player compatibility live in the application layer.

`bp/` implements bytecode execution, memory and scheduling. `native/` assembles
the BGI services and their script callbacks. Host operations use the shared
`src/platform`, `src/audio`, `src/video`, `src/graphics` and `src/text` services.
New browser or operating-system capabilities should be added to those shared
layers when they are not specific to the BGI ABI.

The application supplies the selected executable's native product identifier to
the production graph. This value is script-visible and participates in native
process-instance naming; a display title or an executable filename is not a
substitute. Save transfer requires an explicit store factory, so different
installations cannot silently share one engine-wide save directory.

Native address comments and inventory values identify the reference executable
with SHA-256 `f585e28f79923b8aa487d8690165e45ce3377c7e1b8381d3b75c659c7e933d7a`.
They document recovered behavior, not address compatibility with every BGI
release. Older binaries, packed installations and alternate native banks still
require comparison before support can be claimed. Preserve version differences
explicitly; do not select behavior using a game's display name.

`tools/probe-buriko.mjs` mounts an installation read-only beneath an in-memory
write overlay and runs a bounded production boot without canvas presentation.
It reports control-flow progress, not visual correctness or complete game
compatibility. Visual verification remains a separate, user-controlled step.
