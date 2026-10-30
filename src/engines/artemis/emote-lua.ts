import {luaText, type LuaValue} from '../../core/lua51/runtime.js';
import {EmoteUnsupportedError, type EmotePlayer} from '../../native/emotedriver/player.js';

/** luabind's argument converters of the IEmotePlayer class (0x14001b070): `f` float and
 * `u` unsigned int take Lua numbers, `s` char const* Lua strings, `b` bool Lua booleans. */
type Argument = 'f' | 'u' | 's' | 'b';
type Converted = number | string | boolean;
interface Method {
  readonly args: readonly Argument[];
  readonly call: (player: EmotePlayer, args: readonly Converted[]) => LuaValue | void;
}

const n = (value: Converted) => value as number;
const s = (value: Converted) => value as string;
const b = (value: Converted) => value as boolean;
const text = (value: string) => new TextEncoder().encode(value);
const f32 = Math.fround;

/** The IEmotePlayer methods luabind binds over the player vtable thunks (0x14002e0f4..). */
const methods: ReadonlyMap<string, Method> = new Map<string, Method>([
  ['show', {args: [], call: (p) => p.show()}],
  ['hide', {args: [], call: (p) => p.hide()}],
  ['isHidden', {args: [], call: (p) => p.isHidden()}],
  ['setSmoothing', {args: ['b'], call: (p, a) => p.setSmoothing(b(a[0]!))}],
  ['getSmoothing', {args: [], call: (p) => p.getSmoothing()}],
  ['setMeshDivisionRatio', {args: ['f'], call: (p, a) => p.setMeshDivisionRatio(n(a[0]!))}],
  ['getMeshDivisionRatio', {args: [], call: (p) => p.getMeshDivisionRatio()}],
  ['setQueuing', {args: ['b'], call: (p, a) => void (p.queuing = b(a[0]!))}],
  ['getQueuing', {args: [], call: (p) => p.queuing}],
  ['setHairScale', {args: ['f'], call: (p, a) => void (p.hairScale = n(a[0]!))}],
  ['getHairScale', {args: [], call: (p) => p.hairScale}],
  ['setPartsScale', {args: ['f'], call: (p, a) => void (p.partsScale = n(a[0]!))}],
  ['getPartsScale', {args: [], call: (p) => p.partsScale}],
  ['setBustScale', {args: ['f'], call: (p, a) => void (p.bustScale = n(a[0]!))}],
  ['getBustScale', {args: [], call: (p) => p.bustScale}],
  [
    'setCoord',
    {
      args: ['f', 'f', 'f', 'f'],
      call: (p, a) => p.setCoord(n(a[0]!), n(a[1]!), n(a[2]!), n(a[3]!)),
    },
  ],
  ['setScale', {args: ['f', 'f', 'f'], call: (p, a) => p.setScale(n(a[0]!), n(a[1]!), n(a[2]!))}],
  ['getScale', {args: [], call: (p) => p.getScale()}],
  ['setRot', {args: ['f', 'f', 'f'], call: (p, a) => p.setRot(n(a[0]!), n(a[1]!), n(a[2]!))}],
  ['getRot', {args: [], call: (p) => p.getRot()}],
  ['setColor', {args: ['u', 'f', 'f'], call: (p, a) => p.setColor(n(a[0]!), n(a[1]!), n(a[2]!))}],
  ['getColor', {args: [], call: (p) => p.getColor()}],
  [
    'setGrayscale',
    {args: ['f', 'f', 'f'], call: (p, a) => p.setGrayscale(n(a[0]!), n(a[1]!), n(a[2]!))},
  ],
  ['getGrayscale', {args: [], call: (p) => p.getGrayscale()}],
  ['setAsOriginalScale', {args: ['b'], call: (p, a) => p.setAsOriginalScale(b(a[0]!))}],
  ['isAsOriginalScale', {args: [], call: (p) => p.isAsOriginalScale()}],
  ['countVariables', {args: [], call: (p) => p.countVariables()}],
  ['getVariableLabelAt', {args: ['u'], call: (p, a) => text(p.getVariableLabelAt(n(a[0]!)))}],
  ['countVariableFrameAt', {args: ['u'], call: (p, a) => p.countVariableFrameAt(n(a[0]!))}],
  [
    'getVariableFrameLabelAt',
    {args: ['u', 'u'], call: (p, a) => text(p.getVariableFrameLabelAt(n(a[0]!), n(a[1]!)))},
  ],
  [
    'getVariableFrameValueAt',
    {args: ['u', 'u'], call: (p, a) => p.getVariableFrameValueAt(n(a[0]!), n(a[1]!))},
  ],
  ['addUserDefinedVariable', {args: ['s'], call: (p, a) => p.addUserDefinedVariable(s(a[0]!))}],
  [
    'setVariable',
    {
      args: ['s', 'f', 'f', 'f'],
      call: (p, a) => p.setVariable(s(a[0]!), n(a[1]!), n(a[2]!), n(a[3]!)),
    },
  ],
  ['getVariable', {args: ['s'], call: (p, a) => p.getVariable(s(a[0]!))}],
  [
    'setVariableDiff',
    {
      args: ['s', 's', 'f', 'f', 'f'],
      call: (p, a) => p.setVariableDiff(s(a[0]!), s(a[1]!), n(a[2]!), n(a[3]!), n(a[4]!)),
    },
  ],
  ['getVariableDiff', {args: ['s', 's'], call: (p, a) => p.getVariableDiff(s(a[0]!), s(a[1]!))}],
  [
    'setOuterForce',
    {
      args: ['s', 'f', 'f', 'f', 'f'],
      call: (p, a) => p.setOuterForce(s(a[0]!), n(a[1]!), n(a[2]!), n(a[3]!), n(a[4]!)),
    },
  ],
  [
    'startWind',
    {
      args: ['f', 'f', 'f', 'f', 'f'],
      call: (p, a) => p.startWind(n(a[0]!), n(a[1]!), n(a[2]!), n(a[3]!), n(a[4]!)),
    },
  ],
  ['stopWind', {args: [], call: (p) => p.stopWind()}],
  ['countMainTimelines', {args: [], call: (p) => p.countMainTimelines()}],
  [
    'getMainTimelineLabelAt',
    {args: ['u'], call: (p, a) => text(p.getMainTimelineLabelAt(n(a[0]!)))},
  ],
  ['countDiffTimelines', {args: [], call: (p) => p.countDiffTimelines()}],
  [
    'getDiffTimelineLabelAt',
    {args: ['u'], call: (p, a) => text(p.getDiffTimelineLabelAt(n(a[0]!)))},
  ],
  ['countPlayingTimelines', {args: [], call: (p) => p.countPlayingTimelines()}],
  [
    'getPlayingTimelineLabelAt',
    {args: ['u'], call: (p, a) => text(p.getPlayingTimelineLabelAt(n(a[0]!)))},
  ],
  [
    'getPlayingTimelineFlagsAt',
    {args: ['u'], call: (p, a) => p.getPlayingTimelineFlagsAt(n(a[0]!))},
  ],
  ['isLoopTimeline', {args: ['s'], call: (p, a) => p.isLoopTimeline(s(a[0]!))}],
  [
    'getTimelineTotalFrameCount',
    {args: ['s'], call: (p, a) => p.getTimelineTotalFrameCount(s(a[0]!))},
  ],
  ['playTimeline', {args: ['s', 'u'], call: (p, a) => p.playTimeline(s(a[0]!), n(a[1]!))}],
  ['isTimelinePlaying', {args: ['s'], call: (p, a) => p.isTimelinePlaying(s(a[0]!))}],
  ['stopTimeline', {args: ['s'], call: (p, a) => p.stopTimeline(s(a[0]!))}],
  [
    'setTimelineBlendRatio',
    {
      args: ['s', 'f', 'f', 'f', 'b'],
      call: (p, a) => p.setTimelineBlendRatio(s(a[0]!), n(a[1]!), n(a[2]!), n(a[3]!), b(a[4]!)),
    },
  ],
  ['getTimelineBlendRatio', {args: ['s'], call: (p, a) => p.getTimelineBlendRatio(s(a[0]!))}],
  [
    'fadeInTimeline',
    {args: ['s', 'f', 'f'], call: (p, a) => p.fadeInTimeline(s(a[0]!), n(a[1]!), n(a[2]!))},
  ],
  [
    'fadeOutTimeline',
    {args: ['s', 'f', 'f'], call: (p, a) => p.fadeOutTimeline(s(a[0]!), n(a[1]!), n(a[2]!))},
  ],
  ['isAnimating', {args: [], call: (p) => p.isAnimating()}],
  ['skip', {args: [], call: (p) => p.skip()}],
  ['pass', {args: [], call: (p) => p.pass()}],
  ['step', {args: [], call: (p) => p.step()}],
  ['progress', {args: ['f'], call: (p, a) => p.progress(n(a[0]!))}],
  ['isModified', {args: [], call: (p) => p.isModified()}],
  ['setStereovisionEnabled', {args: ['b'], call: (p, a) => p.setStereovisionEnabled(b(a[0]!))}],
  ['getStereovisionEnabled', {args: [], call: (p) => p.getStereovisionEnabled()}],
  ['isCharaProfileAvailable', {args: [], call: (p) => p.isCharaProfileAvailable()}],
  ['getCharaHeight', {args: [], call: (p) => p.getCharaHeight()}],
  ['countCharaProfiles', {args: [], call: (p) => p.countCharaProfiles()}],
  [
    'getCharaProfileLabelAt',
    {args: ['u'], call: (p, a) => text(p.getCharaProfileLabelAt(n(a[0]!)))},
  ],
  ['getCharaProfile', {args: ['s'], call: (p, a) => p.getCharaProfile(s(a[0]!))}],
  [
    'setOuterRot',
    {args: ['f', 'f', 'f'], call: (p, a) => p.setOuterRot(n(a[0]!), n(a[1]!), n(a[2]!))},
  ],
  ['getOuterRot', {args: [], call: (p) => p.getOuterRot()}],
  ['getSuitableClearColor', {args: [], call: (p) => p.getSuitableClearColor()}],
  ['setBlinkEnabled', {args: ['b'], call: (p, a) => p.setBlinkEnabled(b(a[0]!))}],
  ['getBlinkEnabled', {args: [], call: (p) => p.getBlinkEnabled()}],
]);

