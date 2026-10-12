# Kirikiri engine

Reimplementation of the Kirikiri (Kirikiri Z) core for the browser. Target title:
NEKOPARA Vol. 1 (`nekopara_vol1.exe`, SHA-256 `0b81a3c9…`).

| Path          | Contents                                                                              |
| ------------- | ------------------------------------------------------------------------------------- |
| `revision.ts` | Core builds by executable SHA-256 and the facts read from them                        |
| `tjs2/`       | TJS2 compiler front end (lexer, preprocessor, parser, analysis); see `tjs2/README.md` |

Formats (XP3, CxDec archives, PSB, E-mote models) are in `src/formats/kirikiri/`; plugins
reimplemented as native libraries (`emotedriver.dll`, `d3d9.dll`) are in `src/native/`.
