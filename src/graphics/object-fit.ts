/** Maps a native surface into an element box following its CSS `object-fit`.
 * Only canvases stretch with `fill`; other boxes and `contain` keep native proportions.
 */
export function objectFitPlacement(
  element: Element,
  rect: {readonly width: number; readonly height: number},
  width: number,
  height: number,
): {scaleX: number; scaleY: number; offsetX: number; offsetY: number} {
  const fill =
    element.localName === 'canvas' &&
    element.ownerDocument.defaultView?.getComputedStyle(element).objectFit === 'fill';
  const scale = Math.min(rect.width / width, rect.height / height);
  const scaleX = fill ? rect.width / width : scale,
    scaleY = fill ? rect.height / height : scale;
  return {
    scaleX,
    scaleY,
    offsetX: (rect.width - width * scaleX) / 2,
    offsetY: (rect.height - height * scaleY) / 2,
  };
}
