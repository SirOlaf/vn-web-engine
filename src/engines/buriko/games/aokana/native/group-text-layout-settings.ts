import {pop32, push32} from '../bp/state.js';
import {AokanaTextLayoutState} from './text-layout-state.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import {AokanaWindowDisplayState} from './display-window-state.js';
import {AokanaEngineErrors} from './engine-errors.js';
import {
  AOKANA_DISABLED_HORIZONTAL_TEXT_EFFECT,
  createAokanaHorizontalTextEffect,
  drawAokanaHorizontalTextWindowFacade,
  drawAokanaRegisteredHorizontalTextToSurface,
  type AokanaRegisteredSurfaceHorizontalTextOptions,
} from './text-layout-pipeline.js';
import type {AokanaBpOpcodeContext, AokanaNativeSlotDefinition} from './types.js';

/** Shared font/policy/overlay settings used by the actual text-procedure and window layout families. */
export function createTextLayoutSettings(
  state: AokanaTextLayoutState,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (context: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(context.thread, context.diagnostics, state.text.encodeWide(message, 0));
  const readingFont = (context: AokanaBpOpcodeContext, extended: boolean): 0 => {
    const value7 = extended ? pop32(context.thread) : 0xffffffff,
      value6 = extended ? pop32(context.thread) : 0xffffffff,
      y = pop32(context.thread),
      x = pop32(context.thread),
      width = pop32(context.thread),
      size = pop32(context.thread),
      index = pop32(context.thread);
    state.setRegisteredReadingFont(index, size, width, x, y, value6, value7);
    return 0;
  };
  return [
    {
      primary: 0x90,
      secondary: 0x98,
      nativeAddress: 0x1400d8aa0,
      name: 'ConfigureTextOverlayFrames',
      execute: (context) => {
        const source = context.memory.resolve(context.thread, pop32(context.thread)),
          count = pop32(context.thread),
          error = {value: 0};
        if (state.configureOverlayFrames(count, source, error) === 0)
          return fatal(
            context,
            `指定されたビットマップ [ ${error.value | 0} ] は存在しないか、スクリーンと互換性がありません`,
          );
        return 0;
      },
    },
    {
      primary: 0x90,
      secondary: 0x9a,
      nativeAddress: 0x1400d8a10,
      name: 'SetTextOverlayPosition',
      execute: (context) => {
        const y = pop32(context.thread),
          x = pop32(context.thread),
          mode = pop32(context.thread),
          result = state.setOverlayPosition(mode, x, y);
        push32(context.thread, result === 0 ? 0 : result === 0x80000008 ? 1 : 0xffffffff);
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0x97,
      nativeAddress: 0x1400defd0,
      name: 'SetTextReadingFont',
      execute: (context) => readingFont(context, false),
    },
    {
      primary: 0x91,
      secondary: 0x9a,
      nativeAddress: 0x1400dee40,
      name: 'SetTextLayoutPolicy',
      execute: (context) => {
        const value = pop32(context.thread),
          selector = pop32(context.thread),
          result = state.setPolicy(selector, value);
        if (result === 0x80000007)
          return fatal(context, `無効なファンクション番号 [ ${selector | 0} ] が指定されました`);
        if (result === 0x80000008)
          return fatal(context, `無効なファンクションパラメータ [ ${value | 0} ] が指定されました`);
        return 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0x97,
      nativeAddress: 0x1400e3790,
      name: 'SetTextReadingFontExtended',
      execute: (context) => readingFont(context, true),
    },
  ];
}

/** Custom numeric-glyph atlas and single-slice registration share the actual text-layout owner. */
export function createCustomTextGlyphSettings(
  state: AokanaTextLayoutState,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const fatal = (context: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(context.thread, context.diagnostics, state.text.encodeWide(message, 0));
  return [
    {
      primary: 0x90,
      secondary: 0x9e,
      nativeAddress: 0x1400d8850,
      name: 'ConfigureCustomGlyphAtlas',
      execute: (context) => {
        const surface = pop32(context.thread),
          count = pop32(context.thread),
          result = state.customGlyphs.configureAtlas(count, surface);
        if (result === 0x80000001)
          return fatal(context, `無効な文字数 [ ${count | 0} ] が指定されました`);
        if (result === 0x80000002)
          return fatal(context, `無効なビットマップ [ ${surface | 0} ] が指定されました`);
        if (result === 0x80000003)
          return fatal(context, `指定されたビットマップ [ ${surface | 0} ] は適合しません`);
        return 0;
      },
    },
    {
      primary: 0x92,
      secondary: 0x98,
      nativeAddress: 0x1400e3670,
      name: 'RegisterCustomGlyph',
      execute: (context) => {
        const height = pop32(context.thread),
          width = pop32(context.thread),
          y = pop32(context.thread),
          x = pop32(context.thread),
          surface = pop32(context.thread),
          character = pop32(context.thread),
          result = state.customGlyphs.registerForCurrentEncoding(
            character,
            surface,
            x,
            y,
            width,
            height,
          );
        if (result === 0x80000002)
          return fatal(context, `無効なビットマップ [ ${surface | 0} ] が指定されました`);
        if (result === 0x80000006)
          return fatal(context, `無効な文字コード [ ${character | 0} ] が指定されました`);
        if (result === 0x80000007)
          return fatal(
            context,
            `無効なイメージサイズ [ ${width | 0} , ${height | 0} ] が指定されました`,
          );
        return 0;
      },
    },
  ];
}

/** The six installed horizontal window/surface text services; vertical dispatch remains separate. */
export function createHorizontalTextLayoutServices(
  windows: AokanaWindowDisplayState,
  errors: AokanaEngineErrors,
): AokanaNativeSlotDefinition[] {
  const state = windows.textLayout;
  const fatal = (context: AokanaBpOpcodeContext, message: string): Promise<never> =>
    errors.threadFatal(context.thread, context.diagnostics, state.text.encodeWide(message, 0));
  const pointer = (context: AokanaBpOpcodeContext): AokanaBpPointer | null =>
    context.memory.resolve(context.thread, pop32(context.thread));
  const requiredPointer = (value: AokanaBpPointer | null, owner: string): AokanaBpPointer => {
    if (value === null) throw new Error(`${owner} dereferences a null native text address`);
    return value;
  };
  const validateSurfaceAndFont = (
    context: AokanaBpOpcodeContext,
    surface: number,
    font: number,
  ): 0 | Promise<never> => {
    if (surface >= 0x4000)
      return fatal(context, `無効なビットマップ番号 [ ${surface | 0} ] が指定されました`);
    if (state.surfaces.fonts.name(font) === null)
      return fatal(context, `無効なフォント番号 [ ${font | 0} ] が指定されました`);
    return 0;
  };
  const drawSurface = async (
    context: AokanaBpOpcodeContext,
    options: AokanaRegisteredSurfaceHorizontalTextOptions,
  ): Promise<0> => {
    const result = await drawAokanaRegisteredHorizontalTextToSurface(state, options);
    if (result === 0x80000001)
      return fatal(context, `指定されたフォントサイズ [ ${options.fontSize | 0} ] は無効です`);
    if (result === 0x80000002)
      return fatal(context, `指定されたフォント幅 [ ${options.fontWidth | 0} ] は無効です`);
    if (result === 0x80000003)
      return fatal(context, `指定されたフォント番号 [ ${options.registeredFont | 0} ] は無効です`);
    if (result === 0x80000004)
      return fatal(context, `指定されたビットマップ [ ${options.surface | 0} ] は存在しません`);
    if (result !== 0)
      throw new Error('Aokana surface horizontal text returned an unknown native status');
    push32(context.thread, options.lineOutput.value);
    return 0;
  };
  const drawWindow = async (
    context: AokanaBpOpcodeContext,
    handle: number,
    source: AokanaBpPointer,
    readingEnabled: number,
    wrapping: number,
    color: number,
    readingColor: number,
    effect: Parameters<typeof drawAokanaHorizontalTextWindowFacade>[7],
  ): Promise<0> => {
    const result = await drawAokanaHorizontalTextWindowFacade(
      windows,
      handle,
      source,
      readingEnabled,
      wrapping,
      color,
      readingColor,
      effect,
    );
    if (result === 1) return fatal(context, '指定されたウィンドウにはフォントが設定されていません');
    if (result === -1) return fatal(context, '無効なウィンドウハンドルが指定されました');
    return 0;
  };

  return [
    {
      primary: 0x91,
      secondary: 0x91,
      nativeAddress: 0x1400df330,
      name: 'DrawWindowHorizontalText',
      execute: (context) => {
        const wrapping = pop32(context.thread),
          readingEnabled = pop32(context.thread),
          color = pop32(context.thread),
          source = requiredPointer(pointer(context), 'Aokana window horizontal text'),
          handle = pop32(context.thread);
        return drawWindow(
          context,
          handle,
          source,
          readingEnabled,
          wrapping,
          color,
          color,
          state.defaultEffect,
        );
      },
    },
    {
      primary: 0x91,
      secondary: 0x93,
      nativeAddress: 0x1400df100,
      name: 'DrawWindowHorizontalTextOptionalEffect',
      execute: (context) => {
        const wrapping = pop32(context.thread),
          readingEnabled = pop32(context.thread),
          disableEffect = pop32(context.thread),
          color = pop32(context.thread),
          source = requiredPointer(pointer(context), 'Aokana window horizontal text'),
          handle = pop32(context.thread);
        return drawWindow(
          context,
          handle,
          source,
          readingEnabled,
          wrapping,
          color,
          color,
          disableEffect === 0 ? state.defaultEffect : AOKANA_DISABLED_HORIZONTAL_TEXT_EFFECT,
        );
      },
    },
    {
      primary: 0x92,
      secondary: 0x91,
      nativeAddress: 0x1400e38c0,
      name: 'DrawWindowHorizontalTextExtended',
      execute: (context) => {
        const opacity = pop32(context.thread),
          effectColor = pop32(context.thread),
          radiusY = pop32(context.thread),
          radiusX = pop32(context.thread),
          mode = pop32(context.thread),
          wrapping = pop32(context.thread),
          readingColor = pop32(context.thread),
          readingEnabled = pop32(context.thread),
          color = pop32(context.thread),
          source = requiredPointer(pointer(context), 'Aokana window horizontal text'),
          handle = pop32(context.thread),
          effect = createAokanaHorizontalTextEffect(mode, radiusX, radiusY, effectColor, opacity);
        return drawWindow(
          context,
          handle,
          source,
          readingEnabled,
          wrapping,
          color,
          readingColor,
          effect,
        );
      },
    },
    {
      primary: 0x91,
      secondary: 0x9c,
      nativeAddress: 0x1400deaf0,
      name: 'DrawSurfaceHorizontalText',
      execute: async (context): Promise<0> => {
        const color = pop32(context.thread),
          lineSpacingPercent = pop32(context.thread),
          wrapping = pop32(context.thread),
          proportional = pop32(context.thread),
          bold = pop32(context.thread),
          fontWidth = pop32(context.thread),
          fontSize = pop32(context.thread),
          registeredFont = pop32(context.thread),
          annotations = pointer(context),
          readingEnabled = pop32(context.thread),
          source = requiredPointer(pointer(context), 'Aokana surface horizontal text'),
          y = pop32(context.thread),
          x = pop32(context.thread),
          surface = pop32(context.thread),
          validation = validateSurfaceAndFont(context, surface, registeredFont);
        if (validation !== 0) return validation;
        return drawSurface(context, {
          surface,
          lineOutput: {value: registeredFont},
          x,
          y,
          source,
          readingEnabled,
          annotations,
          registeredFont,
          fontSize,
          fontWidth,
          bold,
          proportional,
          wrapping,
          lineSpacingPercent,
          color,
          readingColor: color,
          effect: state.defaultEffect,
        });
      },
    },
    {
      primary: 0x91,
      secondary: 0x9d,
      nativeAddress: 0x1400de840,
      name: 'DrawSurfaceHorizontalTextOptionalEffect',
      execute: async (context): Promise<0> => {
        const disableEffect = pop32(context.thread),
          color = pop32(context.thread),
          lineSpacingPercent = pop32(context.thread),
          wrapping = pop32(context.thread),
          proportional = pop32(context.thread),
          bold = pop32(context.thread),
          fontWidth = pop32(context.thread),
          fontSize = pop32(context.thread),
          registeredFont = pop32(context.thread),
          annotations = pointer(context),
          readingEnabled = pop32(context.thread),
          source = requiredPointer(pointer(context), 'Aokana surface horizontal text'),
          y = pop32(context.thread),
          x = pop32(context.thread),
          surface = pop32(context.thread),
          validation = validateSurfaceAndFont(context, surface, registeredFont);
        if (validation !== 0) return validation;
        return drawSurface(context, {
          surface,
          lineOutput: {value: wrapping},
          x,
          y,
          source,
          readingEnabled,
          annotations,
          registeredFont,
          fontSize,
          fontWidth,
          bold,
          proportional,
          wrapping,
          lineSpacingPercent,
          color,
          readingColor: color,
          effect:
            disableEffect === 0 ? state.defaultEffect : AOKANA_DISABLED_HORIZONTAL_TEXT_EFFECT,
        });
      },
    },
    {
      primary: 0x92,
      secondary: 0x9c,
      nativeAddress: 0x1400e3210,
      name: 'DrawSurfaceHorizontalTextExtended',
      execute: async (context): Promise<0> => {
        pop32(context.thread);
        const opacity = pop32(context.thread),
          effectColor = pop32(context.thread),
          radiusY = pop32(context.thread),
          radiusX = pop32(context.thread),
          mode = pop32(context.thread),
          lineSpacingPercent = pop32(context.thread),
          wrapping = pop32(context.thread),
          proportional = pop32(context.thread),
          bold = pop32(context.thread),
          fontWidth = pop32(context.thread),
          fontSize = pop32(context.thread),
          registeredFont = pop32(context.thread),
          readingColor = pop32(context.thread),
          annotations = pointer(context),
          readingEnabled = pop32(context.thread),
          color = pop32(context.thread),
          source = requiredPointer(pointer(context), 'Aokana surface horizontal text'),
          y = pop32(context.thread),
          x = pop32(context.thread),
          surface = pop32(context.thread),
          validation = validateSurfaceAndFont(context, surface, registeredFont);
        if (validation !== 0) return validation;
        return drawSurface(context, {
          surface,
          lineOutput: {value: registeredFont},
          x,
          y,
          source,
          readingEnabled,
          annotations,
          registeredFont,
          fontSize,
          fontWidth,
          bold,
          proportional,
          wrapping,
          lineSpacingPercent,
          color,
          readingColor,
          effect: createAokanaHorizontalTextEffect(mode, radiusX, radiusY, effectColor, opacity),
        });
      },
    },
  ];
}