/** Bound IEmotePlayer names without a modeled implementation: reference counting and
 * cloning, state assignment, out-parameter getters, rendering, stereovision volume and
 * screen, API logs and core initialization. Calling one is refused. */
const unmodeled = [
  'addRef',
  'release',
  'refCount',
  'clone',
  'assignState',
  'getCoord',
  'getState',
  'getOuterForce',
  'render',
  'setStereovisionVolume',
  'getStereovisionVolume',
  'setStereovisionParallaxRatio',
  'getStereovisionParallaxRatio',
  'setStereovisionRenderScreen',
  'getStereovisionRenderScreen',
  'startRecordAPILog',
  'stopRecordAPILog',
  'isRecordingAPILog',
  'startReplayAPILog',
  'stopReplayAPILog',
  'isReplayingAPILog',
  'clearAPILog',
  'getAPILog',
  'setAPILog',
  'initCore',
];

function convert(kind: Argument, value: LuaValue | undefined): Converted | undefined {
  switch (kind) {
    case 'f':
      return typeof value === 'number' ? f32(value) : undefined;
    case 'u':
      return typeof value === 'number'
        ? Number(BigInt.asUintN(32, BigInt(nativeLong(value))))
        : undefined;
    case 's':
      return value instanceof Uint8Array ? luaText(nul(value)) : undefined;
    case 'b':
      return typeof value === 'boolean' ? value : undefined;
  }
}
/** cvttsd2si to 64 bits; out of range is the integer indefinite value. */
const nativeLong = (value: number) =>
  Number.isFinite(value) && Math.abs(value) < 2 ** 63 ? Math.trunc(value) : 0;
