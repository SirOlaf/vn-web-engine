import {pop32} from '../bp/state.js';
import {AokanaBpScheduler} from '../bp/scheduler.js';
import {AokanaBitmapLoading} from './bitmap-loading.js';
import {AokanaLoadBitmapProcess, AokanaPreloadBitmapProcess, aokanaBitmapMessage} from './bitmap-load-process.js';
import {AokanaProcedureState} from './procedure.js';
import {AokanaNativeClock} from './clock.js';
import {textBytes} from './text.js';
import type {AokanaBpOpcodeContext, AokanaBpWaitProcess, AokanaNativeSlotDefinition} from './types.js';

/** Concrete loading/preloading wrappers; every process joins the existing BP scheduler. */
export function createAokanaBitmapLoadingSlots(
  loading: AokanaBitmapLoading, scheduler: AokanaBpScheduler,
  procedures: AokanaProcedureState, clock: AokanaNativeClock,
): AokanaNativeSlotDefinition[] {
  const resources = loading.resources.resources, text = resources.files.text;
  const fatal = (h: AokanaBpOpcodeContext, message: Uint8Array): Promise<never> =>
    resources.errors.threadFatal(h.thread, h.diagnostics, message);
  const install = (h: AokanaBpOpcodeContext, process: AokanaBpWaitProcess): void => {
    const scheduled = h.thread === scheduler.root.state ? scheduler.root : scheduler.findById(h.thread.id);
    if (scheduled === null || scheduled.state !== h.thread)
      throw new Error('Aokana bitmap loader thread is not linked to its scheduler');
    scheduled.installProcess(process);
  };
  return [
    {primary: 0x90, secondary: 0x10, nativeAddress: 0x1400dd9c0, name: 'LoadBitmap',
      execute: async (h): Promise<0 | 2> => {
        const namePointer = h.memory.resolve(h.thread, pop32(h.thread));
        const archivePointer = h.memory.resolve(h.thread, pop32(h.thread));
        const index = pop32(h.thread);
        if (index >= 0x4000)
          return fatal(h, text.encodeWide(`無効なビットマップ番号 [ ${index | 0} ] が指定されました`, 0));
        const archive = archivePointer === null ? null : textBytes(archivePointer).slice();
        if (namePointer === null) throw new Error('Aokana cached bitmap lookup dereferences a null filename');
        const name = textBytes(namePointer).slice();
        if (loading.fromCache(index, archive, name, 1) === 0) return 0;
        if (text.findCharacter(namePointer, 47) !== null || loading.policy.skipLoadWait() === 0) {
          const process = await AokanaLoadBitmapProcess.create(h, procedures, clock, loading.resources,
            loading.surfaces, index, archive, name);
          install(h, process);
          return 2;
        }
        const result = await loading.synchronous(index, archive, name);
        const templates: Record<number, string> = {
          0x80000002: '指定されたBMPファイル [ %s : %s ] はWindows用のデータではありません',
          0x80000003: '指定されたBMPファイル [ %s : %s ] はサポート外のプレーン数のデータです',
          0x80000004: '指定されたBG/BMPファイル [ %s : %s ] はサポート外のビットカウントのデータです',
          0x80000005: '指定されたBMPファイル [ %s : %s ] は圧縮されているので扱えません',
          0x80000006: '指定されたBMPファイル [ %s : %s ] は無効なサイズのデータです',
          0x80000008: '指定されたBG/BMPファイル [ %s : %s ] はメモリ不足のため読み込めません',
          0x80000019: '指定されたファイル [ %s : %s ] は存在しません',
        };
        if (templates[result] !== undefined) {
          const message = aokanaBitmapMessage(text, templates[result], [archive ?? new TextEncoder().encode('(null)'), name]);
          if (message.length > 256) throw new RangeError('Aokana bitmap diagnostic exceeds native scratch');
          return fatal(h, message);
        }
        return 0;
      }},
    {primary: 0x92, secondary: 0x14, nativeAddress: 0x1400e4970, name: 'PreloadBitmap',
      execute: async (h): Promise<2> => {
        const namePointer = h.memory.resolve(h.thread, pop32(h.thread));
        const archivePointer = h.memory.resolve(h.thread, pop32(h.thread));
        if (namePointer === null)
          return fatal(h, text.encodeWide('ファイル名へのポインタにNULLが指定されています', 0));
        const archive = archivePointer === null ? null : textBytes(archivePointer).slice();
        const name = textBytes(namePointer).slice();
        const process = await AokanaPreloadBitmapProcess.create(h, procedures, clock, loading.resources,
          loading.surfaces.compositor, archive, name);
        install(h, process);
        return 2;
      }},
    {primary: 0x92, secondary: 0x15, nativeAddress: 0x1400e4950, name: 'ClearPreloadedBitmaps',
      execute: (): 0 => { loading.resources.preloaded.clear(); return 0; }},
  ];
}
