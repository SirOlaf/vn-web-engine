# Unicode 15.1.0 registry comparison data

`src/engines/buriko/games/aokana/native/registry-case-data.ts` contains the 1,190 non-identity BMP simple uppercase mappings derived from field 12 of the Unicode Character Database's [UnicodeData.txt, version 15.1.0](https://www.unicode.org/Public/15.1.0/ucd/UnicodeData.txt). Its SHA-256 is `2fc713e6a31a87c4850a37fe2caffa4218180fadb5de86b43a143ddb4581fb86`.

Reproduce the data with `node tools/generate-aokana-registry-case.mjs /path/to/UnicodeData.txt`. The generator verifies the source digest. Runtime code has no network or package dependency. Unicode's copyright and license are included in [LICENSE.txt](LICENSE.txt).

This is a declared Aokana browser registry compatibility profile, not a claim that Unicode 15.1.0 matches every Windows NLS release. It applies one mapping to each UTF-16 unit, preserves surrogate units, and performs no expansion or normalization. Original stored key/value names and data remain untouched.