const nul = (value: Uint8Array) => {
  const end = value.indexOf(0);
  return end < 0 ? value : value.subarray(0, end);
};

/** Calls the IEmotePlayer method `name` with Lua arguments, as luabind's overload match:
 * a wrong argument count or type raises the Lua error. */
export function callArtemisEmotePlayer(
  player: EmotePlayer,
  name: string,
  args: readonly LuaValue[],
): LuaValue[] {
  const method = methods.get(name);
  if (!method) {
    if (unmodeled.includes(name)) throw new EmoteUnsupportedError(`IEmotePlayer:${name}`);
    throw Error(`IEmotePlayer has no method ${name}`);
  }
  if (args.length !== method.args.length)
    throw Error(`No matching overload found for IEmotePlayer:${name}`);
  const converted = method.args.map((kind, i) => {
    const value = convert(kind, args[i]);
    if (value === undefined) throw Error(`No matching overload found for IEmotePlayer:${name}`);
    return value;
  });
  const result = method.call(player, converted);
  return result === undefined ? [] : [result];
}

/** Every method name of the bound class. */
export const artemisEmotePlayerMethodNames: readonly string[] = [...methods.keys(), ...unmodeled];

/** Installs the Lua side of the IEmotePlayer class: each player is a `newproxy` userdata
 * whose methods forward to the host by handle. Collected proxies queue their handles, which
 * the next forwarded call releases. Returns the Lua prelude source that wraps `engine`; it
 * runs where `resourceFailure` is in scope. */
