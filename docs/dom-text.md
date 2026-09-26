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

Browser glyph placement is approximate. Adjacent matching rows are grouped into
continuous text without inserting line-break characters. Ruby and differently
styled runs remain separate. Vertical text uses browser vertical layout. Shadows
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
