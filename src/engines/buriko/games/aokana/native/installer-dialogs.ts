import type {WindowsInstallerDialogHost} from '../../../../../platform/windows-installer-dialogs.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import {pointerView} from '../bp/memory.js';
import {AokanaDirectoryTree} from './directory-tree.js';
import type {AokanaEngineDialogs} from './engine-dialogs.js';
import type {AokanaFolderSelectionService} from './folder-selection.js';
import type {AokanaNativeLanguage} from './group-81-language.js';
import type {AokanaProgramFiles} from './program-files.js';
import {writeText} from './text.js';

/** C7A60/C79F0 and their two dialog callbacks over one selected modal host. */
export class AokanaInstallerDialogs {
  constructor(
    readonly host: WindowsInstallerDialogHost,
    readonly dialogs: AokanaEngineDialogs,
    readonly folderSelection: AokanaFolderSelectionService | null,
    readonly files: AokanaProgramFiles,
    readonly language: AokanaNativeLanguage,
  ) {}

  private decode(bytes: Uint8Array | null): string | null {
    return bytes === null ? null : this.files.text.decodeAuto({bytes, offset: 0});
  }

  private async browse(): Promise<string | null> {
    if (this.folderSelection === null) return null;
    const output = new Uint8Array(784);
    if ((await this.folderSelection.select({bytes: output, offset: 0}, null, null)) === 0)
      return null;
    return this.files.text.decodeAuto({bytes: output, offset: 0});
  }

  /** CAE90 accepts the modal result after warning on an invalid path. */
  private async checkDestination(path: string, suffix: string | null): Promise<string> {
    let value = path;
    const drive = /^[a-z]:\\/i.exec(value),
      type = drive === null ? 0 : this.files.media.driveTypes[drive[0]!.toLowerCase().charCodeAt(0) - 97];
    const legal =
      drive !== null &&
      new TextEncoder().encode(value).length < 701 &&
      !value.slice(3).includes('\\\\') &&
      !value.slice(3).includes(':');
    if (!legal) {
      await this.dialogs.show(this.files.text.encodeWide('An illegal path was selected.', 1), null, 0x30);
      return value;
    }
    if (type !== 3) {
      await this.dialogs.show(this.files.text.encodeWide('Please choose a stationary harddrive.', 1), null, 0x30);
      return value;
    }
    if (value.endsWith('\\') && value.length > 3) value = value.slice(0, -1);
    if (value.length === 3 && suffix !== null) value += suffix;
    const tree = new AokanaDirectoryTree(this.files);
    try {
      if ((await tree.ensure(this.files.text.encodeWide(value, 1))) === 0)
        await this.dialogs.show(this.files.text.encodeWide('An illegal path was selected.', 1), null, 0x30);
      await tree.removeCreatedDirectories();
    } finally {
      tree.dispose();
    }
    return value;
  }

  async chooseDestination(
    outputPath: AokanaBpPointer | null,
    outputA: AokanaBpPointer | null,
    outputB: AokanaBpPointer | null,
    initialPath: Uint8Array,
    initialA: number,
    initialB: number,
    rootSuffix: Uint8Array | null,
    description: Uint8Array | null,
  ): Promise<number> {
    const editable = outputPath !== null,
      japanese = (this.language.value & 0x3ff) === 0x11,
      request = {
        template: japanese ? 0x6c : 0x7a,
        path: this.decode(initialPath)!,
        pathEditable: editable,
        optionA: initialA >>> 0,
        optionB: initialB >>> 0,
        optionALabel: japanese
          ? 'プログラムフォルダにショートカットを作成する'
          : 'Add shortcut to start menu',
        optionBLabel: japanese
          ? 'デスクトップにショートカットを作成する'
          : 'Add shortcut to desktop',
        description: this.decode(description),
        browseFolder: () => this.browse(),
      };
    const selected = await this.dialogs.withNativeModal(() => this.host.chooseDestination(request));
    if (selected.result === 0) return 0;
    if (outputA === null || outputB === null)
      throw new Error('Aokana installer dialog dereferences a null option output');
    if (editable) {
      // GetDlgItemTextW(..., 0x30c) retains at most 779 UTF-16 code units.
      const path = await this.checkDestination(selected.path.slice(0, 779), this.decode(rootSuffix));
      writeText(outputPath, this.files.text.encodeWide(path, 1));
    }
    pointerView(outputA, 4).setUint32(0, selected.optionA >>> 0, true);
    pointerView(outputB, 4).setUint32(0, selected.optionB >>> 0, true);
    return selected.result >>> 0;
  }

  async chooseComponent(
    description: Uint8Array,
    first: Uint8Array | null,
    second: Uint8Array,
    third: Uint8Array,
    showSpecial: number,
    disabledChoice: number,
  ): Promise<number> {
    return this.dialogs.withNativeModal(() => this.host.chooseComponent({
      template: first === null ? 0x6d : 0x6e,
      description: this.decode(description)!,
      choices: [this.decode(first), this.decode(second)!, this.decode(third)!],
      disabledChoice: disabledChoice | 0,
      defaultChoice: disabledChoice === 2 ? 1 : 2,
      showSpecialButton: showSpecial !== 0,
    }));
  }
}
