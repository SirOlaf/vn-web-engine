# Artemis Rev.3179 integration

The integration targets Hatsuyuki Sakura's executable SHA-256
`8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf`.
Native addresses below describe this exact build; they are not selectors for
other games or revisions. The player page is `artemis.html` (see
[Browser player](#browser-player)); `docs/artemis-status.md` lists what is not implemented.

## Resource and script execution

`src/formats/artemis/pfs.ts` reads PF8 indexes using shared `ByteSource` range
reads and Web Crypto SHA-1. Payloads are lazy and XOR starts at the entry-relative
position. `files.ts` mounts the base PFS and existing `.000` through `.999` packs
in ascending order, including after gaps. Later archives replace earlier entries;
a loose file, including an empty file, wins. Names preserve case and Unicode and
normalize slash spelling only. The host supplies filesystem case rules. Extra pack lists, embedded packs and other revisions are unsupported.
Relevant native entries: `0x14017fb10`, `0x14017e8d0`.

ASB v0 carries tag arguments, source-line numbers and labels indexing the tag
sequence (`0x1400c4ad0`). IET supports the UTF-8 boot subset: labels, square tags,
quoted/named/positional arguments, escapes, comments and raw inline Lua. Lines are
zero-based and refer to the closing token. Plain dialogue, @ commands, tag.ini
aliases and native conditional/loop compilation are not implemented. Unknown
commands require explicit host dispatch; they do not silently succeed.

`script.ts` caches loaded programs, executes inline Lua once during initial load,
then runs the cursor and FIFO tag queue. Queued tags precede the next script tag
(`0x1400c0560`, `0x140130350`). Call/jump accept the current file when omitted;
empty labels begin at tag zero (`0x1400b6520`). Call/return scope effects and the
root-end exit (`emptyReturn`) belong to the host. End of a called script returns to its
caller. A host provides waits, stop effects, rendering and all remaining services.
`run(maxSteps)` bounds dispatch; it does not schedule a browser frame.

The tag queue belongs to the current caret (script +0xb68, queue at +0xbe8). A transfer
(b6520 → b8090) installs a fresh caret, so `jump` drops pending queued tags. `call` and
handler-only event scopes push the caret with its remaining queue (eb990), and `return`
restores both (c6580). `stack()` is the source of Lua `getScriptStack` (0x1401318a0):
saved carets oldest first, then the current one. Each frame is `{file, index,
reservedCommands}`; each command is `{command, line, parameter}`. Saved frames number commands
from 1 and the current frame from 0.

`lua.ts` connects shared Lua 5.1 to include, file reads/existence, now, tag,
enqueueTag, literal variables and live tag filters. Direct/queued Lua tags have
source line -1 and bypass the script tag filter (`0x14012ca50`). Lua tables holding
filters remain live, including closures installed after registration. Argument
conversion follows the investigated string/numeric subset; other values fail.
AST files are Lua assignments. Story traversal must run the game's Lua interpreter,
not a separately invented AST VM.

`convertEncoding` accepts explicit `sjis` / `utf8` byte-string conversions through
the shared text codecs, preserving embedded NUL. Its Rev.2601 registration and
argument handling are documented in `docs/artemis-revisions.md`. EUC/JIS and native
input auto-detection remain refused. The engine profile supplies no activation
result. The browser's compatibility policy is separate: `ui/game-profiles/artemis.ts`
matches the executable and original authorization module SHA-256, then supplies a
Lua-only source substitution. It disables the verified authorization entry function
for the three World Actor installations. Standard folder selection in `artemis.html`
applies this in memory without extra archives, loose files or launch scripts.
Raw file reads, CRCs, native capabilities and the save namespace stay unchanged.
Other source identities keep their original behavior; hosts without source
substitutions retain native include behavior.

`httpget` waits in mode 8 while frame callbacks continue. It uses the shared fetch
host, publishes real response status/bytes or native negative failure codes, and
honors `s.http.cancel` without replacing the result variables. Browser CORS rules
still apply. Custom headers, response files and POST remain refused; native
Rev.2601 entries are listed in `docs/artemis-revisions.md`.

`variables.ts` preserves byte strings and resolves only the current local scope
before globals (`0x1400b0880`). An exact delete removes only that key; otherwise
it removes keys starting with the name plus a dot (`0x1400af990`). Expressions,
empty-name global clears and complete system-variable initialization remain incomplete.
Writes to names starting with `g.` mark the global state dirty (`0x1400b0940`/`0x1400b0a00`;
string writes only on change); deletion preserves the native dirty-flag quirk. `restore`
sets values without dirtying (save load) and `resetScenario` keeps only `g.`/`s.` names
(`0x1400b0bd0`, reset tail).
Literal Lua queries create missing variables as integer zero (0x140157fa0),
while raw map reads preserve empty absence. Other expressions remain unsupported. Unknown `s.`/`ini.` names
refuse instead of reading zero, except `s.clickskip`: it has no startup initializer, and its
only native writers are the c0560 click-skip input paths (run modes 1/3/4, 2 and 7), which set
integer 1 through 0x1400b0940: the wait click, the run mode 2 transition click and the run
mode 7 movie end. Stage-size queries require a configuration/rendering provider.
The handler (0x1400e56a0) gives `data` precedence. Without it, a `system` value that is not
one of the native queries, or no `system` at all, writes nothing; this is what a Lua call
such as `data=(rule)` with a nil field produces. Native queries this engine does not
implement are refused.
`system=unixtime` stores `_time64` through the 32-bit integer setter and `system=date`
writes `.year`, `.month`, `.day`, `.hour`, `.minute` and `.second` from `_localtime64` of
the `unixtime` argument (`atoi`, read as unsigned) or of the clock (0x14019a970,
0x14019a980). The clock is the host's `now` (`Date.now` by default) in the host time zone.
`system=get_layer_info` with `id` (`layer-info.ts`, 0x140116ee0) writes the current actor
of that layer below `name.`: truncated `left`/`top`/`width`/`height`, `alpha`×255,
anchors, scales×100, `rotate`, the flags, `surfacewidth`/`surfaceheight` when the actor
has a surface, `clip` and `dragarea` as MSVC `%.9g` float lists, `layermode` (normal 0,
add 1, multiply 2, screen 4), raster flags, `colormultiply`, the shader name and
`shaderconstant.*`, `clickablethreshold` and `draggable`. A CLayer's width is 0 without a
surface, else the nonzero clip width, else the surface width (height alike). An unknown id
writes nothing. An empty group (CLayerSet::CPropertyHolder) shares the CLayer getters and
reads as a CLayer without a surface. Animation and text actors and the id-less enumeration
are refused.
`system=get_message_tags` reads the save object's history of message layer `id` (absent:
""): nothing without a +0x08 entry; otherwise `name.0`… hold, when `allfont` is present
and not `0`, each +0x18 font frame as CFontProperty text (0x1400a5c70; operator[] creates
an empty +0x18 entry), then each text command as tag text (0x1400a2400), and `name.size`
the count. Tag text is the name and `,key,value` per argument in std::map order, with
each comma that starts a UTF-8 character (0x1400a0340, code page 2) escaped as `\,`. Font
text is `font` and `,key,value` pairs in native order: floats as `%.9g` (alphas ×255 and
scales ×100 as float32 products), sizes unsigned, `overflow` signed, colors `0x%X`, faces
unescaped, flags `1`/`0`, `layermode`/`align` names and `style` names joined by `\,`.
`%.9g` (`src/core/c-number-format.ts`) formats the exact binary value with ties to even,
the UCRT rule since Windows 10 2004.
`system=url_encode` (0x1400a18f0) keeps `A-Z a-z 0-9 - . _ ~` of the C string `source` and
writes every other byte as `%XX` (uppercase, unsigned). `system=url_decode` (0x1400a1a10)
turns `+` into a space and `%` plus the next two bytes into `strtol(.., 16)` cut to a
byte; a `%` without two following bytes reads past the native string and is refused.
`system=file_exists`/`file_exist` writes 1 when `file` opens as a CArtemisPackFile
(0x1401193d0) and 0 otherwise; `save` (present and not `0`) makes SaveDataPath the
current directory for the open, which this engine models as the save storage.
`system=file_crc` reads `file` whole and writes its CRC-32 (`src/core/crc32.ts`, boost
`crc_32_type`) as `%x`, `%X` with `caps`, with a `0x` prefix with `zerox`; a file that
does not open writes an empty string. `system=get_font` enumerates the host's families
(EnumFontFamiliesExW over DEFAULT_CHARSET, 0x140182040, callback 0x140182710) and keeps
TrueType entries under SHIFTJIS_CHARSET, fixed pitch only with `monospace`. Names are
listed once in UTF-8 byte order as `name.0`…, `name.size` the count: `@` vertical faces
only with `vertical` (present and not `0`), the others only without it. The browser host
reads installed faces through Local Font Access (`src/text/gdi-font-families.ts`); without
that API, or when it is denied, the list is empty.
`revision.ts` initializes the confirmed static boot variables only after exact
executable-hash selection. Host Windows-version failure produces native 0.0;
platform identity/capabilities are never invented.
Boot publishes `s.windowstouch` from the touch owner's registration flag, independently
of its current contact count. The shared `WindowsTouchHost` also owns Lua contact/hold
queries. `BrowserWindowsTouchHost` is unregistered: the current page delivers mouse
input and has no Windows Touch contact owner. A native host can provide a registered
device. Boot overwrites a restored capability value with the current host's value.
The exact Rev.2898 PE32 hash has its own boot record. Its publication omits
`s.llp64` and `s.windowsfeaturelevel`; a later literal Lua query creates native
integer zero for these confirmed absent names. Boot does not insert them or
invoke a graphics-feature query, and preserves values restored from system data.
Other unsupported system names retain their guards. Its screenshot, sound-loader
and mode fields are documented with x86 evidence in `docs/artemis-revisions.md`.
Rev.2868 has an independently verified PE32 boot and behavior profile, documented
in `docs/artemis-revisions.md`. Its eight raw blur-source signatures select
plain, mask and captured-background AA executables. AA output replaces the target;
using it outside a captured target is refused until that Back ownership is modeled.
The supplied Badge & Dagger files have an original SoftDenchi checksum mismatch.
Full-route evidence uses a separate local copy with user-authorized authentication
overrides, kept outside this repository. That copy completes a full nonvisual
Fuyumi route through original staffroll and reset/title, with save/load and fresh
restoration of the game's clear records. The runtime retains the original checksum
and platform semantics. The ordinary browser player supplies the verified in-memory
policy described above for original installation files. See the revision notes
for the validation scope.
Rev.2908 has its own exact-hash PE32 profile for Hentai Prison. Its independently
checked operations retain DX9 named effects, byte-sized clipped-cell glyphs,
expanded painted-font cache, initial Vorbis page search, replay mode 13 and exit
mode 14 without fullscreen publication. The base archive and all existing numbered
packs through `.999` mount through the shared loader. Original folder selection
uses the same browser player; no extra installation files are required. One full
Chisato route through ED, clear records and reset/title passes in the nonvisual
probe. Native entries and validation scope are recorded in
`docs/artemis-revisions.md`.
Rev.2762 (Hamidashi Creative) has its own exact-hash PE32 profile. It shares the
Rev.2601 DX9 property parser, packed painted-font cache, replay hold 13, exit mode
14 and 32-bit rendered glyphs, and adds native synthetic bold. Original
folder selection uses the same browser player without added files. One full 妃愛 (`hiy`)
route through staffroll, clear record and reset/title passes in the nonvisual probe;
see `docs/artemis-revisions.md`.
The independent Rev.3083 PE32 profile deletes restored `s.llp64` and
`s.windowsfeaturelevel` at boot before their later zero-creating queries. It uses
the DX9/clipped-cell path, accepts shader texture properties, and publishes
fullscreen status at exit. The exact wrapper identity and native operations are
listed in `docs/artemis-revisions.md`; executable names do not select a profile.
The x64 build of the same Rev.3083 source (Hamidashi Creative Totsu) has its own
exact-hash profile. It keeps the Rev.3139 DX11 boot fields, named shader properties,
ordered-buffer constants and exit mode 14, and differs in clipped-cell glyphs with
synthetic bold/italic, the expanded painted-font cache, 32-bit rendered glyphs and
the fixed dialog style. Original folder selection uses the same browser player
without added files. One full 妃愛 route through staffroll, clear record and
reset/title passes in the nonvisual probe; see `docs/artemis-revisions.md`.
Rev.2898 and Rev.3083 synchronize to the first CRC-valid Ogg page before the native
65536-byte boundary. This accepts a leading `bw  ` header through the ordinary
Vorbis loader, without retrying another codec or rewinding the opened file.
The shared Vorbis decoder exposes this as an optional first-page search; its default
remains strict, as do the other Artemis profiles pending their header-search
audit. Incomplete candidates and malformed subsequent pages still fail decoding.
Rev.3257 has an independent hash and boot record; its screenshot and sound-loader
rewind fields match Rev.3179. Its recompiled native addresses require the mapping in
`docs/artemis-revisions.md`; Rev.3179 address literals are not its native addresses.
Its revision-selected native tag map also includes `indentmodify`: optional `unindent`
pops paired indentation levels, any negative count clears them, and existing lines
keep their geometry. The command records text history without editing the persistent
indent replay slot. `var system=get_message_layer_indent_nest` reads the selected
insertion owner's depth. Both operations are absent from the older revision maps.
Its scenario replay hold is mode 14 and its application exit is mode 15; earlier
revisions keep modes 13/14. The revision fields select the loader bracket, exit guard,
video-entry guard and host exit predicate. Lua status values remain native numbers.
Rev.3248 (Hamidashi Creative Re Re call) has its own exact-hash profile with the
Rev.3257 fields, including `indentmodify`, replay mode 14 and exit mode 15; only its
boot record differs. Its native fullscreen video uses only the DirectShow graph, while
Rev.3257 adds a Media Foundation session; the browser movie host serves both. The
installation-relative `SAVEPATH = savedata` maps to the player's save storage. One
full 莉々子 route through staffroll, epilogue, clear record and reset/title passes in
the nonvisual probe; see `docs/artemis-revisions.md`.
Rev.3258 (Amakano 3) has its own exact-hash profile: the Rev.3257 fields plus E-mote
layers over `emotedriver.dll` 3.9.8 (see [E-mote layers](#e-mote-layers)). Its boot
record differs; the executable imports the DLL, so the runtime refuses to open without
it and selects the driver by the DLL's exact hash.

Exact shader source hashes `271173e7…d18d6`, `3a5b63e5…604b`, `07f6d756…763d`
and `db1b5dc8…3ac9` select the perspective presets. They warp one texture coordinate
around its center and divide the other by a position-dependent slope, then clip and
fade alpha using the source's step and smoothstep factors. The vertical variants swap
the axes; anchored variants use both center fields and reverse the slope. The anchored
horizontal variant clips only the negative horizontal edge, as its source does.
The four native constant slots are horizontal center, vertical center, scale and edge
fade. The CPU reference, standalone WebGL helper and DrawList adapter share that
layout; unused center slots are retained so later fields keep their native offsets.
Source hash `80d646d6…e02ad` selects diagonal blur. It averages four diagonal samples
for RGB, adds their alpha to the retained center alpha, then applies layer alpha.
The two native constant slots are diagonal offset and its size multiplier.
Hashes `b993e902…38a2` and `613c946b…3122` select the corresponding two-sample
horizontal and vertical filters, preserving the same center-alpha addition and layout.
The kawase passes `91b27ada…7cb1` (`blur_k`), `d26e58ce…849b` (`blur_kx`) and
`ff65397a…4fe4` (`blur_ky`) use the same sample offsets but start from zero, so alpha is
averaged too, and layer alpha scales only the summed alpha. Their premultiplied sources
`eb511278…efef`, `6caab0c6…c757` and `bd8aa1e5…ad5c` multiply every sample, colour
included, by layer alpha as it is accumulated (`*_premultiplied` kinds).
Hash `c4bf785c…e20a` selects a background-noise displacement preset. It reads the captured
background through native UV2, adds the same sine/frac offset to both coordinates with
fixed zero time, and scales background alpha. Its single constant is offset amplitude.
The DrawList adapter binds capture texture 0 and its own coordinates; without a captured
background it samples zero, matching an unbound native background slot. The standalone
WebGL helper uses its auxiliary image as background for this preset.

`parseIet` lowers if/elseif/else/[/if] and loop/[/loop] like the native IET parser
(`0x14011a740`): conditional and loop tags receive a decimal `\x0bindex` target and
branch exits become compiler-only `\x0bgoto` tags. `ArtemisScript` writes its cursor for
if/elseif/loop when atoi(`estimate`) is zero (`0x1400e9fb0`) and for every goto
(`0x1400c7800`). Arguments starting with `$` are evaluated before filtering through
`ArtemisScriptHost.evaluateExpression` once per `$`; without an evaluator they are refused.
The result also replaces the exact argument bytes of a Lua-built tag (`AsbTag.bytes`), so
handlers that read bytes, such as `var` `data`, store the evaluated value.

`expression.ts` is the CCompute evaluator (`0x140157ff0`, substitution `0x1400afc60`) over
UTF-8 bytes with `'` as the only quote character: integer/hex literals with sign merging,
backslash escapes, `name(expr)` spliced variable names, and reduction passes `* / %`,
`+ -` (string concatenation unless both operands are numeric), relational, `== !=` (string
comparison when either side is a string), `&&`, `||`. Failures yield an empty argument.
`ArtemisVariables.expressionValue` supplies leaves; absent names become integer zero.

`layer-events.ts` is the lyevent handler (`0x1400d8a10`): types click, rollover, rollout,
dragin, drag and dragout; mode init stores a copy of the tag as the callback (with the
penetration flag for click/rollover), reset stores an empty callback, enable/disable write
the per-type enable flag (groups reach every child actor). History uses
`ArtemisLayerCommands` (`erase` = `0x140144960`, `append`, coalescing `record`) unless the
dispatch is a replay. `ArtemisLayerEventSlots` is actor-owned state that actor copies must
copy, including the pointer-inside flag and drag start. `invoke` calls the stored functor:
`ArtemisScriptEvents.emit` (b73e0) with the tag copy, the type index as event mode and the
penetration flag as force. A click or rollover without penetration takes the script's event
latch for its mode (+0x30/+0x31), so later clicks or rollovers of the same frame are
suppressed; penetrating events pass through to the layers below. The runtime clears both
latches after the input update. `ArtemisKeyBindings.deliverPushed` is the c0560 run mode 1/3
push-handler slice: slot 0 (decide query) then slot 1 (push query) in ascending key order,
ending the frame when a command is delivered. The probe's `--layer-event=<id>[:type]` and `--key-push=<key>`
options apply these at a run mode 3 stop, one per frame, without pointer hit testing.
`--layer-event-at=<n>:<id>[:type]` and `--key-push-at=<n>:<key>` apply them at the click-wait
before the nth probe click instead. In automode the probe ends click-waits with run mode 1
frames without a click and reports their durations as `automodeWaits`.

`modes.ts` owns skip/auto/autosave command state and emits required status/effect
callbacks (`0x1400d47b0`, `0x1400d4350`, `0x1400ca3d0`). The setters (`0x1400b7810`
automode, `0x1400b7ba0` command skip, `0x1400b7c70` control skip) write
`s.status.<mode>` and run the registered `setonautomodein/out`,
`setoncommandskipin/out` or `setoncontrolskipin/out` command. The automode setter
first finds or creates the indicator entry of the current message layer; showing or
hiding a named indicator layer is refused because the indicator owner is not
implemented. `syncse` is split at commas with empty fields kept (`0x1400a0770`), so an
empty value is one empty id.

Each frame (`0x1400c0560`, after onEnterFrame) the runtime applies the mode key roles:
a decided role 10 (stopbyclick) or 11 ends automode, role 13 ends command skip, and
either ends the frame; control skip follows role 14 held. In run modes 1 and 3, after
push handlers, role 9 starts automode and role 12 command skip, ending the frame.

`exec.ts` owns the exec tag (`0x1400d52c0`). automode/skip force the mode setters
(absent mode enables auto and toggles skip; exactly `0` disables). rclick/hide/backlog
record requests that the frame owner consumes like the matching key inputs, enter run
mode 4 through the host and write the wait timestamp from the platform millisecond
clock. fullscreen and minimize use shared `WindowStateHost`
(`src/platform/window-state.ts`); the software-renderer guard and display reset are host
operations. Unknown commands do nothing.

`stop.ts` owns the stop tag (`0x1400c7bb0`). It starts the text display like the wait
tag (skip vector while skipping or debug-skipping, otherwise the message layer's `in`
vector; see [Text display and click-waits](#text-display-and-click-waits)), enters run mode 3 through the host (refused from mode 13) with the mode 3 save gate, and
turns an active automode off without force. Click consumption of mode 3 belongs to the
frame owner.

`events.ts` copies recognized callback names and applies partial updates, including
the legacy onClickWait alias. The frame/input/save owner emits callbacks; failed
frame/click-wait callbacks are disabled. Named Lua calls resolve dotted table paths and supply
engine plus the native argument table when nonempty (`0x14012c030`, `0x140133730`).
Native metamethod-based callback lookup is not reproduced by the raw-field bridge.

`mouse.ts` dispatches cursor visibility/position through shared `CursorHost` and
implements the native unsigned auto-hide deadline. Native pointer activity resets
remain unconnected; the browser player maps page coordinates to stage coordinates.

`dialog.ts` is the UTF-8 `dialog` tag (`0x1400c91e0`, completion `0x1400b7460`) over
shared `TextDialogHost`. It pauses script progress until the host completes, then writes
`varname` (1 accepted, 0 cancelled; its presence adds Cancel) and, for `textfield`, the
field text cut to `textfieldsize` characters (0 keeps it whole, a negative size never
cuts; text ends at a NUL). The field text is written on either result. The field starts
with `message`. `BrowserTextDialogHost` (`src/platform/text-dialog.ts`) is the native
CDialog window as a modal `<dialog>`: a focused single-line field or the message, OK and
Cancel; Enter accepts and Escape cancels from any control, also without Cancel, but not
while an IME composition takes the Enter; Tab moves forward through field, OK and
Cancel; accepting and cancelling are ignored for the first 500 ms; browser close
requests are ignored. Keys do not reach the game while it is open.
`fontsize`, `minwidth` and `applydesktopscale` set the window's font size (default 20),
minimum width (default 240) and desktop scaling. Revisions with `fixedDialogStyle`
(Rev.3083 x64) never read them and always use the defaults without desktop scaling.

`file-command.ts` is the `file` tag (`0x1400ea0b0`): `copy` reads `src` like a resource
and writes `dst`, `delete` removes `target`, `clear_cache` drops the archive caches, and
other commands do nothing. In the browser only the save directory is writable: copies
elsewhere report the uncreatable destination, removals elsewhere are ignored, and
`clear_cache` has nothing to drop because mounted archives never change.

## Engine runtime

`runtime.ts` is the engine object of `0x1400b9e80`. `ArtemisRuntime.open(services)` reads
system.ini ([WINDOWS] WIDTH/HEIGHT/BOOT/SAVEPATH), the Lua/AST/script corpus (including
ABI-compatible binary `.lub` chunks), CSV tables and `.sli` sound-loop sidecars,
which Lua reads synchronously with `file`. Sidecar bytes remain
unchanged: the game's Lua interprets them, rather than an engine-specific loop parser.
They share the corpus memory budget. The runtime then builds every tag owner, the Lua runtime, the script,
the tag dispatch (`tag-dispatch.ts`), reset, save and load. The services supply what the
native engine took from Windows and its devices: installation files, save storage, the
layer graphics owner, text glyphs, surfaces, effect/music voices, shaders, the fullscreen
movie player, dialogs, window state and caption, cursor and pointer, dynamic libraries,
the Windows version and the graphics feature level. Error reports and the optional
`trace` stream (tags, script steps, includes, owner effects) are diagnostics.

The host drives frames through the runtime: `boot()`, then `frame(now, input)` once per
display frame, and `settleResource()` whenever `resourcePending` reports a tag or Lua call
suspended on a resource ('held' when the operation entered a run mode; a load that
replaced the suspended caret runs the loaded caret instead of resuming). `frame` follows
`0x1400c0560`:

1. The frame counter (Lua `getFrameNumber`) increments.
2. The window update delivers the layer events of the previous frame's pointer input.
   Each event's script event is immediate or deferred by the run mode; an event whose
   layer was deleted or lost that event since is not raised.
3. The input update samples `input.sample` into `ArtemisInput` and clears the
   `overrideKey` overrides.
4. The clock advances voices, tweens and video layers, and Lua `onEnterFrame` runs (a
   failing handler is cleared).
5. The run-mode branch: a pending transition steps (role 0 decided finishes a run mode 2
   transition); run mode 7 runs the fullscreen movie frame; run modes 1 and 3 deliver the
   push handlers, and a delivered handler ends the frame; the wait (run modes 1, 3 and 4)
   checks role 0 decided in run mode 1, its deadline or display completion; then a ready
   script runs.

Delivering pointer events one frame late keeps the native order of a button press: the
push handler of the press is queued first and ends its frame, and the layer click's
handler scope, raised next frame, runs above it. A press sampled in the frame whose window
update raises a rollover is not pushed: the rollover handler scope is in run mode 0 until it
returns, so the layer click alone follows. While a resource holds the script or a
frame call, `advanceTo` retains the wall timestamp without polling voices or tweens.
Native resource loading blocks the frame: polling sound EOF during the browser's
yield could otherwise enter a handler scope above a suspended Lua caller. The next
frame polls the real voice state after the load returns; callbacks are not discarded
or replaced with timers. `acceptsInput` reports run modes 1 and 3. `advanceTo`,
`layerEvent` and `keyPush` are the individual steps, and `save`/`load` with
`scenarioArchive()` and `flushSaves()` serve save tooling. `runMode` is the current caret's
native mode (0 script, 1 click wait, 2 transition, 3 stop, 4 wait, 7 video, 13 load,
14 exit).

`exit.ts` is the application exit of the script, shared by the `exit` tag
(`0x1400c8380`), `return` with an empty caret stack (`0x1400c8250`) and the end of the root
script: unless a load holds run mode 13, the script enters run mode 14, writes
`s.status.fullscreenatexit` and forces the global save (`saveg.dat`, `system.dat`).
`exited` then reports true and `frame` refuses further frames. The window owner closes the
application after that frame (`0x14013cec0` posts WM_DESTROY); the browser player waits
for the pending save writes, disposes itself and reports `closed`.
The exact Rev.2898 profile enters exit mode and forces the same global/system
save without querying fullscreen or assigning `s.status.fullscreenatexit`.
An existing value is preserved in that save; the other four profiles retain the
publication described above.

`input.ts` is CArtemisInput. Keys 0..0xff hold 0 idle, 1 pressed this update, 2 held,
3 held past the 500 ms repeat delay and 4 released this update; wheel notches (136 up,
137 down) persist until a push, down or down-edge query sees them; joystick keys
0x100..0x13f follow the first attached game controller (DIJOYSTATE, axes -1000..1000):
buttons 0x100..0x11f, axes past ±499 0x120..0x12f, POV directions 0x130..0x13f. The player
reads it from the browser Gamepad API (`src/input/directinput-joystick.ts`, the DirectInput
layout of the pad's driver); a lost device releases the keys. While the page is not visible
and focused every query is false and the pointer reads (-1,-1).
Push answers states 1 and 3, down 1..3, down edge 1, up edge 4 and
decide the down edge (rev.3179 has no writer for the up-edge decide set). Keys 1 and 2
require the pointer inside the client area, and a false key 1 query repeats for the tap
key 0x8a. Lua `overrideKey{key, status}` sets a one-update override of `status & 0x3e | 1`
(bit 1 push .. bit 5 decide) for one key or every key; status -1 clears it and keys from
0x140 are refused. Lua `isPush`, `isDown`, `isDownEdge`, `isUpEdge` and `isDecide` query
it; `getScriptStatus`/`setScriptStatus` read and enter the current caret's run mode
(entering 0 ends a script wait); `getTouchCount` and `setUseTouchHold` use the host's
touch device. Wrong argument types report `<name>の引数が不正です`.

The run mode (c70, previous mode c74) and the wait flags (b94..bc8) belong to the caret.
`call` and an event-handler scope save the caller's caret with its mode, wait flags and
tag queue and start a new caret in mode 0 without wait flags; `return` restores them.
`ArtemisScript.caretFields` lets the runtime hand the wait owner's flags to each saved
caret.

Runtime service adapters shared by the browser player and the probe:
`runtime-sound.ts` maps the effect (+0x3d88) and music (+0x3d60) managers onto the
runtime sound service; `runtime-glyphs.ts` (`ArtemisRuntimeGlyphOwner`) keeps one text
insertion per message resource over a glyph block source.

## Browser player

Menu availability and key defaults belong to the game's Lua configuration.
The player exposes the controls that configuration enables; a hidden menu layer
does not establish an available action. The Rev.2898 validation uses the game's
save/load/config/backlog panels and their return controls because its merged
configuration disables the separate game menu. Its right-click default hides
the message window. Reset also runs the game's font warmup, including four
U+3000 `print` tags after the scenario text has stopped. The validation scope and
the distinction between direct native citations and verified cross-revision
operations are recorded in `docs/artemis-revisions.md`.
Functional route validation and the full native-reference audit have separate
scope: the latter remains deferred, with unresolved mappings explicitly retained.

`browser/player.ts` (`ArtemisBrowserPlayer`) composes the runtime for a page: the stage
canvas (`WebGLDrawTarget` sized from system.ini), the surface manager over the PNG, JPEG
and merged PSD decoders (decoded off the main thread), FreeType glyph rasterization and
painting in workers, Web Audio voices (`browser-sound-voices.ts`), the fullscreen movie
player, text dialogs, the window, caption and cursor hosts, and the shader library
(`shader-library.ts`) whose presets compile into WebGL triangle shaders. The page decides
the Windows version and the graphics feature level reported to the game
(`ui/runtimes/artemis.ts`). Each animation frame runs `runtime.frame` with the input
gathered since the last frame, settles resource operations, and presents the stage with
`drawStage`.

Native script error reports become diagnostics and the script continues: Lua call errors
(`c84b0`), unknown tags (`c7260`) and include errors, except include failures that come
from an unsupported or unprepared owner, which stop the game. The page passes a `trace`
stream when its address contains `#trace`: `window.artemisTrace` keeps the last tags,
script steps and owner effects, `state()` reports the run mode, script, wait and pointer
state, `hitTest(x, y)` the layers at a stage point, and `lua(path)` the Lua global at a dotted
path (booleans and numbers as values, strings as their byte length, tables as `table`).

`browser/layers.ts` builds the layer system over `ArtemisImageGraphics`. Message layers
are text actors (`createTextLayer`) whose sprites come from the insertion's display lines:
each glyph is placed at its font `left`/`top`, line, block and glyph offsets, with the
text display's animated `left`, `top`, `xscale`, `yscale`, `rotate` and `alpha` applied
about the glyph origin; invisible fonts draw nothing. While a `print` loads glyphs the
layer keeps the sprites from before the insertion, as the synchronous native insertion
never shows a partial line. A block's glyph jobs overlap in a window of 16 per main or ruby
stream (`text-glyphs.ts`), below the 64-job budgets of the font and paint workers, and the
block keeps glyph order.

DOM text (`browser/dom-text.ts`, `ArtemisDomText`, selected by the page's text mode) puts
selectable text over every text layer the stage draws, for copying and dictionary
extensions. `ArtemisImageGraphics.textLayers` lists the visible text layers in drawing order
with their stage matrix, opacity and capture clip, computed without the retained world
matrices so reading them leaves drawing unchanged. A text source's `cells` are its
characters, ink-less ones included, with the sprites' display tweens; `artemisTextSlots`
makes a slot per run of body characters sharing a font (display lines as explicit rows,
the em box inside the outline) and a non-selectable slot per word's ruby.
Each text layer also lists the ordinary image layers drawn over it (normal blend, no
shader); a character keeps the share of its opacity that their pixel alpha leaves at its em
box centre (`artemisTextVisibility`; images without CPU pixels count as opaque), so text
under a menu is hidden or dimmed as on the stage. Text partly outside the stage and the
layer's clip is kept inside them (`artemisFitTextRows`): each display line starts inside,
the part past the right edge wraps onto new rows at the line's start (before the word that
crosses the edge, or inside a word wider than a row), later lines and the ruby move with
it, and the text then moves up or down into the bounds. A layer with no character inside
them is not drawn by the stage and gets no slots. Browser faces load from the game's font files. Without a reader style the text is transparent over the
stage's glyphs; with one `hideText` stops the stage drawing text (text layers still hit
and clear their capture targets) and the slots show it. A click on the text reaches the game
unless it selected text, the context menu stays for a selection, and keys from the text
reach the game except Shift (left to the extension) and Control while text is selected. A
focused text slot that is hidden, made inert or removed (a choice closing after a click on
its text) gives focus back to the canvas (`ArtemisTextFocus`), so keys keep reaching the game
as they reach the native window; focus moved elsewhere on the page is kept.

`ArtemisImageGraphics.drawStage` renders the scene into a stage surface and presents it.
When a transition starts the last presented frame is kept; state 1 crossfades from it by
the transition value, state 2 reveals by the rule image against threshold and vague
(`a = clamp((t - r + v) / 2v)`, or a step when vague is 0).

Input is polled like `GetAsyncKeyState`: the player keeps a `VirtualKeyState`
(`src/input/virtual-keys.ts`) of the held mouse buttons (`VK_LBUTTON`, `VK_RBUTTON`,
`VK_MBUTTON`) and keys (by `KeyboardEvent.keyCode`), and samples it once per frame; a key
pressed and released between two frames is reported held once. Wheel notches become keys
136/137, the pointer leaving the canvas clears the inside flag and focus loss releases
every key. Which role a key serves is game configuration (`keyconfig`).
`hitTest(scene, x, y)` returns visible image, animation and text layers under a stage
point, topmost first: the point maps through the inverse local matrix into the image
bounds, then the clickable threshold gates the pixel alpha (`0x14017b6a0`). Each frame the
player passes the pointer and the hit layer ids to the runtime, whose window update runs
the per-actor pointer update (`0x140179f50`, `ArtemisLayerOwner.updatePointer`) in every
run mode but 9, before the input update, so it reads the key states of the previous one.
Hit layers go first, topmost first, then the other actors with a draggable flag or an armed
click, rollover or rollout callback. Each actor keeps its own inside flag: `rollover` when
the pointer enters it, `rollout` when it leaves, and `click` when it is inside, not
draggable and key 1 is decided. An idle draggable actor under the pointer starts on the key
1 down edge (`dragin`, `0x140179e80`), then moves its left/top by the pointer offset since
the press, clamped into its drag area unless all four edges are zero. It raises `drag`
while key 1 is down and `dragout` on release. Drag moves write no layer command.

## Verification and remaining work

After `npm run build:runtime`:

```sh
node --test tests/artemis-formats.test.mjs tests/lua51-runtime.test.mjs tests/artemis-execution.test.mjs
node tools/verify-artemis.mjs GAME_DIRECTORY
node tools/probe-artemis.mjs GAME_DIRECTORY
```

The verifier checks real archive indexes, ASB records and loose precedence without
extracting or rendering media. The probe runs `ArtemisRuntime` over nonvisual services
(image metadata layers, actual glyph layout, surface decode, offline PCM voices, optional
`--shader-presets` CPU shaders) until the first unsupported service. It uses a
deterministic clock and in-memory save storage; it is not a production filesystem,
clock or complete INI loader. With `--ast-check=NAME` the game's own
`readScriptFile` load-only path loads the AST script NAME after the route.
By default dialogs remain pending. `--dialog-result=0` or `--dialog-result=1`
explicitly supplies a simulated outcome for a separate probe, recorded in its JSON.
Probe cursor/scheduler effects are record-only and do not represent production effects.

Shared platform/media services must remain in
the shared layers. Evidence and game resources are local-only and are not part of
this source tree.

## Timed waits and save requests

`wait.ts` implements the wait tag and the `@` click-wait together with their run mode
1/4 frame branch; [Text display and click-waits](#text-display-and-click-waits)
describes the progression. Timed waits keep the input=2 skip/debug-skip bypass, strict
absolute uint32 deadline comparison and the zero-deadline sentinel. Input=1 enters
click-wait: the host receives scheduler state, the In callback and the native save
request. Completion releases the scheduler, emits Out and updates message state.
`video=<id>` waits start no text display and end on the first frame where layer `id`
is missing, is not a video layer or has finished playing (see [Video layers](#video-layers)).
`se=<id>` looks the id up in the seplay id→sound-index map. An id that was never
registered returns without a wait or run-mode change; otherwise the wait starts no text
display, reports `sound` as its wait reason, counts as a wait flag for `s.clickskip` and
ends on the first frame where the sound manager reports that index stopped (a missing
player counts as stopped). With `time`, it instead reads CSoundPlayer's playback-start
tick (virtual +0x38), returns without waiting when that tick is zero, and sets a
time-only deadline to `start + time` modulo 2^32. It starts no text display and does
not wait for sound completion. Its reason is `time`, and the normal strict deadline
and automode syncse rules apply. Rev.3257 evidence: handler `0x1400d3630`, getter
`0x140099980` (+0x44), Play `0x14016c670`, Stop `0x14016c970` and frame `0x1400c4940`.
Play captures the scheduler clock only when starting an inactive player; Stop clears
both the playing state and start tick. `scenario=2` remains explicitly unsupported.

`save.ts` preserves the native save gate: empty filename/force=false/clean sf state
performs no writes. A nonempty filename emits onSave before the scenario snapshot;
callback errors are reported and disable the callback before native save continues.
Dirty/forced global saves write global state, clear dirty, then write system state.
Persistence is a host effect.

`src/formats/artemis/save-file.ts` reads and writes the native `BOW` container
(`0x14013f940`/`0x14013fde0`: kind `G`/`X`/`S`, version 1003, zlib archive; 1001 raw
archives load, 1000 legacy archives are rejected) and the sectioned archive with its
trailing scope table. Scoped sections nest: each scope records its own section ids, the
table lists scopes in closing order with the root last, and the reader enters scopes in
order of their start offsets. `global-save.ts` serializes `saveg.dat` (section 1 read history,
section 2 `g.` variables) and `system.dat` (section 1 `s.` variables) and loads them
without dirtying variables.

`save-data.ts` is the save object (script +0xd0):
per message layer text commands since the last clear (+0x08), the font frames copied at
that clear (+0x18), indent/wordparts and prohibit commands pending (+0x38/+0x58) and
promoted by a clear (+0x28/+0x48), and looping se tags (+0x78); the layer command
registry (+0x68) and the BGM record (+0x88/+0x90) stay in their owners.
`replayArtemisScenario` replays these histories in the order of loader `0x140141b10`,
every tag with the replay flag. `scenario-save.ts` writes and reads their archive
sections (0x18, 0x19, 0x42/0x43/0x4b/0x4c, 0x1a, 0x35, 0x1c/0x1d) with the native
CScriptBlock layout, and `font-state.ts` serializes font frames as CFontProperty.
Section 0x1e holds the scenario variables (CArtemisVariables): the expression quote set,
every variable except `g.`/`s.`/`t.`, and the local frames; loading restores them without
dirtying and refuses quote sets or frame shapes this runtime does not produce.
`scenario-archive.ts` encodes the whole kind 'S' archive in writer `0x140140770` order
as a plain `ArtemisScenarioRecord`: the CCaret and call stack (a caret in run mode 5 or
above saves its previous mode, a waiting caret saves 0 and its mode), mode flags, icon,
glyph and CTweenInfo maps, push handlers and event slots, the save object, the 0x41 key
roles, the variables and an unused CBackLog (saved backlog pages are refused). Reading
returns only the sections present, so the loader keeps reset values for the rest.
`scenario-state.ts` connects the record to the live owners. `captureArtemisScenario`
reads each owner's `saveFields` (modes, key roles and push handlers, seton slots, message
selection, scene tweens, text controls, glyphs, Lua event names, save object) plus the host
scalars (+0x3628 font, macro list, debug fields) and the carets: the last caret is the
current one, earlier carets are the call stack, each with its own run mode and with the
wait flags it saved, so a save inside an event-handler scope records the interrupted
carets as the native writer does. `applyArtemisScenario` is loader `0x140141b10` after the archive
read: the `bf210` reset, plain assignment of each present section (absent sections keep
the reset values; key roles rebuild the constructor defaults and replace only the ordinary
keys), variables, carets, run mode 13, the tag replay with the glyph layer refresh between
the layer commands and BGM, then the run-mode release. `load.ts` is the save-file
reader `0x14013fde0` and the load tag `0x1400ca740`: an optional forced global save, the
file from the host's save directory, kinds G/X into read history and variables, S to the
host's scenario loader, then the `onLoad` handler with `{file}` (a Lua error is reported
and clears it). A loaded file whose tag has `type` continues as the trans tag. Unreadable
files and refused versions fail without a Lua call. The owner runs the handler through
`callEvent`, so a callback that issues resource tags finishes before the load returns.

Files in the save directory (SAVEPATH when it is a plain relative name) are host storage
behind `save-directory.ts`: `fileExists` and resource reads under that directory consult
the stored names, so saved thumbnails load like installation files. Native file writes are
synchronous, so a written or removed file exists or is gone for the script at once; the
storage changes apply in call order, and reads wait for the earlier changes. `screenshot.ts` implements `takess`
(`0x1400e1cf0`), which renders the scene offscreen into the engine screenshot surface,
and `savess` (`0x1400e1d90`), which scales that surface to `width`x`height` (stage size by
default), writes it as PNG (`.png` appended to an unextended name) and evicts the name
from the image cache. An evicted surface still held by layers stays alive until its last
holder releases it.
The engine reset empties the caret, which holds the wait flags: `ArtemisTimedWait.clear`
drops a pending wait without its release or Out event, so a caret saved inside a wait
resumes at its tag in run mode 0. The runtime's load tag runs the scenario loader; the
loaded carets keep their saved run modes and resume ready.

`tools/probe-artemis.mjs --save-load-at=N` saves a scenario archive before the Nth delivered click, loads it through `ArtemisLoad`
and continues from the restored caret instead of clicking. It requires the loaded state
to match the saved one with the caret written as loaded, and a second load of that state
to reproduce it; both loads run the game's `onLoad` handler. The report is `saveLoad`; a
differing round trip also writes the three archives (`roundtrip-*.bin`) to `--report-dir`.
These two loads use the same runtime. To verify restart separately, copy the generated
save directory and run a new probe with `--start-save=FILE --save-dir=COPY` and
`--expected-start-sha256=HASH`. It boots to the first native stop, loads that scenario
through the real loader and records the restored archive before `onLoad` in
`startSaveLoad` and `start-loaded-state.bin`; a differing expected hash refuses the run.
`--automode-limit=N` gives the click-wait after N automode-ended waits one pointer press on
no layer (report `automodeStop`: whether automode is still on). `--auto-choice=PREFIX` (repeatable) with `--auto-choices=N` continues a route once the
scripted `--layer-event`/`--key-push` inputs are used up: at a run mode 3 stop it picks the
first visible layer with an enabled click event whose id starts with a prefix and presses it
like `--press-at` (report `autoChoices`). `--press-at` delivers a browser pointer press in real
runtime frames once the text display completes: the pointer rests on the layer for half a
second, one frame samples key 1 down and the pointer stays for another half second. Game
Lua acts on a button in the key push handler that follows the layer's click handler.
`--screenshots` simulates the screenshot surface so that save tags with thumbnails, such
as a quick save, write their files. The report's `nativeTags` entries record the delivered clicks before each tag (`click`), which
places a tag on the route. `--save-dir=DIR`
starts the save directory with DIR's files and writes it back at the end, so a later run
continues from the global and system data of an earlier one. `--report-dir=DIR` writes every
report array longer than 10000 entries (also inside a top-level object) to an NDJSON file in
DIR, one entry per line, and `DIR/report.json` names the file in its place; long routes keep
every entry without one report string past the engine's string limit.

`reset.ts` implements the engine reset `0x1400bf210`. `dispatch` handles the reset tag
(`0x1400caad0`): a forced global save, automode off, mode defaults, owner resets through
the host, volumes (`0x1400c4680`), save-object histories, a restart at the
`ini.Boot` script, then erasure of every variable except `g.`/`s.`. `boot` is the
application start path: volumes default to 1000, `saveg.dat` and `system.dat` load, then
the static engine variables are written. `0x1400c4680` also runs in every frame after
`onEnterFrame`: `s.bgmvol`/`s.sevol` reach the music and effect managers when they change
(the configuration sliders write them), each effect id whose player is playing takes
`s.segain.<id>` (scope 1, immediately) when it differs from the player's gain, and ids
without a playing player leave the effect id map. Owners expose matching `reset` methods
(`ArtemisModes`, `ArtemisMessageLayers`/`ArtemisMessageSelection`, `ArtemisFontStack`,
`ArtemisSceneTweens`, `ArtemisRuby`, `ArtemisTextControls`, `ArtemisEventCommands`,
`ArtemisEvents.clear`, `ArtemisKeyBindings.resetPushHandlers`, `ArtemisTransition`,
`ArtemisLayers`, `ArtemisLayerCommands.clearAll`). `ArtemisScript.reset` drops the call
stack without popping local scopes and keeps the program cache, the tag queue and Lua
state, so cached inline Lua does not run again. Native construction leaves automode
disallowed until `[automode allow]`.

Probe `--advance-waits` advances its simulated clock beyond each timed deadline and
runs 16 ms frames through `scenario=1` waits, up to 10000 waits. `--clicks=N` delivers
up to N run mode 1 clicks at `@` click-waits, each after the text display completed. It is separate from actual user input and production scheduling.
The probe uses a windowed shared geometry fixture for fullscreen queries.

## Virtual paths and application arguments

`ArtemisFiles.setMagicPath(name, root)` stores one installation-relative alias;
empty root removes it. `resolvePath` substitutes `:name` once, appending the
literal suffix at its slash/backslash delimiter before loose/PFS lookup. Updates
retain overlay keys, case, Unicode and empty loose-file precedence. Native CLua
receives a tuple with numeric keys 1 and 2, copying only string values.

The native unknown/empty-alias branch reports success without opening a file.
This stateless ByteSource interface explicitly refuses that branch rather than
inventing a source or retaining a stale handle. Absolute/traversal roots and
nested alias roots are also outside its supported installation-relative subset.
Known aliases with a trailing directory separator are not file sources.

`get_exe_parameter` obtains the owner's already-parsed `ApplicationArguments`
map and writes dotted `name.key` variables into the selected local/global scope.
It preserves old keys absent from a later map, matching the native handler.
The shared application argument interface does not inspect the harness process
command line. The probe supplies an explicit empty application argument fixture.

`get_message_layer_width`, `get_message_layer_height` and `get_message_layer_line_width`
(`var` handler `0x1400e56a0`) read the selected message layer's text extents through
`messageLayerMeasure`. They are its virtual +0x140 (widest line up to the current line,
`0x140149d90`), +0x148 (current line y plus its height when it has glyphs, `0x140149e60`)
and +0x150 (last line width, `0x140149ea0`), which `ArtemisTextInsertion.measure`
implements. The float is truncated to int before it is written.

Recording flags and right-click configuration are kept in the mode owner:
`alreadyread` treats a missing mode as enabled, while `writebacklog` disables on
missing mode. Exact string `0` disables; `00` remains enabled. `rclick` preserves
its script filename when omitted and replaces it even with an explicit empty value.
These command flags do not implement backlog rendering or right-click dispatch by
themselves.

While `alreadyread` is enabled, the frame loop (`0x1400c0560`) checks every caret tag of a
named file before it runs; queued tags and the `alreadyread` tag itself are exempt. The read
history (`ArtemisReadHistory`, script +0xb50, `saveg.dat` section 1) holds the read tag
indices per file. A read tag writes `s.status.alreadyread` 1 once (latch byte b61). An
unread tag ends command skip unless `skip unread=1` is in effect; control skip is not
affected. If that leaves the caret with its file (a `setoncommandskipout` handler scope
leaves an empty caret and the tag waits), the tag is marked and a set latch writes
`s.status.alreadyread` 0. The script calls the check through the host `beforeCaretTag`.

`text-controls.ts` handles UTF-8 backlog/hide configuration. It preserves empty
comma-separated names, literal whitespace, include-font state and per-current-layer
backlog overrides. Omitting an override layer disables its use while retaining the
prior identifier. New backlog message layers are created/selected through the owner
and the current message layer is restored. Clearing backlog requires the storage
owner to clear every native collection. Configuration is not message/backlog rendering.

`key-bindings.ts` stores native signed ordinary-key sets in sorted order and keeps
codes 136/137 as separate flags. `keyconfig` clears the role first; missing keys
leave it empty, while explicit empty keys add ordinary code 0. `delonpush` removes
both native handler-map slots, using integer-zero for a missing key. Stored command
arguments are copied. `roleActive` answers a role through the input owner's decide or
down query: flag 136, flag 137, then the ordinary keys ascending. A decided role holding
Enter is refused while Alt is down and Enter decided (Alt+Enter is the fullscreen key).

`setEventFilter` retains a live Lua function independently of the tag-filter table.
`filterEvent` supplies the engine, event name and named arguments and preserves the
native 32-bit numeric result: zero falls through, two fails, and other nonzero
values consume successfully. Numeric strings are rejected. The event owner must
report Lua callback errors and continue its default dispatch, as the native owner
does.

`setUseMultiTouch` requires a numeric limit, truncates it toward zero and calls the
input owner's contact-limit operation. It is bound only when that owner exists;
the nonvisual probe records the configuration and does not simulate touch input.

`event-commands.ts` copies mode/hide/backlog/directory and window-button event
commands; `delon*` clears the matching slot (native stores an empty block, which event
dispatch skips). Window buttons are keyed by atoi(`button`), with a separate slot when
`button` is absent. Label-only
registrations capture the current script filename; explicit empty filenames are
preserved. `setonpush` replaces one of two per-key slots: missing/exact-zero
keyrepeat chooses slot 0, other strings choose slot 1. Registering one slot keeps
the other. These stores require mode/input owners to emit and dispatch events.

`native-library.ts` implements the synchronous native string-call ABI through the
shared `WindowsDynamicLibraryHost`. Modules are cached per owner after a successful
load; failed loads are retried. Each export receives a NUL-terminated string and
returns a native pointer. The owner copies the result before querying/calling
`Delete`; absent module/export, null result and absent `Delete` produce an empty
result, matching the native implementation. Browser DLL loading returns failure.
Successful native hosts must supply `readCString`. Module and export names currently
support ASCII only; legacy ANSI module-name encoding remains unsupported. Parameters
preserve the tag's exact bytes, including Unicode and embedded NULs; the export owns
their interpretation. `reset()` releases
cached modules in native byte-key order and clears the registry for later reuse.
Returned bytes are published through the variable owner without UTF-8 conversion.

`initializeArtemisResourcePaths` publishes the filesystem owner's resolved data
and save roots. It does not resolve Windows known folders or choose persistence.
The runtime keeps simple installation-relative SAVEPATH values. With SAVEPATH_CSIDL,
the filesystem host supplies an explicit virtual folder mount; the runtime joins the
relative SAVEPATH onto it, normalizing separators and dot components. Browser and
probe hosts mount CSIDL 26 (roaming application data) in an opaque virtual directory.
The published `s.savepath`, file-copy writes and file-existence reads all use the same
save-storage namespace. No directories or saves are written in the installed game.
An unmounted folder or a path escaping its mount is refused.

A resource owner can opt into `suspendableTags` and return `suspended` after
starting an asynchronous native tag operation. `createCall` keeps the Lua call's
arguments/locals; its owner resumes after applying the completed resource effects.
`ArtemisScript` drives `calllua` through those coroutines when opted in, suspends
nested calls, and resumes the deepest call before its callers. `resumeLua` supplies
completion values, while ordinary timed waits continue using `resume`. Resource
failures resume with false/error bytes and propagate through the suspended calls
as host refusals.
Loading another script cancels old Lua continuations; the resource owner must also
cancel or reject stale resource completions. Lua callback return values are discarded.

Tag filters also retain their continuation: the first numeric return decides
consume/fallthrough, and native dispatch receives the original arguments. Extra
returns are discarded, matching native single-result callbacks. Inline includes and
the click-wait, save and load callbacks remain synchronous. Lua 5.1
cannot yield across a protected C-call boundary; such asynchronous paths refuse.
The default owner keeps the original synchronous callback path. `ArtemisRuntime` always
uses the coroutine path.

The event filter (`setEventFilter`) and `onEnterFrame` run as coroutines in the frame
steps of `ArtemisRuntime.frame`: each raised layer event, the input update and clock, the
frame callback, the mode roles, and the run mode branch with the script. When a tag of such
a call loads a resource (an `seplay` of a click sound, for example), the frame holds:
`settleResource` awaits the operation, resumes the call, and runs the remaining steps with
the same input, so a push handler or mode role later in that frame still sees the click.
A held event filter reports the event as delivered; its status then decides the default
dispatch. A call nested in another Lua call or in the script run cannot hold; it fails and
its operation completes unawaited.

`image-loader.ts` resolves resources asynchronously with native extension preference,
then content sniffing of the exact file, then appended-extension candidates. Codec
registration and extension order are preserved; Unicode names/aliases stay unchanged.
The exact-hash factory selects PNG (`png`, `PNG`), JPEG (`jpg`, `jpeg`, `JPG`, `JPEG`),
then PSD (`psd`, `PSD`), matching the stage initializer. PNG uses the shared straight
RGBA decoder on the shared worker when available, with an in-thread fallback.
Merged PSD uses the format reader below on that same worker. JPEG uses an injected
owner ([Browser JPEG owner](#browser-jpeg-owner)) and refuses when selected without one. Decoder null means native failure/fallback; host and unsupported-format errors
propagate. Corrupt PNGs are refused by the strict shared reader, with one exception taken
from the native loader (0x1401838e0, libpng 1.6.21 with png_create_read_struct defaults):
an ancillary chunk whose CRC fails is dropped and the image loads (png_crc_finish
0x14005ccf0 only warns on stderr), `artemisPngDecodeOptions`. A dropped tRNS keys no
colour. A critical chunk's CRC failure still refuses the image. Image loading is
separate from cache eviction, layer geometry, property application and presentation.
The pipeline is verified with synthetic PNGs through suspended Lua callbacks.

`scene.ts` models the UTF-8 hierarchical child maps separately from image and
rendering owners. Dots separate components, including empty components. Missing
ancestors become empty groups; removing the last child keeps its parent group.
The image-backed constructor has native type 1 and blocks child traversal;
empty groups have type 0. Owners explicitly select the group type when inserting
a group payload. Mutations copy each affected current child map while
retaining its previous structure; `commit()` recursively releases that structural
version. Both map and inner-actor buffers retain their physical slot indices;
nodes shared between maps keep their resources until their last reference.
Presentation timing remains a separate owner. Relevant native entries:
`0x140185bf0`, `0x1400b3340`.

Child order compares signed decimal keys numerically when both are numeric and
otherwise compares UTF-8 bytes (`0x140185740`). Equivalent keys such as `2` and
`02` preserve the first stored spelling. Native accepts a lone minus as numeric
zero. Rev.2908's predicate (`0x5eeb00`, comparator `0x5eeb50`) also accepts an
empty component as numeric zero; other profiles retain their previous empty-key
behavior. Numeric-looking nonnumeric components such as `4time` are accepted
when all sibling comparisons, including aliases used for lookup, preserve a
strict weak order. Every lookup/insertion in such a domain checks all siblings
before mutation. Cyclic domains (for example `2 < 10 < 1x < 2`), inconsistent
alias queries and numeric overflow remain explicit refusals: a sorted-array
model cannot reproduce an ambiguous native red/black tree. This scene subset requires the
exact executable hash. `entries()` exposes structural traversal for owners; it
is separate from native selection. `select(id)` expands the current selected
subtree in child order and preserves the requested id spelling in its prefix
(`0x140113e50`, `0x140113ab0`). Wildcards and shader/message selection are
outside this child-map API.

`layers.ts` connects the ordinary image-backed `lyc`, `lydel` and geometry subset
of `lyprop` to the image loader and scene. Its required graphics owner allocates,
copies and releases native image actors, applies properties, and owns outer-wrapper
alpha and native command registrations. `lyc` sets float32 anchors to half the
image dimensions, deletes the previous selected subtree only after successful
resource creation, inserts an image leaf and resets that id's command list.
Creation-tag geometry arguments are not applied: the native command uses separate
`lyprop`. A missing resource reports a script error while preserving the old layer.
`mask` loads a second image through the same cache; a failed load or a mask whose surface
format is not 0 reports the same error, releases the image and keeps the old layer.
Otherwise the new actor receives it through the CLayer mask setter (see "Layer masks"),
which keeps it only for a same-size format 1 or 2 texture. `lyprop` never reads `mask`.
Rules and capture-mode creation are explicitly unsupported. When file loading
fails and width/height/color are all present, solid fallback uses shared straight
RGBA fill. Six-byte colors and eight-byte 0x/0X forms select RGB with forced opaque
alpha; other forms select ARGB. Hex conversion preserves native prefix/sign and
uint32 overflow saturation. Decimal dimensions preserve atoi prefixes; negative
dimensions and signed allocation overflow refuse. Missing any fallback field
reports the normal load error. Native surface resize/fill: 0x1401910e0/0x140191250.
Relevant native entries: `0x1400d5930`, `0x1400d6670`, `0x14014f2a0`.

Ordinary image properties copy the inner actor on the first edit after commit,
retaining its old state (`0x1400b49c0`). Left/top, anchors, rotation, alpha,
percentage scale and reverse/visible flags are supported. Decimal prefixes use
native-style conversion; nonfinite/hex values and other property keys refuse.
Only exact `0` disables flags. Inner alpha rounds to float32 before division by
255; outer-wrapper alpha divides as double before float32 conversion. Values
are not clamped by the adapter. Applying these values and recording the original
command require owner effects. Root/shader properties and the alternate
retained-actor editing mode remain unsupported. Ordinary and intermediate group
properties are described below. Native entries:
`0x140115650`, `0x1400d76d0`.

Use the layer owner's `commit()` at a confirmed native commit boundary. It releases
actors absent from all reachable current/retained child maps and inner-actor versions.
Commit visits current children ascending, releases the node's old actor, then
clears its old child map. Full-map destruction releases children descending
(`0x1400ec380`, `0x1400f0f70`). A removed node destroys physical map slots 1 then 0,
followed by actor slots 1 then 0 (`0x1400b1860`). Shared-node and payload references
preserve this order without releasing live aliases. The layer owner processes
scene release notifications in order, so surface-cache victims and idle FIFO
depend on native lifetime order rather than actor allocation order.
`close()` cancels pending work and clears both scene buffers in that order.
Scene release callbacks only record notifications; they must not mutate the scene
or throw. Owners must return fresh
actors from create/copy and retain shared image resources when copying. Async
resource dispatch rejects overlapping operations and snapshots tag arguments;
`cancelPending()` prevents stale completion effects alongside cancellation of
Lua continuations. These services are tested with synthetic images and suspended
Lua.

The scene/layer system checks run with:

```sh
node --test tests/artemis-scene.test.mjs tests/artemis-image-worker.test.mjs
```

`display-object.ts` implements native CDisplayObject defaults and float32 local
matrix composition. Translation, anchor translation, rotation, scale, reversal
and inverse-anchor translation preserve the native order, rounding and strict
snap below `2^-23` after each operation (`0x1400a1060`, `0x1400a14b0`,
`0x14009ff30`). Matrices use `[a,b,tx,c,d,ty]`. Nonzero rotations require an
injected native float trig owner; zero rotation is exact without one. Arbitrary
JS Math trigonometry is not silently substituted.

`image-graphics.ts` implements ordinary unclipped straight-RGBA image actors
through shared `DrawListTarget`. Native command/error services, sampler and blend
selection remain explicit providers. `createArtemisOrdinaryGpuRaster()` supplies
the confirmed ordinary D3D11 policy for this exact revision's single-level image
subset. Actors prepare their images before scene
insertion; copies share texture ownership and outer-wrapper metadata while copying
inner display state. The last actor releases its image binding. Groups, shaders and
transitions are described in their own sections, layer masks in "Layer masks" below.

`drawCommitted()` emits retained GPU images in ascending child order through the
preparation path (`0x140186770`); higher numeric ids paint after lower ids. The
separate ordinary callback path (`0x1401864a0`) traverses descending for non-raster
effects. Native selection and structural traversal remain ascending. Image quads
preserve float32 transform,
viewport normalization and triangle-strip order (`0x14015d120`). The stage owner
chooses frame/commit timing; `drawStage` presents the stage and its transitions.

Shared `WebGLDrawTarget.prepareImage()` uploads and retains an image until
`invalidate()`, including empty/hidden frames. Normal unprepared images retain
per-frame eviction behavior. Failed uploads delete their partial GPU allocation.
`tests/browser/artemis-images.html` checks synthetic PNG decoding, Lua suspension,
actual shared WebGL alpha pixels, ascending GPU overlap order, retained resources and
upload-error cleanup. It contains no game assets. Browser checks use explicit
sampler/blend fixtures and do not establish native GPU equivalence.

`stage.ts` supplies native `flip` through required stage effects. Nonzero script
capture mode returns immediately. Transition state 2 clears the transition rule
and resets the transition layer's virtual +0xe0 value to uint32 -1 before changing
state. The adapter then writes transition state 0, marks the scene dirty, commits
the actual layer/resource owner and changes a nonzero refresh state to 2. Refresh
state is read after commit, preserving effects from resource release callbacks.
Native entries: flip prefix `0x1400e10a0` and helper `0x14014f420`.

`transition.ts` implements native `trans` (`0x1400e10c0`). `ArtemisStage.commit` is the
shared stage commit `0x14014f420`. Type `0` commits, enters run mode 4 and writes the wait
timestamp b94 = now; the wait owner (`ArtemisTimedWait.setDeadline`) ends that flagless wait
in the first frame after the timestamp, as c0560 does for any passed b94. Type `1` sets transition state 1 and registers a float crossfade tween (0 to 1
over `time`, `ArtemisLinearFloatTween`) that writes the transition layer value. Type `2`
loads the `rule` image (load failure and non-gray formats report the native severity-1
errors through the runtime's `reportTagError` service, c7260, and the tag returns without a
transition; without that service they stay refusals), replaces or tiles (`tileArtemisRule`, `0x140171140`) the stage rule image, sets
state 2 and tweens the threshold from `-vague` to `vague+255`. Both tweens complete through
stage commit and run mode release. `input` selects run mode 2 (clickable) or 4. The frame
owner ticks registered tweens and finishes `tween` on a mode 2 click.
`ArtemisImageGraphics.drawStage` draws the transition.

The browser stage renders the pending `current` scene as the target during both crossfade
and rule transitions. Its saved previous GPU frame supplies the source. Scene/resource
commit remains at tween completion; ordinary frames and screenshots use `retained`.

The script draws its Windows cursor as a root layer whose ID is `csv.mw.cursor.id` and
moves it every vsync with a zero-length `lytween`. In the original the cursor stays
sharp and follows the pointer during crossfade and rule transitions. The browser reads
that ID each frame; `drawStage` leaves the layer out of both transition surfaces and
draws its current actor after stage composition, so no frozen copy fades with the saved
frame. A nested, missing or malformed ID leaves the layer in place.

`png-surface.ts` supplies libpng's ancillary-CRC discard behavior and accepts bytes after
`IEND`: the native CPng loader destroys its reader after image/end reads without checking
file EOF. Other PNG consumers keep strict trailing-byte and CRC validation by default.
The probe's surface worker uses the same options and preserves codec errors on fallback.
`png-surface.ts` (`artemisPngSurface`) converts a decoded PNG into the native CPng image
(`0x1401838e0`): colour type 0 (gray) becomes format 0 with one byte per pixel (low depths
bit-replicated, 16-bit high byte, gray tRNS ignored); every other colour type becomes
format 2 with four bytes per pixel. Rule hosts load rule images through the stage loader
and pass this surface to `trans`, so only gray PNG rules are accepted. The probe's metadata
fixture decodes rule images this way and records only their path, format, size and
SHA-256.

The flip prefix is present as a Ghidra label rather than a canonical function;
its saved raw bytes/instructions confirm the capture-mode branch and tail jump.
`flip` marks presentation
pending; the scheduler/presenter decides when to draw. It does not bypass required
transition effects or silently perform them with a scene commit alone.

`layer-commands.ts` owns the native per-id command lists required by the raster
services (`0x140144570`, called by `0x1400b9cd0`). Missing id does not record a
command. Recording scans backward for the newest same-name command whose selected
comparison keys exist and match in both argument maps. It merges incoming
arguments into that record without replacing the earlier line/name; intervening
commands do not prevent merging. An overwritten argument takes the incoming exact bytes
(or none for plain text). Ordinary properties use an empty comparison-key set. Other
registration owners can supply their native key sets. Outside replay, `lyprop` and
`lytween` record through this coalescing path.

Lists preserve raw id strings, so numeric aliases remain separate registry keys.
Reset (`0x1400edec0`, used by `lyc`, anime `init` and video outside replay) makes the
list a copy of the creating tag alone; deletion removes exact selected ids. Returned history
and UTF-8-byte-ordered snapshots copy argument maps. These data are inputs for the
native save owner; the registry does not serialize them as a substitute save format.
The browser fixture connects actual reset/clear/property recording to this registry.

`gpu-raster.ts` maps the ordinary D3D11 sampler and blend descriptor to shared
draw commands. Native renderer initialization `0x14015f1d0` creates filter 0x15
with clamp addressing, and `0x14015fd30` binds that sampler at slot 0. Ordinary
shader-table entry 0 samples the foreground texture and multiplies its alpha;
it does not discard transparent texels. Mode 0 in `0x14015d120` uses RGB source
alpha / inverse source alpha, but alpha source alpha / one. Alpha accumulates the source alpha squared plus
the previous target alpha, clamped to the target format. Native frame
clear `0x14015fe10` supplies transparent black. Shared `DrawList.clearColor`
preserves the existing opaque-black default for other callers.

These constants map to Microsoft's [D3D11 filter enumeration](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ne-d3d11-d3d11_filter),
[blend enumeration](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ne-d3d11-d3d11_blend)
and [render-target descriptor](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ns-d3d11-d3d11_render_target_blend_desc).
The synthetic browser test reads actual framebuffer RGBA while scaling a
transparent-red/half-alpha-green PNG over quarter-alpha red. It checks linear interpolation,
independent alpha writes, transparent-fragment writes and transparent clear.
This establishes the implemented WebGL behavior against the recovered equations;
it is not a native GPU differential test. Texture mip chains,
custom shaders and alternate rendering backends remain outside this policy.

`lyprop clip` accepts exactly four comma-separated fields: left, top, width and
height. Prefix float parsing includes empty fields as zero and stops at NUL.
Inclusive right/bottom endpoints use separate float32 addition and subtraction
of one (`0x140115650`). The native setter compares only left/top/right/bottom
before copying all six fields (`0x1400a45d0`); the initial all-zero rectangle
therefore ignores `0,0,1,1`. Unchanged rounded endpoints preserve the old dimensions.
Clip state is retained independently of geometry and wrapper alpha.

Positive width and height enable source cropping. An entirely outside rectangle
skips drawing; nonpositive dimensions disable cropping. The resulting quad starts
at local zero with its cropped size, while UVs retain the clamped source offset
(`0x14015d120`). Anchors keep their original image values. Linear sampling still
uses the full texture, including adjacent texels at a clip boundary. Node tests
check retained state, inclusive bounds and endpoint rounding; the synthetic GPU
fixture checks the rebased cropped quad and actual linear-sampled framebuffer.

`lyprop clickablethreshold` is read with `atoi` in `0x1400d76d0` and forwarded by the
CArtemisLayer setter `0x1400b2e10` to the inner actors, which store it at +0x168
(`0x1400a4960`); actor copies keep it. `ArtemisDisplayObject.clickableThreshold` holds
the value and `hitsAlpha` is the pixel step of image hit test `0x14017b6a0`: threshold
0 hits without reading the pixel, otherwise the alpha byte must reach the threshold as
an unsigned comparison. Pointer selection of the hit actor belongs to the pointer owner.
`lyprop draggable` sets actor +0x16c unless the value is exactly `0` (`0x1400a4970`);
`dragarea` takes exactly four comma fields through `atof` as left, top, right and bottom
and stores a TRect<float> whose sizes are the endpoint differences plus 1 at +0x170
(`0x1400a4980`); other field counts are ignored. Both start zero and survive actor
copies (`ArtemisDisplayObject.draggable`, `dragArea`). The glyph tag clears the same byte
on its layers. Pointer dragging raises the dragin/drag/dragout layer events and moves a
draggable actor inside its area (`ArtemisLayerOwner.updatePointer`).

`lyprop layermode` preserves the native exact spellings `normal`, `add`, `screen`
and `multiply`; any other value leaves the old mode intact (`0x140115650`). Mode
state belongs to the inner image actor and is copied independently of its shared
outer-wrapper alpha. Retained rendering keeps the earlier mode until commit.
Custom raster policies must supply their mode owner before non-normal modes can
be applied. Native setter `0x1400a4680` changes field +0x100 and invalidates the
blend state; the shared renderer selects each draw's blend explicitly.

Add uses source-alpha / one for RGB. Screen's shader 24 premultiplies RGB by its
effective alpha, outputs alpha 0 and blends inverse-destination-color / one.
Multiply's shader 48 interpolates foreground RGB toward white as effective alpha
decreases, outputs alpha 1 and blends zero / source-color. Their distinct alpha
outputs are preserved, including transparent texels in multiply. The browser
fixture checks actual framebuffer RGBA for all four ordinary modes. Captured-back
shader variants and color-key mode remain unsupported.

`negative`, `grayscale` and `colormultiply` belong to the same copied inner actor.
Native setters `0x1400a46d0`, `0x1400a46f0` and `0x1400a4710` invalidate its
shader state. The 24 recovered foreground shaders (indices 0–7, 24–31 and 48–55)
apply negative, then grayscale, then RGB multiplication, before the mode's
alpha expression. Grayscale uses weights 0.298912, 0.586611 and 0.114478.
Color bytes are divided by 255 as float32; the high byte does not affect RGB.
Boolean properties preserve the native exact `"0"` comparison, and hexadecimal
colors preserve Windows uint32 prefix parsing and overflow saturation.
Custom raster policies require an effects owner before any non-default effect
is applied. The synthetic browser fixture checks framebuffer pixels for all
32 combinations of four modes and three effect flags; these checks do not
establish native GPU rounding equivalence.

The exact-hash raster policy also exposes the format-2 captured-background
shaders (indices 72–79, 96–103, 120–127 and 144–151). These sample a GPU
snapshot through additional texture 0 and replace the destination RGBA without
hardware blending. Alpha uses `back.a * (1 - fore.a) + fore.a`; RGB follows the
native normal/add/screen/multiply formulas and divides by that output alpha.
The native zero-alpha division is preserved. All 32 effect combinations are
checked with synthetic nonzero-alpha foreground/background texels in Chrome.
The group owner below schedules these shaders with GPU background copies.

`surface-cache.ts` supplies the ordinary native surface-manager loan policy
(`0x140011a90`, `0x140012200`, `0x1400116b0`). Requested UTF-8 names are exact cache
keys, independently of the loader's resolved extension/path. Active hits add a
loan; idle hits remove the surface from its FIFO position and reuse it. Only a
miss trims oldest idle surfaces, and only while the current total exceeds the
budget. It does not reserve space for the new resource, so active surfaces can
exceed the budget. The last loan disposes its surface immediately when over
budget; otherwise it appends the surface to the idle FIFO. Active resources are
never evicted by trimming.

The host supplies the uint64 budget, native storage size and actual surface
prepare/dispose effects. Decoded RGBA length is not assumed to be native GPU
storage size. Idle resources retain their GPU binding through empty frames.
Cache shutdown releases idle resources immediately and defers active disposal
until the last loan returns. A decode completing after shutdown is disposed.
Worker preloading and overlapping native load modes are explicitly unsupported.

`ArtemisLoadedImage.lease` represents one load's loan. Successful layer creation
transfers it to the outer image wrapper. Current/retained inner actor copies share
that wrapper; they do not add surface-manager loans. Separate layers each retain
their own loan even when sharing one texture. Cancellation, failed actor creation
and blocked scene insertion release their unadopted resource. Ordinary unmanaged
images keep the earlier last-actor invalidation behavior. Cached resources use the
surface owner's disposal effect instead. Close layers before closing the cache
and raster target at installation shutdown.

## Tweens and layer tweens

`tween.ts` holds the shared `TTween` template (constructor `0x1400ef000`; float step
`0x1400ee310` and finish `0x1400ee280`, identical to the integer step `0x1400eccf0`).
`ArtemisTween` initializes on its first tick (`start = delay + now`, zero start is the
uninitialized sentinel) and compares absolute uint32 times. At the end of a play it
either completes (applies `to`, marks done, runs the completion) or starts the next play
at `loopdelay - overshoot + now`, where an overshoot of at least one duration counts as 0.
`loop` (or `repeat`) counts extra plays and `yoyo` counts reversals that swap `from` and
`to`; -1 repeats forever. Finish applies `from` while an odd yoyo count is pending,
otherwise `to`. `artemisEase` is the 30-curve switch (quad, cubic, quart, quint, expo,
circ, sine, back, elastic, bounce; in/out/inout) with the native float-rounded constants.
Ease 0 and unknown ids are linear. `ArtemisLinearIntegerTween` (truncating) and
`ArtemisLinearFloatTween` (float32) are the curve-0 forms used by transitions and audio.

`ArtemisTweenRegistry` is the global registry: register `0x1400a5360` returns ids from
one uint32 counter, and registrations made during a step wait in a pending map that is
merged after the step. The frame step `0x14019aa00` destroys tweens that report done.
Finish `0x1400a54b0` searches the active map, then the pending map. Steps visit tweens in
registration order.

`layer-tweens.ts` implements `lytween` (`0x1400da830`), `lytweendel` (`0x1400dd3a0`),
`tweenset` (`0x1400dd840`) and `/tweenset` (`0x1400dd8f0`) for direct scene layers:

- Missing ids report the native layer-not-found error. Root (`!`) and alias (`~`)
  owners are refused as unsupported.
- `param` selects `left`, `top`, `alpha` (/255), `xscale`/`yscale` (/100) or `rotate`.
  Any other parameter returns without registration or history.
- Duration is `time`, else `msec`. Absent `id`, `from`, `to`, `param` and `time` are
  inserted as empty strings, as `std::map::operator[]` does, and stay in recorded copies.
- The setter holds the layer node (`ArtemisScene.layer`). It writes the current inner
  actor and, when distinct, the retained one; it never copies the actor or touches the
  outer wrapper alpha. The start value is applied at creation.
- Completion is chosen in this order: `sync` (not `"0"`) enters run mode 4 and the
  completion sets the run mode to 0. `delete` removes the layer through the `lydel`
  body (`ArtemisLayers.deleteLayer`). `file`, `label` or `handler` emits the tag as a
  script event.
- History: infinite `loop`/`yoyo` or `delete` appends the tag to the layer's command list.
  Otherwise an `lyprop` with the end value string is recorded. Scenario replay forwards
  the history flag through the dispatcher and layer owner: the tween is recreated without
  recording it again, so repeated loads keep the same command registry.
- `lytweendel` finishes every tween registered on the layer and erases its `lytween`
  commands.
- `tweenset` opens a tween group (`ArtemisTweenQueue`, CTweenQueue) unless one is open.
  While it is open, `lytween` appends its tween to the group instead of registering it,
  applies no start value and collects the tag `id`; sync, completion and history are
  unchanged. `/tweenset` registers the group as one registry entry and adds that id to the
  layer of every collected id; ids without a layer are skipped. The group steps only its
  front tween, so the tweens play one after another, each starting on its first step;
  finishing the group finishes every remaining tween in order.

## Ordinary group display properties

Empty hierarchy nodes allocate their native identity property holder through
`createGroupLayer` when created. Ordinary `lyprop` can update that group's geometry, alpha,
visibility and reversals. First edits retain the previous inner state until commit;
subsequent edits reuse the current copy. The shared outer alpha metadata remains
separate from draw opacity. No image texture or resource loan belongs to an empty
ordinary group.

The raster traversal follows native ascending GPU preparation order (`0x140186770`),
composes each child's float32 matrix with its parent's world matrix, and multiplies
parent/child alpha in float32 (`0x14015b440`, `0x1400b3790`). Hidden groups,
nonpositive scales and effective group alpha below `2**-23`
suppress their entire descendant branch during preparation. Group anchors default
to zero; image anchors remain centered. Empty dotted identifiers and numeric aliases
retain scene lookup semantics. Nonzero group rotation still requires the native
float trig owner.

The display owner retains the native parent-matrix acceptance state
(`0x14015adc0`, `0x14015b440`). All six float32 differences must be strictly below
`2**-23` to preserve the previous parent matrix; reaching the threshold updates all
six coefficients together. Inner copies preserve this parent and world state
(`0x1400a17c0`). The browser memoizes unchanged geometry calculations, while alpha
and visibility remain live. Each implicit group owns its own display state.
Native updates a holder's matrix before testing its own visibility or alpha;
nonpositive scales and a gated ancestor prevent that update. Consequently a hidden
rotated holder still needs the native trig provider.

## Intermediate group composition

`lyprop intermediate_render` changes the group's shared node configuration before
holder commit. Exact `0` disables and releases capture storage; every other value
enables it. Exact `1` selects format2, exact `2` format1, and other values retain
its previous format (initially2). Type1 image leaves ignore this configuration,
as native `0x1400b30b0` does. Group clip, layer mode and color effects belong to
its copied holder and are used when rendering the group's captured result.
They do not affect a direct group with intermediate rendering disabled.

The retained GPU path binds a persistent surface, prepares children ascending with
identity translated by minus the capture bounds and alpha1, restores the parent
target, then paints the captured layer using the group's matrix, opacity and
raster effects. Nested captures restore their own parent target. Format2 uses
the captured-background shader and a GPU snapshot before each layer; format1 uses
the ordinary blend path. Neither surface format forces alpha opaque.

Positive clip dimensions select explicit bounds with float32 left/top and ceiled
allocation dimensions. The output clip starts at0,0 and preserves the original
fractional width/height. Otherwise bounds callbacks walk descendants regardless
of visibility/alpha, composing uncached local transforms and extending four
pixel-center corners at0 and dimension-minus-one. Nonzero image clip dimensions
override natural dimensions independently. The bounds rectangle starts with all
six fields0; extending an endpoint recomputes its dimension inclusively. This
preserves origin inclusion and the native degenerate single-point behavior.
Nonzero rotation still requires the native float trig owner.

Without a mask, capture storage is resized only when either requested dimension
exceeds capacity. Both dimensions become the newly requested values. A change of
preferred format alone does not replace existing storage; its old format remains
until resizing. Holder copies share capture ownership, and disabling/releasing
the final wrapper releases each GPU attachment once. Allocation failure leaves
existing browser storage owned, reports the failure and permits a retry; the
native flags0 fallback has no browser render-target implementation.

With a node mask (see "Layer masks") the capture is sized exactly to the mask,
starts at the group origin (no bounds offset) and is reallocated whenever either
dimension differs. The output layer keeps left/top 0; a positive group clip is
used as the output clip unchanged, otherwise the whole capture is drawn.

Unchanged committed descendants reuse their captured surface. Preparation tracks
actor identities, property changes, child keys, clips and nested capture configuration;
a failed draw does not mark pending snapshots reusable. Parent geometry/alpha
updates can repaint a cached capture. Clear is lazy: the first eligible image
preparation clears the entire intermediate target before source clip rejection.
A capture containing no eligible image retains earlier pixels, including when
empty auto bounds fit an existing allocation. The main presentation clear remains
independent of this intermediate rule.

The synthetic browser pipeline checks actual RGBA for both formats, nested targets,
retention, effects, growth and empty captures. Current-view capture buffers and
full native dirty-flag accounting remain unsupported.

## Layer masks

`lyprop intermediate_render_mask` loads its file through the surface cache (the
same cache as `lyc`) and passes the result, or null when the load fails or the
name is empty, to the node mask setter `0x1400b29c0`:

- Group (type 0): the node stores the mask and marks its display dirty. The group
  capture uses it for sizing (above) and, on every capture draw, offers it to the
  capture layer.
- Image (type 1): the current inner actor, then the retained one, receive it
  through the CLayer setter `0x1400a4490`. Video and other actors are refused.

The CLayer setter always stores null. A non-null mask is stored only when the
layer has a texture of surface format 1 or 2, the mask has format 0 and both
have equal dimensions; otherwise the earlier mask stays. Changing the texture
(`0x1400a43f0`) clears the mask. Surface formats come from the image loader:
PNG grayscale is 0, every other PNG colour type 2. An unknown format is refused.

A stored mask selects the masked shader variants: before the alpha multiplier and
effects, foreground alpha is multiplied by the mask's red channel sampled at the
foreground coordinates in the D3D11 profiles. Rev.2898 uses an A8 upload view and
samples its alpha instead. Its eighteen mask-using custom presets also sample
alpha at the original foreground UV; reset ignores it. The DX9 effect retains
its mask assignment when a later actor omits the setter. Other custom preset
sources receive no mask term. The
transition-mask variant (CLayer `+0x150`) is not modeled.

## Merged PSD images

`src/formats/artemis/psd.ts` implements the default CPsdLoader merged-image path
(`0x140187d00`), selected with matte recovery enabled by the exact stage initializer
(`0x14014d100`). It accepts PSD1, 8-bit RGB documents with three/four channels and
raw or RLE planar composite data. It skips color/resources/layer sections and
reads the merged image; the other engines' first-layer decoder is not used.

RLE preserves the native `0x80` repeat129 interpretation and channel-major row
counts. Three channels force opaque alpha. With four channels, nonzero partial
alpha recovers color with signed integer division toward zero:
`clamp(trunc((channel - 255) * 256 / alpha) + 255)`. Zero-alpha RGB is preserved;
an entirely zero alpha plane is instead treated as absent and forced opaque.
The reader validates source ranges before allocating output, and refuses
incomplete/overrunning rows or native unsafe signed row lengths rather than
publishing uninitialized pixels.

The shared image worker accepts `artemis-psd`; input is snapshotted and never
transferred away from archive/cache ownership. Worker failures rerun the same
in-thread decoder to report its original error. Synthetic checks compare raw/RLE
output, recovery and channel order, real worker transport and resulting WebGL
RGBA. Named layers, PSB, additional color/depth/compression layouts remain
unsupported.

## Browser JPEG owner

`createArtemisBrowserImageLoader` keeps the exact stage codec order and supplies
an opaque RGB JPEG owner using the shared `opaque-jpeg` worker service. The base
`createArtemisImageLoader` still permits an injected JPEG decoder for other hosts.
The native default CJpg file path (`0x140178e80` / `0x140179120`) has no alpha sidecar;
its grayscale format0 and paired-alpha path remain unsupported by this browser owner.

Each codec may report the native surface format of its image (`surfaceFormat`);
the loader passes it through with the decoded resource for the mask rules above.

The shared marker reader strips APP1/APP2 metadata before browser decoding, so
EXIF orientation and ICC profiles do not change stored pixels/dimensions. It
preserves stuffed entropy bytes, restart markers and metadata between scans.
The decoder accepts 8-bit, three-component baseline/progressive frames and checks
that returned dimensions match the stored JPEG frame. Browser bitmap/readback
must preserve opaque alpha. Archive bytes are snapshotted for worker transfer,
and generic browser Blob construction copies exactly the supplied byte view.

The synthetic Chrome check encodes a2x3 solid JPEG, injects valid EXIF orientation6,
confirms the ordinary browser bitmap rotates to3x2, and verifies that the Artemis
owner keeps2x3 and paints expected RGB. This validates ownership and metadata
policy, not byte-exact equality to the native JPEG library's DCT/color rounding.

## Animation layers

`anime` (`0x1400ddc70`) builds frame animations; `animedel` binds the `lydel` body
(`0x1400d6670`). `ArtemisLayers.dispatch` handles both. Outside capture mode:

- `init` and `add` load `file` into a frame actor (anchor at the image centre, then the
  tag's `0x140115650` properties such as `clip`). A failed load reports the
  file-not-found error. `mask` is refused: there is no mask owner.
- `init` deletes the id through the `lydel` body and inserts a new `CAnimationLayer`
  holding the frame at key 0. `loop` sets the loop count (default -1, endless).
- `add` stores the frame at key `time` of the existing animation; key 0 is ignored and
  the frame released. `end` stores the end marker at `time`. Both update the layer in
  place. A missing id or a non-animation layer reports
  「指定されたアニメーションが見つかりません。」; any other `mode` reports the mode error.
- History: `init` empties the id's command list; `add` and `end` append the tag, which
  carries the empty values inserted by `std::map::operator[]` reads. Error paths record
  nothing.

`ArtemisAnimationFrames` (`animation-layer.ts`) is the `CAnimationLayer` state: a map
from uint32 milliseconds to reference-counted frames, the start time, the current key and
the loop count. `update(now)` (`0x140156400`) starts the clock on its first call and
moves through every key whose time has elapsed. At the end marker it either stops on the
last frame (loop count 0) or decrements a positive count, moves the start time by the
marker key and restarts from key 0. Copies (`0x1400b0e90`) share frames but advance on
their own.

`ArtemisImageGraphics` draws an animation actor with its own geometry and only the
current frame as a child. Each `drawCommitted` samples its `clock` once and updates every
drawn animation first, as the native draw passes (`0x1400b1240`, `0x1400b12a0`) do.

## Video layers

`video.ts` models the native CTheora object (vtable `0x1403636f8`) behind the `video`
tag's layer path (`0x1400e4650` with `id`), decoding through `src/formats/theora`.

- Open order is `file`, `file.mja`, `file.ogv`; a missing file reports
  `videoError('not-found')`, a non-Theora Ogg reports `videoError('unsupported')`. CMja
  (`.mja`) data is refused explicitly.
- The `_m` mask (`stem_m.ext` of the opened name) decodes alongside; its luma is the
  alpha channel at the main stream's picture offsets. Without a mask alpha is 0xff.
- `loop` is on when present and not exactly `"0"`. `delaymargin` enables frame skipping:
  when the clock is more than one frame behind and the delay exceeds the margin, the
  target jumps by up to ceil(fps) frames and only intra frames are decoded on the way.
- `update(now)` is slot +0x10: frame k is shown from `start + k * 1000/fps` ms (float32
  arithmetic, as native). When data is exhausted and the target passes the last frame the
  decoder closes and `onFinish` runs; `playing` turns false.
- Conversion uses the native integer tables and 4:2:0 chroma indexing for every pixel
  format, producing the picture region in RGBA.
- `video-thread.ts` holds the decode threads (`0x140017010`) of the main and mask
  streams and the conversion. Native update waits until the threads reach the target it
  set last, and the threads decode the next target while the frame renders. An
  `ArtemisTheoraThreadOpener` decides where they run: on the caller's thread by default
  (the probe and tests), or in one worker per video (`video-thread-client.ts`,
  `video-thread-worker.ts`), which the browser layers use. With a worker an update that
  finds the threads still decoding returns without effect, so the shown picture and the
  frame clock wait for a later update instead of blocking the frame; frames late by more
  than `delaymargin` are then skipped as natively. The worker's picture is copied into
  the video surface and its buffer returns with the next target.

The layer is anchored at its centre, replaces the old layer like `lydel`, and outside
replay empties the id's command list. `image-graphics.ts` draws a video actor as an
image actor whose texture is re-uploaded when the decoder revision changes; the decoder
is updated once per draw with the draw's clock sample, and closed when its last actor
copy is released. `wait video=<id>` is described in
[Timed waits and save requests](#timed-waits-and-save-requests).

### Fullscreen video

`fullscreen-video.ts` owns the `video` tag without `id` and the run mode 7 frame branch.
The tag does nothing while debug-skipping; otherwise it plays `file` through the shared
`FullscreenMoviePlayer` (`src/video/fullscreen-movie.ts`) with `mode` (default 0) as the
renderer selector and `s.videovol` converted by `artemisSoundAttenuation`. A failed open
reports the native playback error 「再生に失敗しました。」 and leaves the run mode alone;
otherwise `skip` (default 1) is stored and run mode 7 is entered (not from mode 13).
Every mode 7 frame releases the run mode once the player has stopped; skip 1 also ends
the movie on key role 0 or active skip, skip 2 on key role 1, closing the player,
releasing the run mode and writing `s.clickskip`.

The native player is a DirectShow graph rendering the loose file. The game's movies are
ASF files with WMV3 or WVC1 video and WMA Standard, Pro or Lossless audio, which browsers cannot
decode. `BrowserFullscreenMoviePlayer` streams an ASF file through the shared software
movie player: `AsfMovie` (`src/formats/asf/movie.ts`) decodes it in the movie worker
with the standalone Windows Media decoder (`src/formats/vc1/`, `src/formats/wma/`), the audio clock paces the
pictures and a canvas covering the game element shows them. The game's muxer places WMA
blocks up to the ASF preroll (1451 or 3000 ms) behind the video of the same time, so the
reader decodes audio as it reads packets and holds video objects compressed until packets
a preroll later are read (`AsfPrerollQueue`); a batch then never ends with its audio
behind its frames. Each batch decodes at most eight video objects, and four reads stay in
flight ahead of demuxing, so neither a low-bitrate stretch nor a slow read of the file
keeps the worker past the decoded video ahead of the clock. Pictures and audio share one
clock, the audio context's time: a picture is selected once the clock reaches its
presentation time, so the decoded audio ahead is buffer depth, not an offset. The player
stops at the movie's duration. Other containers play in a `<video>` element. A movie that neither
path can play is reported to the host as unsupported and completes, so the scenario
continues as after the movie's end. The probe plays a movie for its ASF header duration
in 16 ms frames without decoding it.

`tests/artemis-video.test.mjs` checks frame timing, conversion and mask alpha against an
independent statement of the native formulas, the same frames through the worker,
delaymargin skipping, looping, the open
order and errors, the wait, the fullscreen tag and frame branch, and the ASF reader.
`tests/asf-windows-media.test.mjs` covers the ASF demuxer, the preroll decoding order and
the decoder.

## E-mote layers

Rev.3258 adds the Lua `engine` methods `getEmoteVersion` (0x1401535d0),
`createEmoteLayer` (0x140151480) and `getEmoteLayer` (0x140152960), the `IEmotePlayer`
class (0x14001b070) and `var system=is_emote` (0x140108a20). The player itself is the
shared E-mote driver port in `src/native/emotedriver` (see its README).

- `createEmoteLayer{id=, files={...}, width=, height=, progress=}` reads the motion files
  (the Lua call suspends while they load and repeats once they are read), builds one
  player over all of them and inserts a CEmoteLayer at `id`, replacing the layer there.
  A missing file reports the native error and returns nil. A zero width or height takes
  the rectangle of the `boundsLeft`/`boundsTop`/`boundsRight`/`boundsBottom` chara
  profiles (`artemisEmoteLayerSize`), or the stage size when it is empty.
- `getEmoteLayer(id)` returns the player of the current actor at `id`; the luabind
  wrapper (`emote-lua.ts`) exposes the `IEmotePlayer` methods with the native argument
  conversions.
- Drawing (`ArtemisEmoteLayer`, CEmoteLayer draw 0x14001adf0): each draw that reaches the
  layer advances the player by the elapsed clock time (at most 1000 ms, as 60 fps frames;
  `progress(0)` on the first draw) when `progress` is set, then renders the clip's draw
  list into the layer's render target, cleared to transparent black. `image-graphics.ts`
  holds the layer as an image actor whose texture is that target; the E-mote commands of a
  draw list precede its other targets, and each layer renders once per draw list.
- A CEmoteLayer copy clones its player natively (0x14001a4f0); that clone is not modeled
  and a copy is refused.

## Nonvisual resource geometry probe

Image codecs/resources and layer hosts can select a logical image-dimensions type;
the ordinary raster owner retains the default straight-RGBA type. This permits an
explicit geometry-only owner without fake pixel buffers or GPU allocations.
`tools/probe-artemis.mjs` uses such a record-only layer
fixture, reads encoded resource headers and drives the actual layer lifecycle,
property parser, scene commit and suspended Lua. It never decodes image pixels or
presents game media. Its JSON declares the fixture, nonvisual mode and resource
resumption count; unsupported services still stop the probe. PNG/PSD header checks
are geometry inspection, not evidence of full decode compatibility.

Creation keys `file`, `width`, `height`, `color` and `rule` forwarded to `lyprop`
are retained in its original command record and ignored by ordinary property
application, matching `0x1400d76d0` / `0x140115650`. The game forwards the table
used by `lyc`; property application does not reload or recolor its image.
Unknown property keys are refused.

The fixture records shader name, constants and texture leases through
`ArtemisShaderProperties` without compiling programs. It steps layer tweens whenever the
probe clock advances, and advances 16 ms frames while a `sync` tween holds run mode 4.
Animation layers are recorded with their frame keys and paths; the fixture never draws
them.
Lua `.ipt` animation tables are preloaded with the other script sources.

## Lua random, wait reason and PNG comments

Each method is bound only when its host owner exists.

- `random` (`0x14012eb30`) returns the next sample of the script's boost::mt19937
  (seeded with `(int)time(NULL)`) through a uniform [0, 0xffff] distribution.
  `ArtemisRandom` reproduces it on the shared `Mt19937` (`src/core/mt19937.ts`); the
  owner supplies the seed time.
- `getScriptWaitReason` (`0x1401315b0`) returns a fresh table with one key per set wait
  flag: `time` (the uint32 deadline), `textTween`/`textClearTween` (1), `sound`/`video`
  (strings). `ArtemisTimedWait.reason` supplies `time`, `textTween`, `sound` and `video`;
  `textClearTween` belongs to the unimplemented `scenario=2` wait.
- `loadPngComments` (`0x1401345b0`) reads the file through `readResource` and parses its
  `tEXt` chunks with `readArtemisPngComments` (the native CPng comment walk: no CRC
  checks, last keyword wins, success only at `IEND`). Non-string arguments, missing files
  and unreadable files report the native Shift-JIS messages (`artemisLuaErrors`) at level
  1 through `reportError` and return nil. With a coroutine owner a pending read suspends
  the caller and the call repeats after the read completes.

## Lua pointer query

`getMousePoint` is bound only when the Lua host supplies the shared
`PointerPositionHost`. Its owner supplies already-mapped window/input coordinates
without consuming pending input edges. Native `0x140134ca0` reads its provider twice:
first x, then y; both are float32 values widened to Lua numbers (`0x140138f10`),
not integer coordinates. Each call returns a fresh table with named x/y fields.
Nonfinite provider values refuse. Native input sampling and stage coordinate
mapping remain the input owner's responsibility.

The metadata-only probe selects a simulated position 0,0 and marks that fixture in
JSON. Lua aliases x/y/zoom forwarded by the game's lyc2 helper remain in recorded tags
and do not override the normalized left/top/xscale/yscale property names consumed by
native 115650.

## Window caption

`ArtemisCaption` implements the UTF-8 `caption` command (`0x1400c9870`) through
shared `WindowCaptionHost`. Missing data clears the caption; UTF-16 strings stop
at the first NUL as SetWindowTextW does. The native command ignores the host's
failure result. `BrowserWindowCaptionHost` changes only its selected document's
title and reports failure when no document is selected. Legacy ANSI caption
conversion remains unsupported.

The nonvisual probe records caption changes.

## Message-layer selection

`ArtemisMessageLayers` implements the named stage store and independently retained
selected pointer (`0x14014f490`). Required owners construct/copy the complete
CLinkableTextLayer resource bundle, manage loans and attach/detach scene wrappers.
Selecting an existing layer with mode0 keeps its layered state. Explicit mode1/-1
first detaches and copies an already layered resource; mode1 attaches the new
copy, while mode-1 leaves it detached. Missing names create a new bundle. Scene
owners must retain earlier frame resources after detach. Shutdown releases its
logical loans; font/render/resource construction is not replaced with placeholders
in this production interface.

`ArtemisMessageSelection` handles `chgmsg` and `/chgmsg` (`0x1400d1c10` / `0x1400d20d0`).
Stacking defaults enabled; only exact `stack=0` disables it. Missing `layered`
selects mode0, exact0 selects mode-1, every other spelling selects mode1. An omitted
id requires the script owner's automatic-name allocator. The command reseeds
missing message history after a detach request, publishes `s.current_message_layer`,
emits INFO3 selection diagnostics and requires message wait/indicator updates.
The restore command pops the prior script name and selects mode0. Empty-stack
restore emits its INFO3 diagnostic only. Backlog's transient stage selection does
not alter this script selection stack or create script history.

Synthetic owners verify layer copies preserve their supplied font state, independent
map/current/scene loans, exact flag handling, history effects and restore behavior.
The nonvisual probe's message resources are a simulation with no text presentation.

## Font stack and properties

`ArtemisFontStack` implements native `fontinit`, `font` and `/font` history.
Initialization snapshots the current selected font; a normal font command pushes
a complete owner-created frame. Exact `stack=0` replaces a nonempty top frame.
Restore requires two frames, releases the current frame and applies the preceding
one. Empty restore emits a diagnostic. History recording can be disabled for replay.
Owners remain responsible for complete font resources and actual text rendering.

`artemisFontProperties` parses the 38 observed native attributes as partial patches,
preserving omitted defaults. Numeric conversions, double division before float32,
colors, modes, alignment and comma-separated style flags follow a74d0. Style spans
are not trimmed. Overflow belongs to the command frame rather than copied font
attributes. The forwarded Lua `ruby` face alias is left out of the font state;
the resolved `rubyface` and `rubysize` are applied normally (Rev.2601
`0x49b8a0` → `0x479a00`). Unknown keys and out-of-range conversions are refused.

Display property revisions invalidate intermediate captures when an owner changes
a descendant directly; identical assignments and parent-only transforms reuse
captured pixels.

## Text effect configuration

`ArtemisSceneTweens` implements `scetween` (cdae0): `init` clears the selected
vector, `add` appends a copied descriptor. In/out/show/hide are keyed by the script's
current message-layer name; four backlog vectors are shared across names. Snapshots
survive later mutations. Parameters distinguish whole-layer and per-character effects;
ease names retain native dispatch ids. Diff rounds to float32 before alpha/scale
division, and time wins over the legacy msec key even when explicitly empty.
Unknown modes/types do not modify vectors, matching the handler's explicit return.
`ArtemisTextDisplay` applies the `in` vectors (see below).

## Text display and click-waits

`text-display.ts` is the display progression of a text layer (CLinkableTextLayer
vtable `0x140376af0`). `show(descriptors, continuing)` is virtual +0x1c8
(`0x140196b10`): for every descriptor and every character it creates a float tween
(`0x1401990e0`), registers it in the global `ArtemisTweenRegistry` and keeps the id.
In-tweens set `value + diff` at once and return to the current value; outgoing tweens
move from the current value by `diff`. Only blocks whose first main glyph index is at
least the display start take part, and the display start then becomes the glyph
counter, so each start animates only text inserted since the previous one. A
non-continuing start resets the display start to 0 first.

Delays are `delay * order` (int32). The order counts every main glyph of the included
blocks from 0, including glyphs without an actor; ruby glyphs start at their block's
first order and advance by `main / ruby` count in float32. `entire*` descriptors
animate whole blocks with the cumulative main-glyph count of all blocks in the layer
(`0x140198ce0`). `randomdelay` needs the CRT `rand` stream used by `random_shuffle`
and is refused. Unknown parameters create no tween but insert id 0, as native does.

`complete` is +0x1e0 (`0x14014a0a0`): true once no kept id is still registered, which
includes a finished tween until the next registry step removes it. `finish` is +0x1d0
(`0x140197100`): finish every kept tween, then forget the ids. `clear` follows the
empty-outgoing branch of `0x1401962d0` after the insertion owner reset its lines:
finish, then zero the display start together with the glyph counter. `copy` follows the
CLinkableTextLayer copy, which keeps the display start and the id set.
`ArtemisTextInsertion.displayBlocks()` supplies the lines and blocks.

The wait tag (`0x1400cc0c0`) and `@` (`0x1400cbf20`) both start the display with
`continuing` set. A timed wait (flag b98) uses the skip vector while skipping or
debug-skipping; `scenario=1` (flag b99) always uses the `in` vector and has no
deadline. The skip vector (script +0x3718) is zero-initialized and has no decoded
writer, so it shows text without tweens. `@` sets no flag and enters run mode 1 with
onClickWaitIn and the save gate.

Each frame, `ArtemisTimedWait.tick(now, clicked, inputFrame)` runs the run mode 1/3/4
branch of `0x1400c0560`:

1. A click in run mode 1 on a complete display ends the wait; `s.clickskip` is set to 1
   only when a wait flag is set. A click on an incomplete display finishes it and sets
   `s.clickskip`. An active skip (`0x1400b5170`: skip allowed and command or control
   skip on) is a click every frame.
2. In run mode 1 with automode on, a flagless wait (`@`) whose display is complete and
   that has no deadline gets the deadline `s.automodewait` + now. Turning automode off
   clears it.
3. A passed deadline ends the wait, unless automode is on and an id of the syncse list
   names a seplay sound that is still playing.
4. A `scenario=1` wait ends once the display is complete.

Outside automode an `@` therefore ends only on a click. The click glyph placement
(`0x1400b6820`) of the automode branch belongs to the click glyph owner.

`ArtemisTextBreakControls` dispatches `indent`, `prohibit` and `wordparts` to the
selected text resource. UTF-8 characters form pairs; duplicate openings replace
previous closings and a trailing unmatched character is discarded. Range is int32;
logicalrange/nest use native exact-zero flags. History and remembered replay slots
are copied separately, with wordparts sharing the indent replay slot. Replay mode
suppresses both history writes. Owners must store the copied configuration and
apply it during actual layout. `artemisUtf8Prohibition` supplies the encoding2
native defaults independently for each empty prohibited-character set.

## File fonts and print dispatch

`ArtemisFileFonts` reconstructs the Unicode file-backed CFreeTypeFont subset.
An explicit owner reads font files and supplies FreeType2.4.8 worker faces. Exact
paths share face resources until their final loan closes. Sizes narrow to uint8;
zero-size error handling remains unsupported. Each glyph job applies the CELL size
atomically, preserving independent sizes/styles on a shared face. Baseline and
underline/strikeout metrics use the native signed integer formulas. Glyph advance
uses arithmetic shift of the 26.6 value; glyph top is relative to the font baseline.
The native post-render italic outline transform does not rerasterize its bitmap.
System fonts, legacy character conversion, renderer atlas/edge algorithms and text
layout remain distinct owners.

Each text layer's CFontRenderer (`ArtemisGlyphRenderer`) keeps the first provider that
opens a face: FreeType file, `<face>_<size>.rft` rendered font, then the system font
(setFont `0x1401662e0`). The exact Rev.3257 hash keeps the full 32-bit provider size, while older hashes retain the low-byte size. FreeType CELL requests preserve the native 32-bit shift; rendered-font names and cache keys use the corresponding size width. When none opens the face the previous provider stays current; a
renderer that never opened one draws empty, zero-advance characters (`0x140166420`). In
this UTF-8 revision the Shift-JIS default face (`ＭＳ ゴシック`) opens nowhere, because
CSystemFont matches UTF-8 `EnumFontFamiliesExW` family names, so text printed after a
bare `fontinit` is empty on a fresh layer. A missing font file falls through the same
chain. A system family the host reports (`hasSystemFontFamily`; the browser player tests
whether the browser draws the family) would open CSystemFont, which is not reconstructed
and is refused. Otherwise a layer that already opened a face keeps drawing with that
provider's face, size and style bits. The normal stream selects its font before the ruby
stream. A failed provider glyph is an empty, zero-advance character.

## Rendered fonts

`ArtemisRenderedFont` is CRenderedFont over the `.rft` container
(`src/formats/artemis/rft.ts`): the file `<face>_<size>.rft`, or that name with a second
`.rft`, holds `rft0`-`rft3` magic and an index of (offset, size) entries over fixed code
ranges. `rft3` adds a settings entry at code 0, read with the native INI tokenizer
(`ArtemisIni`, CIni); its `[FONT] CHARSET` of exactly `UTF-8` selects Unicode ranges, and
the choice is kept per file name for the process. The settings give the strikeout and
underline metrics and `COLOR_32`; a file without them opens through its `A` entry with
zero metrics. Glyphs are 8-bit gray PNG entries placed at the line top that advance by
their width; character codes are looked up unchanged, so the Shift-JIS versions see
Unicode code points in this revision. Unindexed U+0020 and U+3000 advance by half the
size (rounded up) and the size; other unindexed codes and empty entries fail.

32-bit (`COLOR_32`/`rft2`) glyphs are supported where `ArtemisRevision.renderedColorGlyphs`
records the verified PE32 path (Rev.2601 and Rev.2762): the glyph call reports 4 bytes per
pixel, and the painter copies the entry's RGBA pixels unchanged, ignoring the text color.
With an outline, the glyph alpha is the outline and shadow coverage and its RGB replaces
the foreground color; underline and strikeout rows keep the foreground color. Such entries
must be 8-bit RGBA PNG images. Other revisions refuse 32-bit glyphs, and other image
formats are refused.

`ArtemisPrint` handles print/ruby-buffer/debug-skip routing, diagnostics, overflow
variable writes and consumed-prefix history. The required insertion owner returns
its native result and the first unconsumed UTF-8 byte offset. Overflow policy0
appends `@`, `rp` and the remaining print tag to the existing FIFO; other policies
keep only the consumed prefix in history. Replay suppresses history writes, not
native overflow effects. Async calls retain copied arguments and reject overlapping
prints. `cancelPending` discards stale script effects after script transfer; the
layout owner independently cancels its insertion job before reusing resources.
No recording-only print owner is supplied to the nonvisual boot probe.

`paintArtemisGrayGlyph` reconstructs the grayscale glyph branch of166420. It owns
RGBA storage with native outline/shadow padding and padded advance. Outline pixels
use a square maximum; nonzero foreground coverage mixes foreground/outline RGB
but writes opaque alpha, preserving the native float32 rounding and truncation.
Shadow copies painted alpha diagonally underneath existing pixels. Underline and
strikeout rows use required font-provider metrics, including whitespace and bearing
expansion. `ArtemisGlyphPainter` executes this work in a dedicated engine worker.
Coverage is copied, painted pixels are transferred and close rejects pending jobs.
Native atlas allocation is replaced by independent images; packed-bit/RGBA font
sources and oversized/negative edge cases remain explicitly unsupported.

The older PE32 profiles return a clipped cell instead of separate bearings and
advance. Their FreeType bitmap is placed at nonnegative bearings in an advance-wide,
byte-size-high cell, enlarged for bitmap overflow. Normal/ruby layout advances by
the painted clip width. The PE64 profiles preserve their bearing/advance result.
Lua `restoreFontCache(path)` holds its calling coroutine while the glyph owner reads
numbered PNG atlases from zero through the first missing file, then `index.dat`.
The 2898 index restores painted cells by face, size, shadow, outline, colors and
packed style/UTF-16 character. Atlas images are decoded once and shared by entries;
individual crops enter the bounded glyph cache only when used. A later restore
replaces matching entries, while existing insertion blocks keep their storage.
Scenario reset retains this process cache; player disposal releases it. Reports
include retained atlas bytes, entry count and hits. Rev.3257 uses eight separate
32-bit key fields followed by atlas index, float bearings/advance and inclusive
clip coordinates (`0x1400092e0`, Lua adapter `0x140139640`). Its restored glyphs
retain those metrics; misses keep full-size FreeType bearing geometry. Both exact
Rev.3257 roots share this format; the wrapped variant has byte-identical embedded
engine sections, as documented in `docs/artemis-revisions.md`.
Other revisions' restore formats, gray atlases, non-UTF-8 faces and fractional clips remain unsupported and fail
explicitly; missing index files leave the cache unchanged. PNG decode errors propagate.

A generated rectangle font verifies FreeType worker → native glyph paint worker →
GPU output in the browser.

`layoutArtemisTextBlock` reconstructs normal/ruby stream placement from1971e0.
Advances add kerning only when painted advance is positive. Net-width comparison
removes each stream's last kerning; the longer stream supplies the stored full
block width and the shorter receives evenly distributed gaps. Empty ruby text
still reserves its configured vertical space. Glyph resources remain owner-supplied;
positions and layout snapshots are copied/frozen. `ArtemisTextLine` implements line
append/pop, native width/height counts, bottom-aligned block rows and four alignment
modes, including single-block equalize fallback. Wrapping, indentation/prohibition,
vertical display rotation and resource lifetimes remain text-layer owner work.

## Logical text insertion and frame ownership

`font-state.ts` supplies the complete37 native attributes from193720. It keeps
factory face labels as their original13 Shift-JIS bytes; file-font rendering must
receive an actual filename. A missing system/default font provider is refused when
that stream is used, not replaced by a browser font. Font command patches keep the
history frame's overflow extra separate from attributes.

`ArtemisTextInsertion` connects actual glyph blocks, UTF-8 runs, block flags and
full indentation/wrapping storage. It copies input bytes, reports native consumed
byte cursors, rolls back the global glyph counter on unprintable/overflow results,
and preserves line mutation already performed by recursive wrapping. Logical glyph
ids are new for every insertion even when painted pixels are shared. Counter520
includes normal and ruby glyphs; line90 counts normal glyphs only.

`ArtemisTextWrapping` retains paired closing-string/width stacks, range and logical
range, nest behavior, empty indent placeholders and the one-level pop-without-
replacement branch. Explicit configuration replacement preserves active stacks.
`ArtemisUnindentedTextWrapping` remains a facade that refuses active pair mappings.

`prepareFrame` follows14c5d0: finalize only the current nonempty line; keep closed
line placement and avoid reserving height on an empty current line. Frame row Y is
computed from stored heights separately from cached insertion Y. Auto anchors use
native maximum width, alignment and total line height. Each glyph retains its
captured font attributes; published frames retain logical resources after close.
The required publisher performs actual display effects. Tests use both real workers
and a generated font to publish an insertion frame through GPU drawing.

`measure` follows149d90/149e60/149ea0, including omission of current line height when
its main glyph count is zero. `copy` clones logical line/indent/font/glyph state and
preserves ids while sharing painted storage. It is not a complete CLinkableTextLayer
copy: the enclosing owner must additionally handle display state, in/out job handles
and native link-scope movement. Native full clones move link scope and active flag
out of the source; plain CTextLayer clones clear copied job lists instead.

`insertRuby` creates a single native main/annotation block, with global glyph ids
for both streams. `ArtemisRuby` follows the global buffers and end-command layer
selection; `ruby` takes its annotation from `text` (d1010), while `print` uses `data`. Automatic page overflow queues `@`, `rp`, `/ruby` while retaining active
buffers; inactive/nested/unprintable behavior and history follow the native branches.

`ArtemisTextCommands` implements `rt` (newline) and `rp` dispatch. Backlog capture
uses write-backlog mode, separately from the UI backlog-allowed flag. A replay
skips history/backlog maintenance but still calls the required resource-clear host.
`clearEmptyEffects` follows1962d0 only after that host has cancelled jobs and
confirmed no outgoing descriptors: it conditionally resets lines/counters while
retaining indentation stacks and newline state. It is not a replacement for
animation scheduling or a complete CLinkable clear.

The probe uses the actual font and glyph workers through the Node browser-worker
adapter, returning metrics and hashes without displaying game assets. Lua exposes the
strict-string/NUL-terminated void `bindSurfaceAsync` binding only when an actual
preload host is supplied. Optional `unbindSurface` requires a strict NUL-terminated name; `isLoadingSurface` returns
a boolean for a string name or the whole queue for any non-string argument.
Their hosts must own the real queue and binding lifetimes. Native loading needs
FIFO preload jobs, prepared surfaces, promotion/wait behavior and cancellation.

`bindSurface` (0x140134180) takes only a string, truncated at NUL. It performs an ordinary
surface load through the manager's virtual +8 and releases the returned lease immediately. A
non-string argument is an error. When the host reports the load as suspended, the Lua
coroutine yields like a suspended tag; without a coroutine owner the call fails.

## Asynchronous surface preload ownership

`ArtemisSurfaceManager` connects native011a90 lookup/promotion,0128b0 worker FIFO
and012200 release policy. Its required host creates a fresh prepared surface,
decodes actual pixels into it, reports native storage size and disposes resources.
PNG headers or guessed widths cannot satisfy that host. Script bindings and
foreground image leases share active/idle resources; duplicate queued names add
no binding, while a cached bind adds one. Mode2 checks current usage against the
budget before decode; mode1 may exceed it. No room for the new surface is reserved
by native trimming. Background success holds a script binding until unbind/close.

An ordinary load waits/retries for the queue head or removes/promotes a later job.
Unsupported overlapping foreground loads are refused. Decode runs outside logical
queue selection. Completion revalidates the front **name**, preserving the native
same-name clear/requeue behavior; cancelled placeholders retain their resource
until the in-flight decoder releases it. Browser cancellation wakes pending calls,
an explicit adaptation from native condition-variable waiting. Close rejects new
operations, clears/joins background work and drops script bindings; held foreground
leases keep their decoded resources until released. Decoder null is an ordinary
miss; unsupported host exceptions remain available through `loadFailures` and the
diagnostic `waitForLoads` join.

Lua exposes optional strict-string bindSurfaceAsync/unbindSurface and no-argument
clearSurfaceLoadQueue hosts. isLoadingSurface(string) queries a name; any non-string
queries the whole queue and returns a boolean. No queue host is invented by default.

`probe-artemis` uses
a real shared image worker for PNG and merged PSD pixels. Gray PNGs become native
format 0 surfaces (`artemisPngSurface`, one byte per pixel in the 0x1401649b0 storage
size), all others four bytes per pixel. Opaque JPEG uses the diagnostic
`node-opaque-jpeg.mjs` CPU owner (Python with Pillow/libjpeg; select the interpreter
with `ARTEMIS_PROBE_PYTHON`). It strips metadata through the shared header reader,
checks the stored frame dimensions and emits RGBA bytes without an image window or
canvas. Its rounding is the diagnostic codec's, not a claim of native/browser pixel
identity; production playback keeps the browser JPEG codec. Only metrics and hashes are exported; it does not prepare GPU surfaces,
display assets or claim production rendering. The 512 MiB budget is an explicit
diagnostic policy, not an inferred setting of the original game. Existing metadata layer
fixtures remain simulated and are independent of these pixel resources.

`ArtemisLayers.attachActor` adopts a fresh stage wrapper into the same hierarchical
scene as image actors. `detachActor` removes its current attachment; retained child
maps and inner actor slots keep their own resources until commit. The supplied
copy/property/release hooks therefore apply to message wrappers as well. Stage
attachment does not reset script command history. Fresh/open/pending checks precede
ownership transfer; insertion failure releases an unadopted wrapper.

The metadata probe connects layered message selection to these APIs, with actual
resource-loan accounting, so properties and deletion find its text actors. It does not
publish their frames.

`ArtemisSeStop` follows e3c60 for sestop/sefadeout: exact named slot lookup,
integer-prefix milliseconds, mandatory stop/fade service for an existing slot,
and normal-execution history deletion. A missing slot does not parse time or call
audio services; replay retains history. Playback belongs to the voice owner
([Effect voices and device attenuation](#effect-voices-and-device-attenuation)).

`ArtemisSePlay` follows e3370 for seplay/sefadein: stop an existing named effect,
check skippable command mode, prepare a real sound, assign its index, set explicit
gain/pan and optional s.segain.id gain, then start with native time/loop arguments.
Debug skip bypasses audio while maintaining replay history; skippable command skip
returns before history. Non-loop sounds replace history with the native empty
block. Load failure reports without writing a new slot or history. Cancellation
releases a completed, unadopted sound and suppresses stale script effects.

`ArtemisSeAdjust` (`se-adjust.ts`) follows e3ee0 for sefade and e4220 for sepan: a known
id moves its voice gain (scope 0) or pan over `time` (absent: 0); absent `gain`/`pan`
read as 0. Outside replay the value is written into the id's save-object block through
operator[], which creates an empty block for an id without history. Such nameless blocks
keep their arguments through scenario saves and replay nothing on load.

The required prepare/gain/pan/start services own actual playback. The probe
uses the shared Vorbis worker to decode real PCM, exporting hashes and metadata. It
opens no audio graph/device. `ArtemisVariables.lookup` supports non-inserting, owned-byte lookup
for optional named gains without inventing missing system variables.

## Effect voices and device attenuation

`ArtemisEffectVoices` owns real `AudioVoice` resources, signed-key gain factors,
per-factor/pan fade jobs and preparation-time inactive collection across managers.
Default integer fades use native first-tick/uint32 absolute-time behavior, float64
interpolation and int32 truncation. Gain projection uses float32 factor reduction
and native rounding, followed by the DirectSound centidB conversion. Fade-out
completion stops/rewinds the voice; its manager row remains until inactive cleanup.
Immediate stop disposes it. Close cancels jobs and retires all owned voices; a late
prepared voice is disposed before any stale script effect.

`createArtemisBrowserEffectVoices` joins a required PCM decoder with the shared
`BrowserAudioTransport`. The transport has optional loop/reset and independent
stereo attenuation controls. Mono is duplicated into both channels; stereo content
is attenuated without crossfeed. Offline contexts permit actual WebAudio processing
without device output. Ordinary callers retain their existing initial controls.
The codec owner remains responsible for native formats and buffer-mode semantics.

The synthetic browser smoke verifies real offline PCM gain/pan and mono behavior,
alongside text/GPU resources. No silent or timer voice substitutes are installed.

### Native sound filename lookup

`ArtemisSoundLoader` follows Rev.3179 `190290`: it first tries codecs advertising
an exact case-sensitive suffix, then all registered codecs on the exact file,
then appended extension candidates in codec/extension order. Appended files are
only passed to their corresponding codec. Native char-pointer filenames stop at
NUL; buffer modes are forwarded unchanged as int32. Decode misses return null,
while unsupported services and decoder failures propagate. Independent byte
storage lets each asynchronous decoder begin at offset zero without detaching or
modifying subsequent attempts. The generic loader accepts an explicit codec list. Revision-selected
`createArtemisSoundLoader` installs native Vorbis (`ogg`, `OGG`) before WAVE
(`wav`, `WAV`), as verified in constructor `b9e80` and the codec extension methods.
Both decoder services are mandatory; their native formats and buffer modes are
separate responsibilities.

The nonvisual sound probe uses an explicit Ogg-only diagnostic registration and
the actual shared Vorbis worker with suffix lookup. A synthetic browser
fixture connects this loader to actual offline WebAudio voices. Neither check
opens audible game playback or proves native codec/streaming-mode completeness.

`ArtemisWaveSource` provides the actual encoded PCM resource owner from `19d570`,
`19e170` and `19e120`. It validates native PCM/channel/rate/alignment fields,
ignores the RIFF length boundary, and skips chunks without standard odd-byte
padding. Truncated payloads retain the advertised data size and return only bytes
actually available. Exact lowercase `_a` names attempt a paired `_b` resource;
reads cross the boundary, and reset stays on B once activated. Missing or invalid
paired resources leave the main source usable. It does not interpret PCM, create
a voice, or claim support for backward seeks from negative chunk sizes.
The sound codec receives the resolved filename to preserve this source behavior.

## Buffered sound codec services

`ArtemisVorbisPcmDecoder` runs the shared real libvorbis decoder and Rev.3179's
float32 scaling / signed32 conversion / PCM16 saturation in reusable module workers.
The installation supplies an explicit SSE rounding policy; no native FPU state is
inferred. PCM keeps encoded channel order. Encoded-data decode misses return null;
worker/host failures propagate. Closing stops workers and rejects pending adoption.

`ArtemisVorbisSource` retains actual decoded integer bytes and native paired-file
read/reset semantics. Unlike WAVE, reading exactly to A's end retains A until a
later nonzero read observes EOF. Sub-frame reads and progressive decoder error timing
are unsupported in this eager resource adaptation.

`createArtemisBufferedSoundDecoder` joins the revision-selected filename codecs,
WAVE/Vorbis resource owners and shared integer-PCM conversion worker with the browser
voice adapter. Only native `buffer=-1` is implemented: complete A+B storage, with
hardware repeat of the whole clip. Native source B-only reset is used by streaming,
not cached hardware looping. Zero/positive buffer modes use the rolling buffer
([Progressive PCM device voices](#progressive-pcm-device-voices)). The decoder does not create an audio context itself.
PCM8/16, aligned frames and complete payloads are supported; other bit depths and
truncated cached payloads are explicitly refused. No silence substitute is supplied.

Native references: `88340` (Vorbis integer samples), `19cb30/19d390/19d2f0`
(Vorbis resources), `163a80` (buffer sizing), `164410` (fill/play), `1640c0`
(rolling refill versus cached completion). Synthetic browser checks distinguish
A+B cached repeat from the B-only streaming-source reset behavior.

## Progressive PCM device voices

`ArtemisRollingSoundBuffer` owns the native two-half PCM ring, partial-read padding,
strict inactive-half cursor boundaries and trailing-half stop count. It reads real
PCM byte resources; it does not provide a voice by itself. `ArtemisPcmCursor` owns
transferred WAVE/Vorbis snapshots inside the audio processor without changing the
source owner's cursor.

`createArtemisBrowserSoundVoices` selects cached `buffer=-1` or actual progressive
AudioWorklet voices. `ArtemisEffectVoices.tick` pumps progressive buffers from the
engine scheduler; the device render callback advances playback position. A delayed
pump can replay stale ring data, matching the native buffer behavior. The shared
PCM host provides its real ScriptProcessor compatibility fallback where worklets
are unavailable. Mono duplicates into stereo, and per-side attenuation is independent.

The browser adapter prefills both halves before output; native fills its second
half during the first engine tick.

Native decodes a rolling voice's Vorbis file as it plays. The browser owner does the same
for files without a paired `_b` resource: `ArtemisVorbisStream` reads the file in 256 KiB,
then 1 MiB ranges and feeds them to a decoding session (`ArtemisVorbisStreamDecoder`, one
reusable module worker per stream). In the worker, `ArtemisVorbisPcmChunks` runs the shared
incremental `VorbisChunkDecoder` and converts each batch with Rev.3179's PCM16 rule; the
concatenated PCM equals the eager result, including the EOS trim. The voice is prepared
once both ring halves can be filled, so it starts before the whole file is read and
decoded. Later PCM reaches the device processor as `append` commands. A pump whose
half is not decoded yet refills nothing, and the next pump refills it once the PCM arrived
(`ArtemisPcmCursor.ready`), so a slow decoder can never end or loop the voice early. An
encoded-data error before the first PCM is a decode miss, as in the eager owner; a later
read or decode failure ends the PCM where it stopped. Paired `_a`/`_b` files and WAVE
sources are decoded eagerly in codec workers. Damaged/chained streams and DirectSound
lost-buffer recovery remain separate native services. Fractional device rates use browser
linear interpolation; no target-driver bit identity is claimed. Worklet control
commands have completion fences for tests and callers that must observe state.

## Offline PCM and sound completion

`createArtemisOfflineSoundVoices` uses actual decoded PCM and the same progressive
processor without opening an audio context or device. Its caller renders explicit
sample-frame blocks and supplies scheduler ticks. Cached clips use the shared
`PcmClipRenderer`; frame positions advance from consumed samples, not timers.
The probe renders through it, reports PCM hashes
and explicit clock/rounding policy, and can pass real `seplay` control flow.

`ArtemisSoundFinish` captures copied set/del registrations. Missing `id` chooses
music; present empty `id` chooses that exact SE slot. Missing slots do nothing.
The voice owner's native playing flag settles on frame tick, then invokes its
finish callback once. Explicit stop and fade-out do not emit natural completion.
The required event dispatcher owns filter/scope/queue semantics of the captured
command. The registration functor (f8050 at 0x1400dfe2b/0x1400dff1f) calls b73e0 with event
mode 0 and force 1, so a firing callback goes through `ArtemisScriptEvents.emit(command, 0,
true)`. It does not invent default event actions.

`click-glyph.ts` is the glyph tag (0x1400d3290). It updates the CGlyphInfo entry for the
current message layer (map at script +0x3818, created by 0x1400eb500). `layer` sets the glyph
layer name; an absent `layer` clears only the flag and keeps the name. `left`/`top` use atoi.
Without `rplayer`, the read-ahead glyph copies the layer flag, name and position. With
`rplayer`, it takes that name and the optional `rpleft`/`rptop`. Each named layer is passed to
the layer set's virtual +0xf0 (0x1400a4970), which clears the layer's draggable flag
(+0x16c). `homing="0"`
clears homing; any other value sets it.

Placement (`0x1400b6820`) runs only in the run mode 1 automode branch, when the display of a
flagless wait has completed and right before the automode deadline is armed. It reads the
current message layer's entry: the `rplayer` fields when the caret's next tag is `rp`, else
the layer fields. With the flag set and a nonempty name, it records the name as the placed
glyph (script +0x3838) and, without homing, sets the layer's draggable flag. Release
(`0x1400b6cf0`) clears that flag and the placed name. It runs when a wait ends (c6160 mode 0),
after every caret transfer (b6520, event handler scopes), on `chgmsg` selection changes and
on engine reset. Games create, show and delete the glyph layers themselves; the engine never
changes their visibility. Homing placement, which moves the layer into the glyph container
attached to the text layer, is not implemented and throws.

`music.ts` holds the BGM commands on the music manager (script +0x3d60):

| Tag                 | Handler |
| ------------------- | ------- |
| `splay`, `sfadein`  | e2390   |
| `sxfade`            | e29e0   |
| `sstop`, `sfadeout` | e28a0   |
| `sfade`             | e2f00   |
| `span`              | e3140   |

The current slot is +0x3d70. `sxfade` moves it to the fading slot +0x3d74 and fades that
slot out over `time` after the new file loads. Other plays stop both slots first. Only an
exact `loop="0"` plays once. A failed load leaves slot 0 and reports through the host.
Debug skip (+0x3520) bypasses audio for `splay`/`sxfade` but still records history.

Replay history is the save object's loop flag (+0x88) and copied tag (+0x90). `sfade` and
`span` read `gain`/`pan` through `operator[]`, so an absent value is atoi 0, and they write
that value into the stored tag. `sstop` clears the loop flag. Replayed commands record nothing.

Graphics feature level is published only through an explicit revision-selected
owner callback. `--graphics-feature-level=NUMBER` is an optional simulated diagnostic
value, recorded as such; it is not a report about browser/Windows GPU capability.

## Named shader resources

`ArtemisShaderLibrary` implements `lyshader` file/compile/registry ownership with
mandatory compiler and diagnostic services. Shader IDs are independent of layer
existence. Actor leases retain compiled resources across replacement or library
shutdown. File misses and compiler errors preserve an existing named program;
unsupported compiler services propagate. Late compilation after close disposes
its resource before refusing adoption.

`compileArtemisRasterPreset` selects the reconstructed CPU/GPU raster executable
only for its exact input SHA-256 and engine revision. Original game shader text is
not shipped. The program displaces UV1.x by `sin(radians(UV1.y*inter-angle))*size`,
samples foreground and multiplies only alpha. Back/mask samples and color multiplier
have no observable contribution in this source. Sampler filtering/addressing belong
to the host. `ArtemisBrowserRasterShader` provides a real linked WebGL2 program on a
dedicated context; actor scene binding is described below.

`--shader-presets` adds actual known-source CPU executable registration to the
nonvisual probe. It does not display or shade game image pixels. Its optional
feature-level input remains explicitly simulated. Unknown HLSL sources are refused;
this is a verified preset port, not a general HLSL compiler.

DX9 source `154274ae…4188c` selects a separate multiplication interpolation:
RGB scales by `(1 - user.a*param) + user.rgb*user.a*param`, while mask and effect
alpha scale foreground alpha. This source has no combined-alpha division, including
for transparent foreground colors. The older `mul` source retains its equation.

The recognized `screen` shader screens foreground RGB against `user.rgb*user.a`
and scales foreground alpha independently. Its declared `param`, back/mask samples
and color multiplier are unused by the returned color. The exact source signature
selects its reconstructed executable through `compileArtemisShaderPreset`.
The dedicated WebGL helper accepts this preset with an explicit user texture;
synthetic checks compare GPU output against the CPU screen equation.

The exact-source selector also recognizes `sepia`, `sepia2`, `gray`, `blur_h`
and `blur_v`. Color luminance uses (.298912,.586611,.114478); sepia2 adds
its red coefficient while sepia multiplies it. Both multiply green/blue and
foreground alpha. Gray repeats luminance in RGB. Blur accumulates fifteen taps
in center, positive, negative order for offsets 1..7, with eight explicit weights
and a UV step on the selected axis. It scales accumulated alpha after filtering.
These presets have real CPU references and linked WebGL2 implementations;
GPU dot/FMA rounding and sampler policy can affect numerical results.

Nega inverts foreground RGB without changing its alpha before global alpha.
RGB sets a channel to zero for a negative coefficient, otherwise adds that
coefficient. Values are not clamped by the shader; output target format decides
clamping. Both presets require exact original-source signatures.

Radial uses an explicit center, size and fade. Seven inward samples receive1/8
weight; the original foreground receives1/8+7/8*(1-fade), then the inward sum
is multiplied by fade. Distance scales the inward step. Alpha scales only after
accumulation. Zero size and zero fade retain the original foreground. Values
are not clamped or inferred. CPU and actual GPU outputs are compared on synthetic
nonzero radial displacement as well as identity cases.

All twenty original DX11 source signatures select executable CPU/WebGL2
presets. Additional programs cover add/mul, per-channel bright/dark composites,
color add/multiply, reset and mosaic. Compbr/compbrc and compdk/compdkc have
identical equations but retain separate signatures. Composite normalization uses
foreground/user combined alpha in RGB, then returns foreground alpha*alpha;
transparent division is not regularized. Cadd accepts negative channels, while
RGB zeros negative-coefficient channels. Mosaic uses floor(UV*grid)/grid with
w=size*ratio,h=size; grid inputs are not pixel dimensions. Caller/target own
filtering, addressing and clamping. These known presets are not a general HLSL
compiler; actor shader properties and constant/texture jobs are described below.

`shader-properties.ts` parses native shader/shaderconstant/shadertexture property
lists and owns the CLayer shader state. Constants preserve order, duplicate names,
float32 equality and copied state; texture assignments retain complete replacements
before releasing old resources, and always invalidate preparation. Native parsing
of nonfinite/hexadecimal floating literals is outside the finite-decimal subset.
The resource loader remains mandatory; parsing paths alone does not load textures.
The exact Rev.2898 profile omits texture-property parsing: its `0x58cc90` reads
shader names and constants but never queries `shadertexture`. Listed texture paths
therefore cause no resource loads or shader-owner requirement on that hash.

`dx9-shader.ts` selects nineteen raw HLSL signatures only for the exact Rev.2898
profile and supplies their mask-aware CPU/GLSL executables. Draw `0x5cf080` and
the executable's D3DX `SetFloatArray` (`0x44858f`) select fields by name and
preserve unwritten elements in each effect. The renderer assigns builtin alpha
before the custom list; a listed `alpha` can override it. Captured and ordinary
DrawList adapters use the same effect state. Mask texture assignments retain a
resource dependency across draws, with replacement/disposal releasing it.
Finite source coefficients, UV, alpha and LINEAR/CLAMP sampler behavior are
preserved; unsupported source signatures remain refused. `docs/artemis-revisions.md`
describes the A8 view and native ownership evidence. The D3D11 ordered-buffer
description below applies to the four existing x64 profiles.
DX9 custom capture blending follows the retained device factors, updated only by
ordinary draws in `0x5cf080`. Builtin captures disable hardware blending; custom
passes enable it without changing those factors. The D3DX state blocks record
the effect's state writes and leave the caller's SRCBLEND/DESTBLEND writes intact.
This behavior and RGB/A8 surface formats are selected by the exact profile's
`graphicsApi` field, independently of constant binding and texture properties.

`draw-shader.ts` adapts all twenty reconstructed programs to the shared DrawList
shade/atlas/tex/tint/parameters ABI, with explicit required named uniform values and
user texture index. Real synthetic GPU tests compare every adapted program against
the dedicated WebGL executable, including nonzero UV transforms and user texture
composites. This is executable renderer integration, not native reflection/constant
buffer packing: the explicit named calibration helper refuses missing coefficients. Native ordered
buffer preparation and retained ImageGraphics wiring are described below.

Native15d120 rendering ignores constant names after argument collection and
concatenates vectors in list order. `nativeParameters` preserves this order;
`bufferParameters` consumes already prepared native storage. `parameters` remains
an explicit named-value calibration convenience, not D3D reflection. Native
constant storage grows in16-byte units, initializes new memory to zero and keeps
old trailing coefficients on shorter writes. GPU-layer copies share existing
storage until one grows, matching verified15c850 pointer/refcount copies. Empty
lists do not update slot1; the graphics binding owner must preserve prior slot1.
Nonempty lists of empty vectors remain refused; unbound and out-of-range reads return
zero (below).

Custom shader properties connect to `ArtemisLayers` and `ImageGraphics`.
Supply an owned ShaderLibrary of DrawShaderResource objects through the optional
ImageGraphics shader-program provider. `createArtemisDrawShaderCompiler` selects
exact source signatures and requires actual target prepareTriangleShader to compile
both ordinary and captured variants. Unknown-source presets remain unsupported.

Lyprop parses shader names, ordered shaderconstant lists and shadertexture paths.
Texture jobs resolve asynchronously through the existing image source, retain
prepared raster resources, skip missing loads and release stale completions before
upload/edit. Missing shader providers refuse before scene mutation. Copied actors
retain independent property vectors and texture leases, plus shared native constant
storage. Renderer program loans and sampled texture loans remain held through draw
submission. Captures include shader-property revision in their invalidation signature.

Per-frame draws look up the current named program, reuse slot1 for empty constant
lists and apply native ordered packing. TextureUser selects the first surviving
texture entry regardless of its name. Ordinary draws use their native blend state;
captured custom programs replace RGBA before outer composition. Null user binding
returns zero in the shader, and unknown named programs produce no color pixels.
D3D constant-buffer out-of-range accesses are also zero, as `bufferParameters` models
for a missing or short buffer.

These API defaults follow the [Direct3D functional specification](https://microsoft.github.io/DirectX-Specs/d3d/archive/D3D11_3_FunctionalSpec.htm),
sections7.5,7.18.17 and16.6. No game asset is synthesized to fill a missing resource.
Shader coefficient animation jobs and root/wildcard property modes are unsupported.

`script-events.ts` reconstructs b73e0/c6730 registration dispatch: producer-owned
native modes, disabled/latch flags, copied deferred registrations, retained Lua
event filter and default file/label transfers followed by priority handler tags.
The concrete Script adapter installs an empty caret with a fresh local variable
scope for handler-only events, then restores the interrupted ready/waiting cursor.
A synthetic PCM EOF test exercises sound-finish capture, frame tick, event filter,
scoped handler queue and return to the waiting script without an audio device.

Frame, timer and caret control and the latch reset belong to the runtime frame
([Engine runtime](#engine-runtime)). Direct registered Lua Events callbacks remain
distinct.

Lua include accepts an explicit prepared `readPlainFile` owner: plain CFile uses
Lua loadfile header/line framing and Windows CRT text input, then any open/load/
protected execution failure retries normal loose-first pack bytes. Empty plain
files succeed without fallback; first-attempt Lua side effects survive. Shared
Lua51 executeFile/compileFile operate on prepared raw/text bytes, preserving binary
reopen and exact bytecode ABI checks. Suspendable includes use a child coroutine
for the protected execution boundary, forwarding resource waits to their caller;
nested includes retain locals without yielding across a C pcall. Fatal instruction
budgets remain fatal. Hosts without the plain provider retain the pack-only subset.
`reportIncludeError` (below) reports final failures.

`reportIncludeError` supplies native12d080 level1 final-error reporting and return
to the include caller. Without that owner, diagnostics retain final refusal.
Poisoned/closed Lua VMs remain nonrecoverable. Packed loadbuffer uses a literal
filename chunk name, while plain loadfile uses @filename. The nonvisual probe can
opt into --native-include-reporting with error records and explicit host guards.

`reportLuaCallError` is the native calllua owner (c84b0→12c030→c7260). 12c030
resolves the dotted `function` name from globals; nil/false along the path or a
non-function result reports the native "function not found" text. Its
luabind::error catch turns a Lua runtime error with a string value into the
last-error bytes up to the first NUL. c84b0 reports them at severity1 and the tag
returns, so the script continues; Lua side effects before the error remain. The
synchronous path and resource-suspended coroutines behave the same: a failed
frame is closed and its suspended caller resumes with no values. Host-method
refusals keep their `LuaRuntimeError.hostCause`, and resource failures are raised
through a host method, so both stay strict, as do VM traps, the memory cap and
non-string error values. Without the owner every failure keeps the strict fault.
Debug gating (+0x3524/+0x3528), the Lua LogFilter and console output belong to the
owner. Probe --native-calllua-reporting records reports without that policy.

Lua `debug` checks the current scenario debug mode before reading any arguments
(Rev.2868 `0x5a2300`, registered by `0x59fc00`). In release mode it returns no
values, including for invalid or cyclic arguments, and performs no output. A restored
nonzero mode is explicitly refused until the enabled console and LogFilter owner is
implemented. The binding reads the scenario owner dynamically rather than freezing
the mode at construction.

`reportUnknownTag` is the unknown-command owner of the dispatcher `0x1400c5800`. A tag
the Lua filter does not take is looked up in the native command map, which `0x1400b9e80`
fills with the 151 names in `native-tags.ts`. On a miss the dispatcher tries the macro
stack, then reports c7260 severity 1 with 「未知のタグ、または未定義のマクロです。」
(`artemisUnknownTagMessage`, Shift_JIS), and the script continues with the next tag.
The macro stack is empty here because `macroadd` is not implemented. Without the owner
every name reaches the host `dispatch`, which refuses unsupported names. This is how
`achievements` behaves when the game's Steam module (`system/extend/auth/steam.lua`,
which defines `tags.achievements`) is not loaded. The probe's
--native-calllua-reporting records these reports as `unknownTagReports`.

`tag-dispatch.ts` is that host `dispatch`: `createArtemisTagDispatch(owners, suspend)`
consults the tag owners in a fixed order (text, transition and layer tweens, fullscreen
video, layers, message and font owners, the synchronous command owners, shaders, reset,
save, load, click glyphs, music, effect sounds) and refuses a tag no owner takes. A tag
that loads resources passes its promise to `suspend` and returns `'suspended'`; the
runtime resumes the script once that promise settles. The second argument is the loader's
replay flag. Owners that need message layers, glyph text, sound or graphics are optional;
without them their tags reach the refusal.
