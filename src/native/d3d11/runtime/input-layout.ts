import {dxgiVertexFormat} from '../../../graphics/dxgi-vertex.js';
import {parseDxbcContainer} from '../../../graphics/d3d11-shader/container.js';
import {
  parseSm4Signature,
  type Sm4SignatureParameter,
} from '../../../graphics/d3d11-shader/signature.js';
import type {D3d11InputElementDesc, D3d11Result, ID3D11InputLayout} from '../contract.js';
import {D3d11ChildObject, type D3d11DeviceOwner} from './com.js';

const INVALID = 0x80070057 | 0;
const NOT_IMPLEMENTED = 0x80004001 | 0;
const uint = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
export interface D3d11ResolvedInputElement extends D3d11InputElementDesc {
  /** Resolved APPEND offset, relative to the bound vertex's start. */
  readonly offset: number;
  /** Null for a declared element unused by this shader's input signature. */
  readonly register: number | null;
}

/** Device-owned layout metadata; native clients see only the inherited child interface. */
export class D3d11InputLayout extends D3d11ChildObject implements ID3D11InputLayout {
  constructor(
    owner: D3d11DeviceOwner,
    readonly elements: readonly D3d11ResolvedInputElement[],
    readonly signature: readonly Sm4SignatureParameter[],
  ) {
    super(owner, ['e4819ddc-4cf0-4025-bd26-5de82a3e07b7'], () => {});
  }
}

/** Float input signatures with R32G32_FLOAT, R32G32B32_FLOAT and B8G8R8A8_UNORM elements. */
export function createInputLayoutStorage(
  owner: D3d11DeviceOwner,
  elements: readonly D3d11InputElementDesc[],
  bytecode: Uint8Array,
  validateOnly = false,
): D3d11Result<D3d11InputLayout> {
  if (owner.lifetime.closed || elements.length > 32) return {hr: INVALID, value: null};
  let signature: readonly Sm4SignatureParameter[];
  try {
    const parts = parseDxbcContainer(bytecode).parts.filter((p) => p.kind === 'ISGN');
    if (parts.length !== 1) return {hr: INVALID, value: null};
    signature = parseSm4Signature(parts[0]!.data);
  } catch {
    return {hr: INVALID, value: null};
  }
  if (signature.some((p) => p.systemValue !== 0 || p.componentType !== 3 || p.register >= 32))
    return {hr: NOT_IMPLEMENTED, value: null};
  if (new Set(signature.map((p) => p.register)).size !== signature.length)
    return {hr: NOT_IMPLEMENTED, value: null};
  const nextOffset = Array<number>(32).fill(0),
    slotClasses = new Map<number, {inputSlotClass: number; instanceDataStepRate: number}>(),
    names = new Set<string>(),
    resolved: D3d11ResolvedInputElement[] = [];
  const semantic = (name: string, index: number) =>
    `${name.replace(/[a-z]/g, (c) => c.toUpperCase())}:${index}`;
  for (const element of elements) {
    if (
      typeof element.semanticName !== 'string' ||
      element.semanticName.length === 0 ||
      element.semanticName.length > 4096 ||
      element.semanticName.includes('\0') ||
      !uint(element.semanticIndex) ||
      !uint(element.inputSlot) ||
      element.inputSlot >= 32 ||
      !uint(element.alignedByteOffset) ||
      ![0, 1].includes(element.inputSlotClass) ||
      !uint(element.instanceDataStepRate) ||
      (element.inputSlotClass === 0 && element.instanceDataStepRate !== 0)
    )
      return {hr: INVALID, value: null};
    const name = semantic(element.semanticName, element.semanticIndex);
    if (names.has(name)) return {hr: INVALID, value: null};
    names.add(name);
    const slot = slotClasses.get(element.inputSlot);
    if (
      slot &&
      (slot.inputSlotClass !== element.inputSlotClass ||
        slot.instanceDataStepRate !== element.instanceDataStepRate)
    )
      return {hr: INVALID, value: null};
    slotClasses.set(element.inputSlot, element);
    const format = dxgiVertexFormat(element.format);
    if (!format) return {hr: NOT_IMPLEMENTED, value: null};
    const offset =
      element.alignedByteOffset === 0xffffffff
        ? Math.ceil(nextOffset[element.inputSlot]! / format.alignment) * format.alignment
        : element.alignedByteOffset;
    if (offset % format.alignment !== 0) return {hr: INVALID, value: null};
    if (offset + format.bytes > 2048) return {hr: NOT_IMPLEMENTED, value: null};
    nextOffset[element.inputSlot] = offset + format.bytes;
    const parameter = signature.find((p) => semantic(p.semanticName, p.semanticIndex) === name);
    resolved.push(Object.freeze({...element, offset, register: parameter?.register ?? null}));
  }
  if (signature.some((p) => !names.has(semantic(p.semanticName, p.semanticIndex))))
    return {hr: INVALID, value: null};
  if (validateOnly) return {hr: 1, value: null};
  const parameters = signature.map((p) => Object.freeze({...p}));
  Object.freeze(parameters);
  Object.freeze(resolved);
  return {hr: 0, value: new D3d11InputLayout(owner, resolved, parameters)};
}
