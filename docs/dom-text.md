# DOM text presentation

Every player exposes **Text rendering → DOM text** in Game options. Text can be
selected and copied or read by browser dictionary extensions. Click outside the
text to send input to the game. Switching modes does not modify game state.

Aokana records decoded glyphs at the ordinary font, custom glyph and monochrome
raster boundaries. This covers classic and extended animated text, horizontal
and vertical layout, ruby, selections, direct surface/window text, and formatted
hex output. Native edit controls and dialogs already use DOM elements. Text
baked into image or movie assets has no decoded string to expose.

The shared `src/text/raster-text.ts` transport keeps presentation metadata and
textless copies beside bitmap allocations. Cropped descriptors, copies, render
strips, snapshots, clears, blends and transforms carry that data through the
ordinary renderer. The original bitmap bytes remain the source for native
readbacks, exports, captures and engine decisions. Display uploads carry metadata
even if native pixel comparison finds no changed bytes.

The main device, direct client blits and auxiliary bitmap windows use the shared
browser presentation owner. Native frames remain on their canvas; DOM mode puts
the alternate frame and selectable text in a sibling layer. Closing a window,
clearing its client, hiding a presentation, or tearing down the runtime retires
its DOM nodes. The no-canvas diagnostic mode never creates a DOM presentation.

Browser glyph placement is approximate. Adjacent matching raster rows form one
Text node with explicit native row boundaries. Horizontal rows contain no newline
characters: a floated `shape-outside` polygon (a layout rule `DomGlyphSlots` installs
in the document) ends each browser line at its native row's measured width, so selections and popup dictionaries read the source string
across rows. Vertical rows use newline separators, which the copy handler omits. Completed rows do not reflow as a later row is
revealed; horizontal scaling is anchored to the first row. Adapters with complete
glyph buffers can use browser wrapping. Ruby and differently styled runs remain
separate. Native row positions define line spacing; font size
is independent of the bitmap cell height. Hanging first-row indentation is
preserved without separating the dialogue into multiple nodes. Leading whitespace
glyphs of a row are indentation and are not part of the text; the first visible
glyph anchors the row. Glyph reveal
alpha does not change paragraph identity. CSS Custom Highlight ranges preserve
individual fade opacity when available; other browsers use the paragraph's
maximum opacity. Repeated damage-strip fragments retain combined coverage and
the latest native fade/tint style. Visibility is evaluated across all fragments
of a glyph so damage through transparent cell margins cannot change text coverage.
Presentation owners can annotate a bitmap with `rasterTextFlow` to isolate control
text. Window overlays use independent flows; decoded wait-marker glyphs remain
visible without entering dialogue width or line-spacing calculations. Flow
identity follows copies, crops, clones, transforms and display uploads.
Vertical text uses browser vertical layout.

Glyph records carry the native CSS weight and a horizontal `stretch` (native glyph
width relative to the font size). Slots with a stretch scale browser glyphs by it and
set letter spacing so each advance equals the first row's native glyph pitch; slots
without one only compress rows that are wider than native. Engines record effect
passes as decorative ink and call `decorateRasterText` on the source glyph before
compositing them, so the glyph carries its edge: offset shadows become SVG offset
shadows. Outlines are painted beneath the ink: with engine `weights`, each edge
pixel sums the browser glyph's weighted alpha over the radii and clamps at full
coverage, as native edge rasterizers do; without them the glyph is dilated by the
radii. In Buriko, `decorateBurikoBitmapText` maps text effect modes 1 (shadow) and
2 (outline, with `burikoGlyphOutlineWeights`); effect alpha is `opacity / 256`. Arbitrary blend,
mask, mesh and displacement effects cannot be reproduced exactly by browser text.
Fully occluded glyphs are excluded using native/textless pixel comparison, while
partial occlusion and transformed glyph shapes remain best effort.
Custom bitmap glyphs retain their private-use character codes; browser fonts may
show a fallback glyph when they do not contain those characters.
Tracking retained text requires additional
memory for the affected bitmaps; alternate display rasterization runs only in
DOM mode.

