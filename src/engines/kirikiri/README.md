# Kirikiri engine

Reimplementation of the Kirikiri (Kirikiri Z) core for the browser. Target title:
NEKOPARA Vol. 1 (`nekopara_vol1.exe`, SHA-256 `0b81a3c9…`).

| Path            | Contents                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------- |
| `revision.ts`   | Core builds by executable SHA-256 and the facts read from them                                |
| `tjs2/`         | TJS2 compiler front end (lexer, preprocessor, parser, analysis); see `tjs2/README.md`         |
| `tjs2/runtime/` | TJS2 object model, suspension, built-in classes; see `tjs2/runtime/README.md`                 |
| `core/`         | TVP core: storage, text streams, log, plugins, native classes, start-up; see `core/README.md` |
| `messages.ts`   | The core's message table (TJS and TVP), read from the executable by UI language               |

Formats (XP3, CxDec archives, PSB, E-mote models) are in `src/formats/kirikiri/`; plugins
reimplemented as native libraries (`nekopara_vol1.tpm`, `emotedriver.dll`, `d3d9.dll`) are in
`src/native/`, and every TVP plugin provides `src/native/tvp-plugin/contract.ts`.

The core runs on the main thread. Natives that natively block (storage reads, dialogs) suspend
the calling script and resume it when their work completes (`tjs2/runtime/README.md`,
Suspension). There is no TJS2 VM yet: start-up reads, decodes and hands `startup.tjs` to
`TjsEngine.executor`.
