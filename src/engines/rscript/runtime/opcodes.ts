import {Config, Scene} from '../memory.js';
import {AudioChannel} from './audio.js';
import type {RScriptGame} from './game.js';
import type {RScriptLayer} from './layer.js';
import {BoxRecord, MessageState} from './message-window.js';
import type {RScriptInterpreter, RScriptNativeHandler} from '../vm/interpreter.js';

/** `^`-free colour presets of opcode 0x5F (sub_425D00), as COLORREF values. */
const TEXT_COLORS = [
  0, 0xffffff, 7991794, 12006195, 16768512, 16298479, 8380325, 12683254, 16425562,
];

const u16 = (value: number): number => value & 0xffff;

/**
 * Native opcode handlers of the RScript 1.11 dispatcher (0x422FD0) other than control flow,
 * which the interpreter runs itself. Operands arrive raw; value operands are resolved here
 * as the dispatcher does before calling the native handler.
 */
export function createOpcodeHandlers(game: RScriptGame): Map<number, RScriptNativeHandler> {
  const handlers = new Map<number, RScriptNativeHandler>();
  const {flags, memory} = game;
  const values = (vm: RScriptInterpreter, operands: readonly number[]): number[] =>
    operands.map((raw) => vm.value(raw));
  const on = (
    opcode: number,
    handler: (args: number[], vm: RScriptInterpreter, raw: readonly number[]) => unknown,
  ) =>
    handlers.set(opcode, async (vm, raw) => {
      await handler(values(vm, raw), vm, raw);
    });

  const skipping = (): boolean => flags.fastSkip;
  /** Effects are dropped while skipping or when disabled in the configuration. */
  const effect = (value: number): number => (flags.skip || !game.effectsEnabled ? 0 : value);
  const afterLayers = async (): Promise<void> => {
    if (!flags.batch) await game.refresh();
  };
  const scaleX = (): number => memory.sceneWord(Scene.coordinateScaleX);
  const scaleY = (): number => memory.sceneWord(Scene.coordinateScaleY);
  const forTargets = (id: number, run: (layer: RScriptLayer) => unknown): Promise<unknown> =>
    Promise.all(game.targets(u16(id)).map(run));
  const snapshot = (): void => {
    if (memory.sceneDword(Scene.messageSnapshots) && !game.nesting) memory.captureMessageSnapshot();
  };
  const markSeen = (image: number): void => {
    if (image < 1000) memory.variables[9000 + image] = 1;
    memory.seenImages.add(0, image);
  };
  const transition = (kind: number, steps: number, milliseconds: number): Promise<void> =>
    runTransition(game, u16(kind), steps, u16(milliseconds));

  // Waits and timing.
  on(0x0a, async () => {
    snapshot();
    await game.waitClick();
  });
  on(0x0b, async () => {
    snapshot();
    if (skipping()) return;
    await game.waitClick();
    clearBox(0);
  });
  on(0x0d, async ([tenths]) => {
    if (flags.skip || skipping()) return;
    flags.waitInput = true;
    await game.sleep(100 * u16(tenths!));
    flags.waitInput = false;
  });
  handlers.set(0x0e, async (vm, raw) => {
    const header = raw[0]!,
      targets = raw.slice(2, 7),
      [effectMode, , arrangement] = raw.slice(12, 15).map((value) => vm.value(value));
    const answers = raw.slice(7, 12).slice(0, Math.min(5, header & 0xff));
    await choose(
      vm.expandString(raw[1]!),
      answers.map((index) => vm.expandString(index)),
      effectMode!,
      arrangement!,
    );
    const target = targets[game.choice.selected - 1];
    if (target !== undefined) vm.jump(target);
  });
  on(0x12, ([variable], vm, raw) => {
    const array = vm.program?.arrays[raw[1]!];
    if (!array) return;
    memory.variables.set(
      array.subarray(0, memory.variables.length - u16(variable!)),
      u16(variable!),
    );
  });
  on(0x13, ([script]) => game.systemCall(u16(script!)));

  // Background layer 0.
  on(0x14, async ([image, loadFlags]) => {
    image = u16(image!);
    game.layers[0]!.setKind(0, skipping());
    markSeen(image);
    if (image) await game.layers[0]!.load(image, 0, 0, 0, loadFlags!, skipping());
    else await game.layers[0]!.fill(0, skipping());
    if (!flags.batch) await transition(0, 15, 0);
  });
  on(0x15, async ([white]) => {
    game.layers[0]!.setKind(0, skipping());
    await game.layers[0]!.fill(white === 1 ? 0xffffff : 0, skipping());
    if (!flags.batch) await transition(1, 15, 0);
  });
  on(0x16, async ([kind, x, y, speed]) => {
    moveLayer(game.layers[0]!, kind!, x!, y!, speed!, false);
    await afterLayers();
  });
  on(0x17, async ([count, kind]) => {
    if (flags.skip || skipping() || !game.effectsEnabled) return;
    const times = u16(count!) || 1;
    if (kind === 1) await game.display.shake(times, 15, 5, true);
    else if (kind === 2) await game.display.shakeLoop(times, 60, 5);
    else await game.display.shake(times, 15, 5, false);
  });
  on(0x18, async ([count, kind]) => {
    if (flags.skip || skipping() || !game.effectsEnabled) return;
    const times = u16(count!) || 1;
    if (kind === 1) await game.display.flashCycle(times);
    else await game.display.flash(kind === 2 ? 0xff : kind === 3 ? 0x80ffff : 0xffffff, times);
  });

  // Batches and transitions.
  on(0x1a, () => {
    flags.batch = true;
  });
  on(0x1b, () => game.flushBatch());
  on(0x1c, ([kind, steps, milliseconds]) => {
    flags.batch = false;
    return transition(kind!, steps!, milliseconds!);
  });
  on(0x1d, ([zoom, anchors]) => {
    flags.batch = false;
    return transition((zoom ? 100 : 200) + anchors!, 0, 0);
  });

  // Layers. The dispatcher passes 0x1E, 0x21 and 0x22 operands to the handlers reordered.
  on(0x1e, async ([id, image, x, y, kind, loadFlags]) => {
    const layer = game.layers[u16(id!)];
    if (!layer || !id) return;
    await layer.load(
      u16(image!),
      effect(kind!),
      x! * scaleX(),
      y! * scaleY(),
      loadFlags!,
      skipping(),
    );
    await afterLayers();
  });
  on(0x21, async ([id, x, y, kind, speed]) => {
    await forTargets(id!, (layer) =>
      moveLayer(layer, kind!, x! * scaleX(), y! * scaleY(), speed!, false),
    );
    await afterLayers();
  });
  on(0x22, async ([id, x, y, kind, speed]) => {
    await forTargets(id!, (layer) =>
      moveLayer(layer, kind!, x! * scaleX(), y! * scaleY(), speed!, true),
    );
    await afterLayers();
  });
  on(0x24, async ([id, kind]) => {
    await forTargets(id!, (layer) => layer.hide(effect(u16(kind!)), skipping()));
    await afterLayers();
  });
  on(0x25, ([id, visible]) => forTargets(id!, (layer) => layer.setVisible(visible!, skipping())));
  on(0x26, ([id, centerX, centerY, keep]) =>
    forTargets(id!, (layer) => layer.setAnchors(centerX!, centerY!, keep!)),
  );
  on(0x27, ([id, mode, percent]) =>
    forTargets(id!, (layer) => layer.setBlend(mode!, u16(percent!), skipping())),
  );
  on(0x28, ([id, order]) =>
    forTargets(id!, (layer) => {
      memory.setSceneWord(Scene.layerOrders + 2 * layer.index, order!);
      if (!skipping()) game.root.setPriority(layer, order!);
    }),
  );
  on(0x29, ([id, group]) => {
    if (u16(id!) && u16(id!) < Scene.layerCount)
      memory.setSceneWord(Scene.layerGroups + 2 * u16(id!), group!);
  });
  on(0x31, ([id, kind]) => forTargets(id!, (layer) => layer.setKind(kind!, skipping())));
  on(0x79, ([id], vm, raw) => {
    const name = vm.expandString(raw[1]!);
    const directory = new Uint8Array(name.length + 2);
    directory.set([0x2e, 0x5c]);
    directory.set(name, 2);
    return forTargets(id!, (layer) => layer.setDirectory(directory));
  });
  on(0xe6, async ([image]) => {
    image = u16(image!);
    markSeen(image);
    if (!image) return;
    game.layers[0]!.setKind(2, skipping());
    await game.layers[0]!.load(image, 0, 0, 0, 0, skipping());
    if (!flags.batch) await transition(0, 15, 0);
  });

  // Buttons.
  const button = (mode: number) => (args: number[]) => {
    const [id, buttonId, hoverStyle, keepHover] = args;
    const layer = game.layers[u16(id!)];
    if (u16(id!) && layer) layer.setButton(mode, hoverStyle!, buttonId!, keepHover!, skipping());
  };
  on(0x46, button(0));
  on(0x47, button(1));
  on(0x4d, button(2));
  on(0x48, ([id]) => {
    if (u16(id!)) game.layers[u16(id!)]?.stopButton(true, skipping());
  });
  on(0x49, ([variable, hideTimer, cancel]) =>
    buttonWait(game, u16(variable!), hideTimer!, !!cancel),
  );
  on(0x4a, ([value]) => memory.setSceneDword(Scene.layerAnimationReset, u16(value!)));
  on(0x4b, ([id, image, x, y, slot]) => {
    if (u16(id!))
      return game.layers[u16(id!)]?.setOverlay(u16(slot!), u16(image!), x!, y!, skipping());
  });

  // Effect screen and tone overlay.
  on(0x2b, async ([image, mode]) => {
    memory.setSceneWord(Scene.effectImage, image!);
    memory.setSceneWord(Scene.effectBlend, mode!);
    if (!skipping()) await game.applyEffectScreen();
  });
  on(0x2c, ([order]) => {
    memory.setSceneWord(Scene.effectOrder, order!);
    if (!skipping()) game.root.setPriority(game.effectScreen, order!);
  });
  on(0x2d, async ([percent, mode]) => {
    memory.setSceneWord(Scene.overlayPercent, percent!);
    memory.setSceneWord(Scene.overlayBlend, mode!);
    if (skipping()) return;
    game.applyOverlay();
    if (!flags.batch) await transition(1, 15, 0);
  });
  on(0x2e, ([order]) => {
    memory.setSceneWord(Scene.overlayOrder, order!);
    if (!skipping()) game.root.setPriority(game.overlay, order!);
  });
  on(0x2f, ([x, y]) => {
    memory.setSceneWord(Scene.coordinateScaleX, x!);
    memory.setSceneWord(Scene.coordinateScaleY, y!);
  });

  // Snapshots, skipping and the backlog.
  on(0x32, () => {
    if (!game.nesting) memory.promoteMessageSnapshot();
  });
  on(0x33, async () => {
    flags.skip = false;
    flags.fastSkip = false;
    memory.restorePreviousSnapshot();
    game.message.clearBacklog();
    await game.vm.load(game.currentScript);
    game.vm.jump(game.vm.returnAt(game.vm.depth));
    await game.rebuild();
    game.display.refresh();
  });
  on(0x34, async () => {
    flags.skipHeld = false;
    if (!flags.fastSkip) return;
    flags.fastSkip = false;
    await game.rebuild();
    game.display.refresh();
  });
  on(0x37, () => {
    if (!game.nesting) memory.captureMessageSnapshot();
  });
  on(0x38, ([menu, buttons, tab, backlog, snapshots]) => {
    const message = (offset: number, value: number) =>
      memory.setSceneDword(Scene.message + offset, value);
    message(MessageState.menuEnabled, u16(menu!));
    message(MessageState.panelButtons, u16(buttons!));
    message(MessageState.tabEnabled, u16(tab!));
    message(MessageState.backlogEnabled, u16(backlog!));
    memory.setSceneDword(0x6c, u16(buttons!));
    memory.setSceneDword(Scene.messageSnapshots, u16(snapshots!));
  });
  on(0x39, () => game.message.clearBacklog());

  // Audio and movies.
  on(0x3c, ([track, fade, fadeSteps]) => game.playMusic(u16(track!), !!fade, u16(fadeSteps!)));
  on(0x3d, ([fade, fadeSteps]) => game.stopMusic(!!fade, u16(fadeSteps!)));
  on(0x3e, ([channel, sound]) => game.loadSound(u16(channel!), u16(sound!)));
  on(0x3f, ([channel, repeat, fade, pan]) =>
    game.playSound(u16(channel!), u16(repeat!), fade!, pan!),
  );
  on(0x40, ([channel, fade]) => game.stopSound(u16(channel!), !!fade));
  on(0x41, async ([movie]) => {
    await game.host.playMovie(
      `${game.apini.directories.movies}\\${String(u16(movie!)).padStart(4, '0')}.mpg`,
    );
  });
  handlers.set(0x42, (vm, raw) => {
    // 1.9 reads the voice number as a value (0x4217F0); 1.11 as a raw dword.
    const voice =
        memory.revision.layouts.get(0x42)![0] === 'u32'
          ? raw[0]! >>> 0
          : vm.value(raw[0]!) & 0xffff,
      repeat = vm.value(raw[1]!),
      fade = vm.value(raw[2]!),
      pan = vm.value(raw[3]!);
    if (!voice || skipping() || flags.skip) return;
    game.playVoice(voice, repeat === 999 ? -1 : repeat ? repeat - 1 : 0, !!fade, pan);
  });
  on(0x43, ([fade]) => {
    if (!skipping()) game.audio.stop(AudioChannel.voice, !!fade);
  });
  on(0x44, async () => {
    memory.setSceneWord(Scene.soundChannels + 2, 0);
    if (skipping() || flags.skip) return;
    flags.waitSound = true;
    await game.audio.waitEnd(AudioChannel.effect);
    flags.waitSound = false;
  });
  on(0x45, async () => {
    if (skipping() || flags.skip) return;
    flags.waitVoice = true;
    await game.audio.waitEnd(AudioChannel.voice);
    flags.waitVoice = false;
  });

  // Messages.
  const clearBox = (box: number): void => {
    game.message.clear(u16(box), skipping());
    if (!skipping()) game.display.update();
  };
  const showMessage = async (
    box: number,
    text: number,
    name: number,
    wait: number,
    voice: number,
    repeat: number,
    pan: number,
    newPage: boolean,
  ): Promise<void> => {
    flags.batch = false;
    const script = game.currentScript;
    const unread = !memory.readText.has(script, text);
    const skipUnread = game.config(Config.skipUnread) !== 0;
    if (flags.fastSkip && !skipUnread && unread) {
      flags.fastSkip = false;
      await game.rebuild();
      game.display.refresh();
    }
    // sub_426590 clears the held key and the running skip, so this page stops for a click.
    if (flags.skip && !skipUnread && unread) {
      game.setSkip(false);
      flags.skip = false;
    }
    memory.readText.add(script, text);
    snapshot();
    const mode = memory.sceneWord(Scene.messageMode);
    if (newPage) {
      if (mode === 1) clearBox(box);
      game.message.setVoice(voice, pan);
    }
    await game.message.display(u16(box), {script, text, name}, newPage, skipping());
    if (skipping()) {
      if (!mode) game.message.clear(u16(box), true);
      return;
    }
    if (newPage && voice && !flags.skip)
      game.playVoice(voice, repeat === 999 ? -1 : repeat ? repeat - 1 : 0, false, pan);
    // sub_426360: reveal, then optionally wait for a click and clear the page.
    if (flags.skip) {
      game.message.finish();
      game.display.update();
    } else {
      game.message.reveal();
      flags.waitAnimation = true;
      await game.suspend();
    }
    if (wait) {
      await game.waitClick();
      if (!mode) clearBox(box);
    }
    game.message.finish();
    game.display.update();
    if (newPage && voice && !repeat && wait && !game.config(Config.voiceContinues))
      game.audio.stop(AudioChannel.voice, false);
  };
  handlers.set(0x51, async (vm, raw) => {
    await showMessage(
      vm.value(raw[0]!),
      raw[5]! >>> 0,
      raw[4]! >>> 0,
      vm.value(raw[6]!),
      raw[1]! >>> 0,
      vm.value(raw[2]!),
      vm.value(raw[3]!),
      true,
    );
  });
  handlers.set(0x52, async (vm, raw) => {
    await showMessage(vm.value(raw[0]!), raw[4]! >>> 0, 0, vm.value(raw[5]!), 0, 0, 0, false);
  });
  on(0x53, async ([box]) => {
    game.message.clear(u16(box!), skipping());
    await afterLayers();
  });
  on(0x2a, async ([box, visible]) => {
    await game.message.showBox(u16(box!) & 3, !!visible, skipping());
    await afterLayers();
  });

  // Text boxes: a zero selector means box 0, anything else boxes 1..3. 1.9 shows one box
  // and its setters ignore the selector (0x42DD50).
  const singleBox = memory.revision.textBoxes === 1;
  const boxes = (selector: number, apply: (box: number) => void): Promise<void> => {
    const all = selector !== 0 && !singleBox;
    for (const box of all ? [1, 2, 3] : [0]) apply(box);
    return skipping() ? Promise.resolve() : game.message.applyBoxes(all ? 1 : 0, all);
  };
  const single = (box: number, apply: (box: number) => void): Promise<void> => {
    const index = singleBox ? 0 : u16(box) & 3;
    apply(index);
    return skipping() ? Promise.resolve() : game.message.applyBoxes(index, false);
  };
  const setWord = (box: number, field: number, value: number) =>
    game.message.setBoxWord(box, field, value);
  const setDword = (box: number, field: number, value: number) =>
    game.message.setBoxDword(box, field, value);
  on(0x5a, ([box, x, y]) =>
    single(box!, (b) => {
      setDword(b, BoxRecord.x, x!);
      setDword(b, BoxRecord.y, y!);
    }),
  );
  on(0x5b, ([selector, x, y, width, height]) =>
    boxes(selector!, (b) => {
      setDword(b, BoxRecord.textX, x!);
      setDword(b, BoxRecord.textY, y!);
      setDword(b, BoxRecord.textWidth, u16(width!));
      setDword(b, BoxRecord.textHeight, u16(height!));
    }),
  );
  on(0x5c, ([box, frame]) => single(box!, (b) => setWord(b, BoxRecord.frame, u16(frame!))));
  on(0x5d, ([x, y]) => {
    memory.setSceneDword(Scene.message + MessageState.panelX, x!);
    memory.setSceneDword(Scene.message + MessageState.panelY, y!);
  });
  on(0x5e, ([enabled]) =>
    memory.setSceneDword(Scene.message + MessageState.panelEnabled, u16(enabled!)),
  );
  on(0x5f, ([selector, color]) =>
    boxes(selector!, (b) => setDword(b, BoxRecord.color, TEXT_COLORS[color!] ?? 0)),
  );
  on(0x60, ([selector, size]) => boxes(selector!, (b) => setWord(b, BoxRecord.size, size!)));
  on(0x61, ([selector, face]) => boxes(selector!, (b) => setWord(b, BoxRecord.face, face!)));
  on(0x62, ([selector, align]) => boxes(selector!, (b) => setWord(b, BoxRecord.align, align!)));
  on(0x63, ([selector, indent, first]) =>
    boxes(selector!, (b) => {
      setWord(b, BoxRecord.indent, u16(indent!));
      setWord(b, BoxRecord.firstIndent, first!);
    }),
  );
  on(0x64, ([selector, x, y]) =>
    boxes(selector!, (b) => {
      setDword(b, BoxRecord.waitX, x!);
      setDword(b, BoxRecord.waitY, y!);
    }),
  );
  on(0x65, ([x, y]) => {
    memory.setSceneDword(Scene.message + MessageState.faceX, x!);
    memory.setSceneDword(Scene.message + MessageState.faceY, y!);
  });
  on(0x66, ([mode]) => memory.setSceneWord(Scene.messageMode, mode!));
  on(0x67, ([box, icon]) => single(box!, (b) => setWord(b, BoxRecord.waitIcon, u16(icon!))));
  on(0x68, ([selector, red, green, blue]) =>
    boxes(selector!, (b) =>
      setDword(b, BoxRecord.glow, ((red! & 0xff) << 16) | ((green! & 0xff) << 8) | (blue! & 0xff)),
    ),
  );
  on(0x69, ([, front]) =>
    memory.setSceneWord(Scene.message + MessageState.faceOrder, front ? 0 : 10),
  );
  on(0x6a, ([selector, x, y, width, height]) =>
    boxes(selector!, (b) => {
      setDword(b, BoxRecord.nameX, x!);
      setDword(b, BoxRecord.nameY, y!);
      setDword(b, BoxRecord.nameWidth, u16(width!));
      setDword(b, BoxRecord.nameHeight, u16(height!));
    }),
  );
  on(0x6b, ([selector, line, character]) =>
    boxes(selector!, (b) => {
      setWord(b, BoxRecord.lineSpacing, line!);
      setWord(b, BoxRecord.charSpacing, character!);
    }),
  );
  on(0x6c, ([selector, face, size, raise]) =>
    boxes(selector!, (b) => {
      setWord(b, BoxRecord.rubyFace, face!);
      setWord(b, BoxRecord.rubySize, size!);
      setWord(b, BoxRecord.rubyRaise, u16(raise!));
    }),
  );

  // Variables and gauges.
  on(0x84, ([gauge, visible]) => {
    if (u16(gauge!) < Scene.gaugeCount)
      memory.setSceneWord(Scene.gauges + Scene.gaugeStride * u16(gauge!), visible!);
  });
  on(0xca, ([first, last, value]) => {
    const from = u16(first!),
      to = Math.min(u16(last!), memory.variables.length - 1);
    if (from <= to) memory.variables.fill(value!, from, to + 1);
  });
  on(0xe1, ([x, y, variable, hideTimer, cancel]) =>
    pointerWait(game, u16(x!), u16(y!), u16(variable!), hideTimer!, !!cancel),
  );

  /** sub_427FE0: shows the choice window and waits for an answer. */
  async function choose(
    question: Uint8Array,
    answers: readonly Uint8Array[],
    effectMode: number,
    arrangement: number,
  ): Promise<void> {
    await game.flushBatch();
    if (flags.fastSkip) {
      flags.fastSkip = false;
      await game.rebuild();
      game.display.refresh();
    }
    game.stopAuto();
    snapshot();
    game.message.pageText = question;
    const window = game.choice;
    await window.open(question, answers, arrangement);
    const present = async (): Promise<void> => {
      if (effectMode === 2) await transition(1, 15, 20);
      else if (effectMode === 3) await transition(2, 15, 20);
      else await game.refresh();
    };
    const instant = (): boolean => !game.effectsEnabled || flags.skip || effectMode !== 0;
    window.appear(instant());
    await present();
    window.setInput(true);
    flags.choice = true;
    flags.waitInput = true;
    game.message.setInput(true);
    await game.suspend();
    game.message.setInput(false);
    flags.waitInput = false;
    if (memory.sceneDword(Scene.autoRebuild) && !game.nesting) memory.promoteMessageSnapshot();
    window.setInput(false);
    window.disappear(instant());
    await present();
    window.close();
    game.display.update();
  }

  /** sub_4254B0 / sub_425550: effects of seven and above are dropped when skipping. */
  function moveLayer(
    layer: RScriptLayer,
    kind: number,
    x: number,
    y: number,
    speed: number,
    relative: boolean,
  ): void {
    kind = u16(kind);
    if (flags.skip || !game.effectsEnabled) {
      if (kind % 100 >= 7) return;
      kind = 0;
    }
    if (relative) {
      x += memory.sceneDword(layer.record);
      y += memory.sceneDword(layer.record + 4);
    }
    layer.moveTo(kind, x, y, u16(speed), skipping());
  }

  if (memory.revision.soundChannels === 1) {
    // 1.9 (0x4216C0, 0x421730, 0x4217C0): one sound-effect channel and no channel operand.
    on(0x3e, ([sound]) => game.loadSound(0, u16(sound!)));
    on(0x3f, ([repeat, fade, pan]) => game.playSound(0, u16(repeat!), fade!, pan!));
    on(0x40, ([fade]) => game.stopSound(0, !!fade));
  }
  return handlers;
}

