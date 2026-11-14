/**
 * `GetSysColor` with the default colours of Windows 10 (the "Windows" theme), as `0x00BBGGRR`.
 * Index 25 is unused and answers 0, as natively; out-of-range indices answer 0.
 */
const DEFAULT_RGB = [
  0xc8c8c8, // COLOR_SCROLLBAR
  0x000000, // COLOR_BACKGROUND
  0x99b4d1, // COLOR_ACTIVECAPTION
  0xbfcddb, // COLOR_INACTIVECAPTION
  0xf0f0f0, // COLOR_MENU
  0xffffff, // COLOR_WINDOW
  0x646464, // COLOR_WINDOWFRAME
  0x000000, // COLOR_MENUTEXT
  0x000000, // COLOR_WINDOWTEXT
  0x000000, // COLOR_CAPTIONTEXT
  0xb4b4b4, // COLOR_ACTIVEBORDER
  0xf4f7fc, // COLOR_INACTIVEBORDER
  0xababab, // COLOR_APPWORKSPACE
  0x0078d7, // COLOR_HIGHLIGHT
  0xffffff, // COLOR_HIGHLIGHTTEXT
  0xf0f0f0, // COLOR_BTNFACE
  0xa0a0a0, // COLOR_BTNSHADOW
  0x6d6d6d, // COLOR_GRAYTEXT
  0x000000, // COLOR_BTNTEXT
  0x000000, // COLOR_INACTIVECAPTIONTEXT
  0xffffff, // COLOR_BTNHIGHLIGHT
  0x696969, // COLOR_3DDKSHADOW
  0xe3e3e3, // COLOR_3DLIGHT
  0x000000, // COLOR_INFOTEXT
  0xffffe1, // COLOR_INFOBK
  0x000000, // (unused)
  0x0066cc, // COLOR_HOTLIGHT
  0xb9d1ea, // COLOR_GRADIENTACTIVECAPTION
  0xd7e4f2, // COLOR_GRADIENTINACTIVECAPTION
  0x3399ff, // COLOR_MENUHILIGHT
  0xf0f0f0, // COLOR_MENUBAR
];

export function defaultWindowsSysColor(index: number): number {
  const rgb = DEFAULT_RGB[index];
  if (rgb === undefined) return 0;
  return ((rgb & 0xff) << 16) | (rgb & 0xff00) | (rgb >>> 16);
}
