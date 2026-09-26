# Windows CP932 mapping data

`src/engines/buriko/games/aokana/native/text-cp932-data.ts` contains the MBTABLE, DBCSTABLE and WCTABLE hexadecimal records from Microsoft's Windows code page mapping file hosted by the Unicode Consortium:

- Source: https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/WindowsBestFit/bestfit932.txt
- Format documentation: https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/WindowsBestFit/readme.txt
- Downloaded: 2026-09-12
- Source SHA-256: `2614cfea35c3c86c41d33198793a84ca44edee3cf0ee0013a61a43fba4ece331`
- Parsed decoding records: 9805
- Parsed encoding records: 9486

The four-hex-digit key and four-hex-digit value are concatenated in ascending key order. CPINFO specifies `0x003f` for Unicode-to-code-page fallback and `0x30fb` for code-page-to-Unicode fallback. The mapping retains best-fit encoding and Windows private-use single bytes. It is standard character mapping data, contains no Aokana assets, and requires no package or runtime dependency. The accompanying Unicode License V3 applies.