/** sub_427650: waits for a button of the layers, running interrupt calls in between. */
async function buttonWait(
  game: RScriptGame,
  timerVariable: number,
  hideTimer: number,
  cancel: boolean,
): Promise<void> {
  const {flags, memory} = game;
  flags.buttonCancel = cancel;
  for (;;) {
    flags.interrupt = false;
    await prepareInputWait(game);
    flags.buttonWait = 1;
    game.setButtonInput(true, false);
    if (timerVariable) {
      if (!hideTimer) game.diagnostic('Timed button waits do not show their gauge yet');
      game.startButtonTimer(memory.variables[timerVariable]!);
    } else game.message.setInput(true);
    flags.waitInput = true;
    await game.suspend();
    flags.waitInput = false;
    game.message.setInput(false);
    const remaining = game.stopButtonTimer();
    if (timerVariable) memory.variables[timerVariable] = remaining;
    game.setButtonInput(false, false);
    if (!flags.interrupt) break;
    await game.systemCall(memory.variables[0]!);
  }
  if (memory.sceneDword(Scene.layerAnimationReset))
    for (const layer of game.layers.slice(1)) layer.stopButton(false, false);
  if (memory.sceneDword(Scene.autoRebuild) && !game.nesting) memory.promoteMessageSnapshot();
}