export function artemisEmoteLuaPrelude(): string {
  const names = artemisEmotePlayerMethodNames.map((name) => `'${name}'`).join(',');
  return `local emoteCreate = engine.artemisEmoteCreate
        local emoteGet = engine.artemisEmoteGet
        local emoteCall = engine.artemisEmoteCall
        local emoteRelease = engine.artemisEmoteRelease
        engine.artemisEmoteCreate = nil
        engine.artemisEmoteGet = nil
        engine.artemisEmoteCall = nil
        engine.artemisEmoteRelease = nil
        local emoteHandles = setmetatable({}, {__mode = 'k'})
        local emoteReleased = {}
        local function emoteFlush(self)
          if emoteReleased[1] ~= nil then
            local list = emoteReleased
            emoteReleased = {}
            emoteRelease(self, unpack(list))
          end
        end
        local emoteMethods = {}
        for _, name in ipairs({${names}}) do
          emoteMethods[name] = function(proxy, ...)
            local handle = emoteHandles[proxy]
            if handle == nil then error('IEmotePlayer method on a non-player value', 2) end
            emoteFlush(engine)
            return emoteCall(engine, handle, name, ...)
          end
        end
        local function emoteWrap(handle)
          if handle == nil then return nil end
          local proxy = newproxy(true)
          local meta = getmetatable(proxy)
          meta.__index = emoteMethods
          meta.__metatable = 'IEmotePlayer'
          meta.__gc = function() emoteReleased[#emoteReleased + 1] = handle end
          emoteHandles[proxy] = handle
          return proxy
        end
        engine.createEmoteLayer = function(self, args)
          emoteFlush(self)
          while true do
            local suspended, handle = emoteCreate(self, args)
            if not suspended then return emoteWrap(handle) end
            local ok, message = coroutine.yield()
            if ok == false then resourceFailure(self, message) end
          end
        end
        engine.getEmoteLayer = function(self, args)
          emoteFlush(self)
          return emoteWrap(emoteGet(self, args))
        end`;
}
