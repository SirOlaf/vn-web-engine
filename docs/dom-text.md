# DOM text presentation

Both players expose **Text rendering → DOM text** in Game options. Text can be
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
Text node with explicit native row boundaries. Its copy handler omits visual-wrap
newlines from the source string. Completed rows do not reflow as a later row is
revealed; horizontal scaling is anchored to the first row. Adapters with complete
glyph buffers can use browser wrapping. Ruby and differently styled runs remain
separate. Native row positions define line spacing; font size
is independent of the bitmap cell height. Hanging first-row indentation is
preserved without separating the dialogue into multiple nodes. Glyph reveal
alpha does not change paragraph identity. CSS Custom Highlight ranges preserve
individual fade opacity when available; other browsers use the paragraph's
maximum opacity. Repeated damage-strip fragments retain combined coverage and
the latest native fade/tint style. Visibility is evaluated across all fragments
of a glyph so damage through transparent cell margins cannot change text coverage.
Presentation owners can annotate a bitmap with `rasterTextFlow` to isolate control
text. Window overlays use independent flows; decoded wait-marker glyphs remain
visible without entering dialogue width or line-spacing calculations. Flow
identity follows copies, crops, clones, transforms and display uploads.
Vertical text uses browser vertical layout. Shadows
and outlines can be omitted; arbitrary blend, mask, mesh and displacement effects
cannot be reproduced exactly by browser text. Fully occluded glyphs are excluded
using native/textless pixel comparison, while partial occlusion and transformed
glyph shapes remain best effort.
Custom bitmap glyphs retain their private-use character codes; browser fonts may
show a fallback glyph when they do not contain those characters.
Tracking retained text requires additional
memory for the affected bitmaps; alternate display rasterization runs only in
DOM mode.

Validation uses synthetic fonts, pixels and strings. Game-asset visual review is
left to the user.