/** Pending batch, fast skip, auto mode and message snapshot before an input wait. */
async function prepareInputWait(game: RScriptGame): Promise<void> {
  const {flags, memory} = game;
  await game.flushBatch();
  if (flags.fastSkip) {
    flags.fastSkip = false;
    await game.rebuild();
    game.display.refresh();
  }
  game.stopAuto();
  if (memory.sceneDword(Scene.messageSnapshots) && !game.nesting) memory.captureMessageSnapshot();
}

/**
 * sub_428840: waits for a click anywhere (variable 0 = 1) or, with `cancel`, the right
 * button (0), then stores the pointer position and the remaining time in variables.
 */
async function pointerWait(
  game: RScriptGame,
  xVariable: number,
  yVariable: number,
  timerVariable: number,
  hideTimer: number,
  cancel: boolean,
): Promise<void> {
  const {flags, memory} = game;
  flags.buttonCancel = cancel;
  for (;;) {
    flags.interrupt = false;
    await prepareInputWait(game);
    flags.buttonWait = 3;
    if (timerVariable) {
      if (!hideTimer) game.diagnostic('Timed pointer waits do not show their gauge yet');
      game.startButtonTimer(memory.variables[timerVariable]!);
    } else game.message.setInput(true);
    flags.waitInput = true;
    await game.suspend();
    flags.waitInput = false;
    if (xVariable) memory.variables[xVariable] = game.pointer.x;
    if (yVariable) memory.variables[yVariable] = game.pointer.y;
    game.message.setInput(false);
    const remaining = game.stopButtonTimer();
    if (timerVariable) memory.variables[timerVariable] = remaining;
    if (!flags.interrupt) break;
    await game.systemCall(memory.variables[0]!);
  }
  if (memory.sceneDword(Scene.autoRebuild) && !game.nesting) memory.promoteMessageSnapshot();
}