## Reader styles

**Text rendering → Custom text style** is off by default. When enabled, DOM text
uses the reader's font families (a CSS list, optionally preceded by an uploaded
font file), size and weight, and can drop the game's shadows and outlines.
The game's own face remains a fallback for characters the reader's fonts lack.
**Fit to game text area** keeps native row breaks, row width and clipping, so a
wider font is compressed. **Natural font spacing** keeps the font's own advances
and a line height of at least 1.25 × the font size, and reflows each paragraph within
the text area: larger text flows into more lines than the game drew, smaller text
into fewer. A wrapped paragraph's widest native row is the area's right edge, so text
in the game's font reflows into the game's own rows; a single row may extend to the
edge mirroring its left margin in the layer. Rows ending more than two glyphs short
of the widest row, and blank rows, are deliberate breaks and stay. Lines break between
any characters. As in BGI's horizontal layout, closing punctuation hangs past the edge
when its whole group fits within one of its advances there; otherwise the line breaks
before it. The paragraph stays one Text node, and added lines extend below the game's
text window. Short controls in another flow that sit at the end of a
dialogue row, such as a wait marker, move with the restyled text's rendered end.

**Additional CSS** is a stylesheet scoped to DOM text layers. Declarations without a
selector apply to `.game-text`; every declaration becomes `!important`, so rules
override the computed inline presentation. Rows of text matched by reader rules are
measured as laid out, so reader spacing changes where fitted rows are compressed
rather than where native rows break. Each `[data-game-text]` element has classes to
select it by:

| Selector                                                | Text                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `.game-text`                                            | all DOM text                                                                             |
| `.game-text-horizontal`, `.game-text-vertical`          | writing direction                                                                        |
| `.game-text-multiline`                                  | more than one native row                                                                 |
| `.game-text-inert`                                      | text that does not accept selection                                                      |
| `.game-text-overlay`                                    | BGI: glyphs drawn in a window layer, not the window's text                               |
| `.game-text-marker`                                     | BGI: end-of-dialogue controls, such as the wait marker                                   |
| `.game-text-body`, `.game-text-name`, `.game-text-ruby` | NOAH: layout role                                                                        |
| `.game-text-source-<kind>`                              | NOAH: drawing source (`scene`, `backlog`, `dialog`, `tips-description`, `save-label`, …) |
| `[data-font-size="N"]`                                  | native font size in pixels                                                               |

Engines add classes through `GlyphSlot.classes`. The style is remembered in local
storage and the font file in IndexedDB; neither changes game state. Style state
lives in `src/text/dom-text-style.ts`, and presentation owners re-render when it
changes.

## Game directory fonts

Some titles expect specific fonts to exist.
The player scans every selected installation file (three directory levels deep),
including disc files outside the mounted catalog view, for them on the first font query that needs the installed catalog. They
behave as installed families: they are enumerable, answer pitch and charset
queries, and are selected before host fonts of the same name. Only sfnt metadata
is read during the scan; a face's bytes are loaded into the browser the first
time the game creates it. Fonts loaded through the game's own font-resource
calls still take precedence. `tools/probe-buriko.mjs` reports each font resource,
enumeration and face request with the source the player would select.

Validation uses synthetic fonts, pixels and strings. Game-asset visual review is
left to the user.

## codeX RScript

RScript text objects keep the decoded characters of their glyphs, so the RScript
player needs no raster tracking. The canvas keeps drawing the native glyphs; DOM
mode places transparent text over every visible text object (message boxes and
the backlog pages they show, choices and screen text), one span per glyph cell,
so selections line up with the native layout. A text object's DOM is rebuilt only
when its glyphs change, which keeps a selection while the page waits. Copying
omits the newlines of layout wraps and keeps those the script wrote. Ruby is not
exposed, so dictionary lookups see the base text.

Shift is left to dictionary extensions in DOM mode instead of hiding the message
window, and Control does not start skipping while text is selected, so it can be
used to copy. The mouse wheel and the right button over the text still reach the
game; the right button opens the browser menu while text is selected.
