# Artemis implementation status

The reference reconstruction target is Artemis Rev.3179 from Hatsuyuki Sakura,
executable SHA-256 `8953562b80608046662bd8c89015d04236b0ba3afee10c36469c11403de3ebaf`.
Additional accepted executables and their exact behavior profiles are listed in
[Artemis revisions](artemis-revisions.md), including Rev.2601 from Ryuusei World Actor and
Rev.2762 from Hamidashi Creative.
Unknown executable hashes are refused.

## What exists

- Engine runtime (`src/engines/artemis/runtime.ts`): every native tag owner, the Lua 5.1
  runtime, the script, reset, save and load, driven by `frame(now, input)` over host
  services. See the engine [README](../src/engines/artemis/README.md).
- Browser player (`src/engines/artemis/browser/`, page `artemis.html`, controller
  `ui/runtimes/artemis.ts`): WebGL stage with image, animation, video, group and text
  layers, crossfade and rule transitions, FreeType glyphs, Web Audio effect and music
  voices, named shaders, message-box dialogs, IndexedDB save storage and
  pointer/keyboard input with image hit testing. Browser gamepads supply the DirectInput
  joystick keys; only synthetic tests cover them, not a physical controller. The page reports Windows 10 and
  Direct3D feature level 11_0. Over the real installation it boots, takes the language
  choice, reaches the title menu, starts a new game and advances voiced scenario text
  through click-waits (nonvisual check: `#trace` diagnostics and canvas hashes only).
- Nonvisual probe (`tools/probe-artemis.mjs`): runs the same runtime over actual
  font, glyph, image and Vorbis workers, header-only layer geometry and offline PCM
  voices. It covers boot, the prologue with its fullscreen movies, the title, scenario
  text with click-waits, choices through layer events, and a scenario save/load round
  trip. It displays no game assets and opens no audio device.
- E-mote layers (Rev.3258): the E-mote 3.9.8 driver port (`src/native/emotedriver`)
  plays the character models and renders their draw lists into the layer's GPU target
  with the native ordering, alpha masks and destination blends. Checked on synthetic
  textures against CPU references; game frames were not viewed.
- Fullscreen movies: ASF files (WMV3 or WVC1 with WMA Standard, Pro or Lossless audio) decode
  in the movie worker with the Windows Media wasm decoder and play on the audio clock
  over a canvas; other containers play in a `<video>` element.
- Screenshots: `takess`/`savess` render offscreen and write PNG thumbnails into save
  storage, which the save directory overlays on installation files.
- Synthetic browser checks (`tests/browser/artemis-images.html`): GPU scenes, shaders,
  font and image workers, sound lookup through offline Web Audio voices, the pointer
  hit test and the stage crossfade.

## Not implemented

- Nonempty `syncse`, scenario mode 2, `macroadd`.
- Touch input (CArtemisTouch, WM_TOUCH): touches arrive as mouse input; the tap key 0x8a,
  long taps and the touch point count stay unused.