/** Numpad anchors of zoom and shrink transitions (sub_425010). */
function anchor(game: RScriptGame, digit: number): {x: number; y: number} {
  const w = game.width,
    h = game.height;
  const column =
    digit === 1 || digit === 4 || digit === 7
      ? 0
      : digit === 3 || digit === 6 || digit === 9
        ? w
        : w >> 1;
  const row = digit >= 1 && digit <= 3 ? h : digit >= 7 && digit <= 9 ? 0 : h >> 1;
  return {x: column, y: row};
}

/** sub_4259B0: screen transitions after layer changes. */
export async function runTransition(
  game: RScriptGame,
  kind: number,
  steps: number,
  milliseconds: number,
): Promise<void> {
  const {flags, display} = game;
  if (flags.fastSkip) return;
  const count = steps || 10;
  if (flags.skip || !game.effectsEnabled || kind === 0) {
    display.update();
    return;
  }
  if (kind < 100) {
    if (kind === 1) return display.fade(count, milliseconds);
    if (kind === 2) return display.dissolve(count, milliseconds);
    if (kind === 3 || kind === 4) return display.dip(kind === 3, count, milliseconds);
    const path = `${game.apini.directories.system}\\ef${String(kind).padStart(2, '0')}`;
    const mask = await game.images.mask(path);
    if (mask) await display.wipe(mask, count, milliseconds);
    else game.diagnostic(`Missing transition mask ${path}`);
    display.update();
    return;
  }
  const from = anchor(game, Math.trunc((kind % 100) / 10)),
    to = anchor(game, kind % 10);
  if (Math.trunc(kind / 100) === 1) await display.zoomThrough(from, to);
  else if (Math.trunc(kind / 100) === 2) await display.shrinkThrough(from, to);
}
