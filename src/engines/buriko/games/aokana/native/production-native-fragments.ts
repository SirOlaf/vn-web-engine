import type {AokanaProductionDataOwners} from './production-data-owners.js';
import type {AokanaProductionDisplayResourceGraph} from './production-display-resource-graph.js';
import type {AokanaBpScheduler} from '../bp/scheduler.js';
import type {AokanaInstallationService} from './installation.js';
import {createAokanaCdSlots} from './cd-audio.js';
import {createGroup7f} from './group-7f.js';
import {createGroup80ComplexArchives} from './group-80-complex-archives.js';
import {createGroupCpu} from './group-cpu.js';
import {createGroupSystemProfile} from './group-system-profile.js';
import {createGroup80CursorShapes} from './group-80-cursor-shapes.js';
import {createGroup80CursorMotion, AokanaBrowserCursorPosition} from './cursor-motion.js';
import {createGroup80Display} from './group-80-display.js';
import {createGroup80DisplayToggle} from './group-80-display-toggle.js';
import {createGroup80DisplayService} from './group-80-display-service.js';
import {createGroup80DroppedFiles} from './group-80-dropped-files.js';
import {createGroup80ExternalMutexName} from './group-80-external-mutex-name.js';
import {createGroup80ExternalLibraries} from './group-80-external-libraries.js';
import {
  createGroup80ExternalLaunch,
  createGroup80ShellExecute,
} from './group-80-external-launch.js';
import {createGroup80Enumeration} from './group-80-enumeration.js';
import {createGroup80FileChecksum} from './group-80-file-checksum.js';
import {createGroup80FileAssociations} from './group-80-file-associations.js';
import {createGroup80FileSelection} from './group-80-file-selection.js';
import {createGroup80FilePresence} from './group-80-file-presence.js';
import {createGroup80InstallerManifest} from './group-80-installer-manifest.js';
import {createGroup80InstallerShortcut} from './group-80-installer-shortcut.js';
import {createGroup80InstallerDialogs} from './group-80-installer-dialogs.js';
import {createGroup80Installation} from './group-80-installation.js';
import {AokanaInstallerModal} from './installer-modal.js';
import {createGroup80InstallerShortcutTransaction} from './group-80-installer-shortcut-transaction.js';
import {AokanaInstallerShortcutTransaction} from './installer-shortcut-transaction.js';
import {createGroup80InstallerQueries} from './group-80-installer-queries.js';
import {createGroup80InstallerShortcutCleanup} from './group-80-installer-shortcut-cleanup.js';
import {createGroup80MainClose} from './group-80-main-close.js';
import {createGroup80MainShow, createGroup80MainMinimize} from './group-80-main-show.js';
import {createGroup80Metrics} from './group-80-metrics.js';
import {createGroup80Move} from './group-80-move.js';
import {createGroup80Notifications} from './group-80-notifications.js';
import {createGroup80Paths} from './group-80-paths.js';
import {createGroup80Copy} from './group-80-copy.js';
import {createGroup80ResourceFiles} from './group-80-resource-files.js';
import {createGroup80ResourceRead} from './group-80-resource-read.js';
import {createGroup80ResourceSettings} from './group-80-resource-settings.js';
import {createGroup80SecondaryMedia} from './group-80-secondary-media.js';
import {createGroup80WindowTitle} from './group-80-window-title.js';
import {createGroup81ArchiveNames} from './group-81-archive-names.js';
import {createGroup81ArchiveRelease} from './group-81-archive-release.js';
import {createGroup81ArchiveSelection} from './group-81-archive-selection.js';
import {createGroup81Clock, createGroup81Random} from './group-81-clock.js';
import {createGroup81Device} from './group-81-device.js';
import {createGroup81DevicePower} from './group-81-device-power.js';
import {createGroup81Display} from './group-81-display.js';
import {createGroup81ErrorCapture} from './group-81-error-capture.js';
import {createGroup81ExternalProcess} from './group-81-external-process.js';
import {createGroup81FileTimestamps} from './group-81-file-timestamps.js';
import {createGroup81Files} from './group-81-files.js';
import {createGroup81FileSelection} from './group-81-file-selection.js';
import {createGroup81FolderSelection} from './group-81-folder-selection.js';
import {createGroup81Gamepads} from './group-81-gamepads.js';
import {createGroup81Hotkeys} from './group-81-hotkeys.js';
import {createGroup81ImportedText} from './group-81-imported-text.js';
import {createGroup81Installation} from './group-81-installation.js';
import {createGroup81Language, group81Constant} from './group-81-language.js';
import {createGroup81NamedMutexes} from './group-81-named-mutexes.js';
import {createGroup81StoredResourceSize} from './group-81-stored-resource-size.js';
import {createGroup81SyntheticMouse} from './group-81-synthetic-mouse.js';
import {createGroup81Text} from './group-81-text.js';
import {createGroup81Touch} from './group-81-touch.js';
import {createGroup81TemporaryDirectory} from './group-81-temporary-directory.js';
import {createGroup81Drives} from './group-81-drives.js';
import {createGroup81DriveFileRead} from './group-81-drive-file-read.js';
import {createGroup81DiskFreeSpace} from './group-81-disk-free-space.js';
import {createGroup81VolumeLabels} from './group-81-volume-labels.js';
import {createGroupA0AudioMasters} from './group-a0-audio-masters.js';
import {createGroupA0AudioStatusRelease} from './group-a0-audio-status-release.js';
import {createGroupA0AudioControls} from './group-a0-audio-controls.js';
import {createGroupA0PlaySound} from './play-sound.js';
import {createGroupB0Properties} from './group-b0-properties.js';
import {createGroupB0Children} from './group-b0-children.js';
import {
  createGroupB0Blit,
  createGroupB0CursorPolicy,
  createGroupB0Geometry,
} from './group-b0-main.js';
import {createGroup90DisplayDefault} from './group-90-display-default.js';
import {createGroupB0Wallpaper} from './wallpaper.js';
import {
  createGroupB0FormDialogs,
  createGroupB0ModalDialogs,
  createGroupB0ModelessSettings,
} from './group-b0-dialogs.js';
import {createGroupE0ObjectProperties} from './group-e0-object-properties.js';
import {createGroup92ObjectPicker} from './group-92-object-picker.js';
import {createGroupE0ObjectList} from './group-e0-object-list.js';
import {createGroupE0InputCaptures} from './group-e0-input-captures.js';
import {createGroupE0Modules} from './group-e0-modules.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from './inventory.js';
import type {AokanaNativeSlotDefinition} from './types.js';

/** Device rebuild and adjusted desktop mode enter after successful display startup. */
const boundDeviceSecondaries = new Set([0x0b, 0x66, 0x6d, 0x6f]);
/** Child presentation and font drawing share the selected browser canvas/font owners. */
const boundChildState = new Set([0x10, 0x11, 0x12, 0x14, 0x15, 0x16, 0x17, 0x1c, 0x1e, 0x1f]);
/** Reconfiguration enters after successful display startup. */
const boundDisplayService = new Set([0x61, 0x63, 0x6f]);

/** Real same-owner definitions below the complete 840-slot native bank. */
export class AokanaProductionNativeFragments {
  constructor(
    readonly graph: AokanaProductionDisplayResourceGraph,
    readonly data: AokanaProductionDataOwners,
    readonly scheduler: AokanaBpScheduler | null = null,
    readonly installation: AokanaInstallationService | null = null,
  ) {
    if (data.graph !== graph)
      throw new Error('Aokana native fragments require the same production graph');
    if (
      (graph.touchWindow === null) !== (graph.touch === null) ||
      (graph.touch !== null &&
        (graph.touch.input !== graph.input ||
          graph.touch.window !== graph.touchWindow ||
          graph.receiver.touch !== graph.touch ||
          graph.domInput.touch?.touch !== graph.touch))
    )
      throw new Error('Aokana touch fragments require the selected main-window ingress');
    if (
      (graph.cdMediaHost === null) !== (graph.cdAudio === null) ||
      (graph.cdAudio !== null && graph.receiver.cdAudio !== graph.cdAudio)
    )
      throw new Error('Aokana CD fragments require the selected medium and main receiver');
    if (
      graph.fileAssociations.host !== graph.fileAssociationHost ||
      graph.fileAssociations.text !== graph.text
    )
      throw new Error(
        'Aokana file-association fragments require the graph platform and text owners',
      );
    if (
      (graph.shellShortcutHost === null) !== (graph.shellShortcuts === null) ||
      (graph.shellShortcuts !== null &&
        (graph.shellShortcuts.host !== graph.shellShortcutHost ||
          graph.shellShortcuts.files !== graph.resource.files ||
          graph.shellShortcuts.folders !== graph.folders))
    )
      throw new Error('Aokana installer-shortcut fragments require selected graph shell owners');
    if (
      (graph.externalProcessHost === null) !== (graph.externalProcesses === null) ||
      (graph.externalProcesses !== null &&
        (graph.externalProcesses.mutexName !== graph.externalMutexName ||
          graph.externalProcesses.shellHost !== graph.shellExecuteHost)) ||
      (graph.logicalDriveHost === null) !== (graph.secondaryMedia === null) ||
      (graph.secondaryMedia !== null &&
        (graph.secondaryMedia.resources !== graph.resource.resources ||
          graph.secondaryMedia.localized !== graph.localized ||
          graph.secondaryMedia.drives !== graph.logicalDriveHost))
    )
      throw new Error('Aokana process and media fragments require the selected graph hosts');
    if (
      (graph.dynamicLibraryHost === null) !== (graph.externalLibraries === null) ||
      (graph.externalLibraries !== null &&
        (graph.externalLibraries.resources !== graph.resource.resources ||
          graph.externalLibraries.host !== graph.dynamicLibraryHost ||
          graph.externalLibraries.windowIdentity !== graph.host))
    )
      throw new Error('Aokana DLL fragments require the selected graph host and resources');
    if (
      (graph.desktopWallpaperHost === null) !== (graph.wallpaper === null) ||
      (graph.wallpaper !== null &&
        (graph.wallpaper.desktop !== graph.desktopWallpaperHost ||
          graph.wallpaper.registry !== graph.registry ||
          graph.wallpaper.text !== graph.text))
    )
      throw new Error('Aokana wallpaper fragments require the selected desktop and registry');
    if ((scheduler === null) !== (installation === null))
      throw new Error('Aokana installer fragments require scheduler and service together');
    if (
      installation !== null &&
      (installation.resources !== graph.resource.resources ||
        installation.loading !== graph.resource.loading ||
        installation.procedures !== data.procedureState ||
        installation.clock !== graph.clock ||
        installation.notifications !== graph.notifications ||
        installation.localized !== graph.localized ||
        installation.registry !== graph.registry)
    )
      throw new Error('Aokana installer fragments require the shared VM and graph owners');
    if (
      (graph.systemProfileHost === null) !== (graph.systemProfile === null) ||
      (graph.systemProfile !== null && graph.systemProfile.host !== graph.systemProfileHost)
    )
      throw new Error('Aokana system-profile fragments require the selected host owner');
    if (
      (graph.devicePowerHost === null) !== (graph.devicePower === null) ||
      (graph.devicePower !== null &&
        (graph.devicePower.host !== graph.devicePowerHost ||
          graph.devicePower.system !== graph.systemProfile ||
          graph.devicePower.files !== graph.resource.files))
    )
      throw new Error(
        'Aokana device-power fragments require selected graph system and file owners',
      );
    if (
      (graph.gamepadHost === null) !== (graph.gamepads === null) ||
      (graph.gamepads !== null &&
        (graph.gamepads.host !== graph.gamepadHost ||
          graph.gamepads.input !== graph.input ||
          graph.gamepads.notifications !== graph.notifications))
    )
      throw new Error('Aokana gamepad fragments require selected graph input and queue owners');
    if (
      (graph.namedMutexHost === null) !== (graph.namedMutexes === null) ||
      (graph.namedMutexes !== null && graph.namedMutexes.host !== graph.namedMutexHost)
    )
      throw new Error('Aokana named-mutex fragments require the selected host owner');
    if (graph.installerManifest.resources !== graph.resource.resources)
      throw new Error('Aokana installer fragments require the graph resource owner');
    if (
      graph.installerQueries.registry !== graph.registry ||
      graph.installerQueries.folders !== graph.folders ||
      graph.installerQueries.files !== graph.resource.files
    )
      throw new Error(
        'Aokana installer queries require the graph registry, folder and file owners',
      );
    if (
      graph.installerShortcutCleanup.folders !== graph.folders ||
      graph.installerShortcutCleanup.files !== graph.resource.files ||
      graph.installerShortcutCleanup.metadata !== graph.resource.files.metadata ||
      graph.resource.files.specialFolders !== graph.folders ||
      graph.folders.text !== graph.text
    )
      throw new Error('Aokana shortcut cleanup requires the graph folder, text and file owners');
    if (graph.frames.metrics.clock !== graph.clock || graph.frames.metrics.raster !== graph.device)
      throw new Error('Aokana metric fragments require the graph frame clock and device');
    if (
      graph.controller.manager !== graph.manager ||
      graph.controller.cpu.host !== graph.cpuHost ||
      graph.controller.cpu.clock !== graph.clock ||
      graph.controller.device !== graph.device ||
      graph.manager.displayState !== graph.display ||
      graph.device.canvas !== graph.host.surface ||
      graph.controller.host !== graph.host ||
      graph.cursorPolicy.manager !== graph.manager ||
      graph.cursorPolicy.input !== graph.input ||
      graph.cursorPolicy.clock !== graph.clock ||
      graph.cursorPolicy.physical !== graph.cursor ||
      !(graph.cursorPosition instanceof AokanaBrowserCursorPosition) ||
      graph.cursorMotion.input !== graph.input ||
      graph.cursorMotion.clock !== graph.clock ||
      graph.cursorMotion.platform !== graph.cursorPosition ||
      graph.cursorFrame.motion !== graph.cursorMotion ||
      graph.cursorFrame.policy !== graph.cursorPolicy ||
      graph.controller.messages !== graph.messages ||
      graph.controller.notifications !== graph.notifications ||
      graph.receiver.controller !== graph.controller ||
      graph.receiver.messages !== graph.messages ||
      graph.receiver.input !== graph.input ||
      graph.receiver.notifications !== graph.notifications ||
      graph.resource.errors.files !== graph.resource.files ||
      graph.resource.errors.dialogs !== graph.dialogs ||
      graph.properties.text !== graph.text ||
      graph.properties.messages !== graph.messages ||
      graph.properties.document !== graph.host.document ||
      graph.properties.parent !== graph.host.parent ||
      graph.dialogs.fallbackTitle !== graph.title.bytes ||
      graph.properties.nativeWindowTitle !== graph.title.bytes
    )
      throw new Error('Aokana display-toggle fragments require shared controller and error owners');
    if (
      graph.syntheticMouse.input !== graph.input ||
      graph.syntheticMouse.messages !== graph.messages ||
      graph.messages.input !== graph.input ||
      graph.receiver.messages !== graph.messages ||
      graph.receiver.waits !== graph.waits ||
      graph.receiver.input !== graph.input ||
      graph.receiver.notifications !== graph.notifications
    )
      throw new Error('Aokana synthetic mouse fragments require the main input/message owners');
    if (
      graph.keyboard.messages !== graph.messages ||
      graph.focusedHotkeyRegistration.keyboard !== graph.keyboard ||
      graph.keyboard.hotkeys !== graph.focusedHotkeyRegistration ||
      graph.printScreenHotkeys.messages !== graph.messages ||
      graph.printScreenHotkeys.registration !== graph.focusedHotkeyRegistration
    )
      throw new Error('Aokana hotkey fragments require the main keyboard/message owners');
    if (
      graph.resourceFileServices.resources !== graph.resource.resources ||
      graph.resourceFilePresence.resources !== graph.resource.resources ||
      graph.resourceFilePresence.messages !== graph.localized ||
      graph.fileChecksum.resources !== graph.resource.resources ||
      graph.fileEnumeration.files !== graph.resource.files ||
      graph.fileEnumeration.metadata !== graph.resource.files.metadata ||
      graph.resource.resources.files !== graph.resource.files ||
      graph.resource.resources.dialogs !== graph.dialogs ||
      graph.resource.resources.errors !== graph.resource.errors ||
      graph.selectionDialog.dialogs !== graph.dialogs ||
      graph.selectionDialog.text !== graph.text ||
      graph.resource.files.metadata === null
    )
      throw new Error('Aokana file fragments require the graph resource and metadata owners');
    if (
      (graph.pickerHost === null) !== (graph.fileSelection === null) ||
      (graph.pickerHost === null) !== (graph.folderSelection === null) ||
      (graph.fileSelection !== null &&
        (graph.fileSelection.host !== graph.pickerHost ||
          graph.fileSelection.dialogs !== graph.dialogs ||
          graph.fileSelection.clock !== graph.clock ||
          graph.fileSelection.mainWindowIdentity !== graph.host)) ||
      (graph.folderSelection !== null &&
        (graph.folderSelection.host !== graph.pickerHost ||
          graph.folderSelection.localized !== graph.localized ||
          graph.folderSelection.mainWindowIdentity !== graph.host))
    )
      throw new Error('Aokana picker fragments require the selected host and graph owners');
    if (
      !graph.dialogs.usesOwners(
        graph.diagnosticDialogs,
        graph.text,
        graph.clock,
        graph.input,
        graph.cursor,
        graph.device,
        graph.display,
      ) ||
      graph.selectionDialog.dialogs !== graph.dialogs ||
      graph.selectionDialog.text !== graph.text ||
      graph.dialogs.fallbackTitle !== graph.title.bytes
    )
      throw new Error('Aokana modal fragments require the graph dialog, text and title owners');
    if (
      graph.ansiUi.text !== graph.text ||
      graph.ansiDialogs.document !== graph.host.document ||
      graph.ansiDialogs.parent !== graph.host.parent ||
      graph.ansiDialogs.dialogs !== graph.dialogs ||
      graph.ansiDialogs.ansi !== graph.ansiUi ||
      graph.ansiDialogs.language !== graph.localized.language ||
      graph.productKeyDialog.document !== graph.host.document ||
      graph.productKeyDialog.parent !== graph.host.parent ||
      graph.productKeyDialog.dialogs !== graph.dialogs ||
      graph.productKeyDialog.text !== graph.text ||
      graph.modelessSettings.document !== graph.host.document ||
      graph.modelessSettings.parent !== graph.host.parent ||
      graph.modelessSettings.dialogs !== graph.dialogs
    )
      throw new Error(
        'Aokana form fragments require the graph DOM, dialog, text and language owners',
      );
    if (
      graph.engineCaption !== null &&
      (graph.engineCaption === graph.title.bytes ||
        graph.engineCaption.indexOf(0) < 0 ||
        graph.input.display !== graph.display ||
        !graph.input.usesClock(graph.clock) ||
        graph.selectionDialog.dialogs !== graph.dialogs ||
        graph.selectionDialog.text !== graph.text)
    )
      throw new Error('Aokana E0 diagnostics require the selected engine caption and input owners');
    if (
      graph.resource.temporaryDirectoryProbe !== null &&
      graph.resource.temporaryDirectoryProbe.files !== graph.resource.files
    )
      throw new Error('Aokana temporary-directory probe requires the graph file owner');
    if (
      graph.resource.files.media !== graph.resource.media ||
      (graph.resource.driveHost === null) !== (graph.resource.volumeLabels === null) ||
      (graph.resource.volumeLabels !== null &&
        graph.resource.volumeLabels.host !== graph.resource.driveHost)
    )
      throw new Error('Aokana drive fragments require the shared file, media and host owners');
    if (graph.localized.text !== graph.text || graph.localized.importedMessages.text !== graph.text)
      throw new Error('Aokana imported-text fragments require the graph text owner');
    if (
      graph.pathDirectory.files !== graph.resource.files ||
      graph.pathDirectory.metadata !== graph.resource.files.metadata ||
      graph.resource.files.text !== graph.text
    )
      throw new Error('Aokana path fragments require the graph mounted files and text owners');
    if (
      graph.folders.text !== graph.text ||
      graph.folders.registry !== graph.registry ||
      graph.folders.roots !== graph.resource.resources.configuration ||
      graph.resource.files.specialFolders !== graph.folders ||
      graph.controller.mouseTrails.registry !== graph.registry
    )
      throw new Error(
        'Aokana settings fragments require shared resource, text and registry owners',
      );
    if (
      graph.children.document !== graph.host.document ||
      graph.children.parent !== graph.host.childWindowParent ||
      graph.children.desktopCanvas !== graph.host.surface ||
      graph.children.text !== graph.text ||
      graph.children.surfaces !== graph.surfaces ||
      graph.children.compositor !== graph.compositor ||
      graph.children.bitmapText.fonts !== graph.fonts ||
      graph.children.bitmapText.compositor !== graph.compositor ||
      graph.children.dialogs !== graph.dialogs ||
      graph.children.messages !== graph.messages ||
      graph.children.keyboard !== graph.keyboard ||
      graph.children.nativeWindowTitle !== graph.title.bytes
    )
      throw new Error('Aokana child fragments require the graph window and bitmap owners');
    if (
      graph.resource.channels.locks !== graph.manager.locks ||
      graph.resource.channels.actors !== graph.allocator ||
      graph.resource.channels.ticks !== graph.ticks ||
      graph.resource.errors.files !== graph.resource.files
    )
      throw new Error('Aokana audio fragments require the graph channel, lock and actor owners');
  }

  nativeDefinitions(): AokanaNativeSlotDefinition[] {
    const definitions = [
      ...this.data.nativeDefinitions(),
      ...createGroupCpu(this.graph.controller.cpu),
      ...(this.graph.systemProfile === null
        ? []
        : createGroupSystemProfile(this.graph.systemProfile)),
      ...createGroup7f(this.graph.text),
      ...createGroup80Metrics(this.graph.frames.metrics),
      ...createGroup80Display(this.graph.manager),
      ...createGroup80DisplayToggle(this.graph.controller, this.graph.resource.errors),
      ...createGroup80DisplayService(this.graph.controller, this.graph.resource.errors).filter(
        ({secondary}) =>
          boundDisplayService.has(secondary) ||
          (this.graph.displayReadyForScriptGeometry && (secondary === 0x60 || secondary === 0x6e)),
      ),
      ...createGroup80CursorShapes(this.graph.cursorShapes, this.graph.resource.errors),
      ...createGroup80CursorMotion(this.graph.cursorMotion),
      ...createGroup80MainClose(this.graph.host),
      ...createGroup80MainShow(this.graph.showState),
      ...(this.graph.windowTransitions === null
        ? []
        : createGroup80MainMinimize(this.graph.showState, this.graph.windowTransitions)),
      ...createGroup80DroppedFiles(this.graph.droppedFiles),
      ...createGroup80Notifications(this.graph.notifications),
      ...createGroup80Move(this.graph.resource.files),
      ...createGroup80Copy(this.graph.resource.files),
      ...createGroup80Paths(this.graph.pathDirectory),
      ...createGroup80ResourceRead(this.graph.resource.resources),
      ...createGroup80ResourceSettings(this.graph.resource.resources, this.graph.folders),
      ...(this.graph.secondaryMedia === null
        ? []
        : createGroup80SecondaryMedia(this.graph.secondaryMedia)),
      ...createGroup80WindowTitle(
        this.graph.title,
        this.graph.text,
        this.graph.host,
        this.graph.dialogs,
        this.graph.children,
        this.graph.properties,
      ),
      ...createGroup80FileChecksum(this.graph.fileChecksum),
      ...createGroup80FileAssociations(this.graph.fileAssociations),
      ...(this.graph.fileSelection === null
        ? []
        : createGroup80FileSelection(this.graph.fileSelection)),
      ...(!this.graph.fileEnumeration.available
        ? []
        : createGroup80Enumeration(this.graph.fileEnumeration)),
      ...createGroup80FilePresence(this.graph.resourceFilePresence),
      ...createGroup80ResourceFiles(this.graph.resourceFileServices),
      ...createGroup80ComplexArchives(this.graph.resource.resources.archives),
      ...createGroup80ExternalMutexName(this.graph.externalMutexName),
      ...(this.graph.externalLibraries === null
        ? []
        : createGroup80ExternalLibraries(this.graph.externalLibraries)),
      ...(this.graph.externalProcesses === null
        ? []
        : createGroup80ExternalLaunch(this.graph.externalProcesses)),
      ...(this.graph.shellExecuteHost === null
        ? []
        : createGroup80ShellExecute(this.graph.externalProcesses!)),
      ...createGroup80InstallerManifest(this.graph.installerManifest),
      ...(this.graph.shellShortcuts === null
        ? []
        : createGroup80InstallerShortcut(this.graph.shellShortcuts)),
      ...createGroup80InstallerDialogs(this.graph.installerDialogs),
      ...(this.installation === null
        ? []
        : createGroup80Installation(
            new AokanaInstallerModal(
              this.installation,
              this.graph.installerDialogHost,
              this.graph.taskbarProgressHost,
              this.graph.dialogs,
              this.graph.host,
            ),
          )),
      ...(this.graph.shellShortcuts === null
        ? []
        : createGroup80InstallerShortcutTransaction(
            new AokanaInstallerShortcutTransaction(this.graph.shellShortcuts),
          )),
      ...createGroup80InstallerQueries(this.graph.installerQueries),
      ...createGroup80InstallerShortcutCleanup(this.graph.installerShortcutCleanup),
      ...createGroup81Clock(this.graph.clock),
      ...(this.graph.cryptoRandom === null ? [] : createGroup81Random(this.graph.cryptoRandom)),
      ...(this.graph.namedMutexes === null
        ? []
        : createGroup81NamedMutexes(this.graph.namedMutexes)),
      ...createGroup81Device(this.graph.controller).filter(
        (definition) =>
          boundDeviceSecondaries.has(definition.secondary) ||
          (this.graph.displayReadyForScriptGeometry &&
            (definition.secondary === 0x0e || definition.secondary === 0x64)),
      ),
      ...(this.graph.devicePower === null ? [] : createGroup81DevicePower(this.graph.devicePower)),
      ...(this.graph.gamepads === null ? [] : createGroup81Gamepads(this.graph.gamepads)),
      ...createGroup81Display(this.graph.display),
      ...createGroup81ErrorCapture(this.graph.resource.errors),
      ...(this.graph.externalProcesses === null
        ? []
        : createGroup81ExternalProcess(this.graph.externalProcesses)),
      ...createGroup81ArchiveNames(this.graph.resource.resources),
      ...createGroup81ArchiveRelease(this.graph.resource.resources),
      ...createGroup81ArchiveSelection(this.graph.resource.resources, this.graph.selectionDialog),
      ...createGroup81StoredResourceSize(this.graph.resource.loading.ranges),
      ...createGroup81SyntheticMouse(this.graph.syntheticMouse),
      ...createGroup81FileTimestamps(this.graph.resource.files),
      ...createGroup81Files(this.graph.resource.scripts),
      ...(this.graph.fileSelection === null
        ? []
        : createGroup81FileSelection(this.graph.fileSelection)),
      ...(this.graph.folderSelection === null
        ? []
        : createGroup81FolderSelection(this.graph.folderSelection)),
      ...createGroup81Hotkeys(this.graph.printScreenHotkeys),
      ...createGroup81Text(this.graph.text),
      ...(this.graph.touch === null ? [] : createGroup81Touch(this.graph.touch)),
      ...(this.graph.resource.temporaryDirectoryProbe === null
        ? []
        : createGroup81TemporaryDirectory(this.graph.resource.temporaryDirectoryProbe)),
      ...(this.graph.resource.driveHost === null
        ? []
        : [
            ...createGroup81Drives(this.graph.resource.media, this.graph.resource.driveHost),
            ...createGroup81DiskFreeSpace(this.graph.resource.files, this.graph.resource.driveHost),
            ...createGroup81VolumeLabels(this.graph.resource.volumeLabels!),
          ]),
      ...(this.graph.resource.driveGeometryHost === null
        ? []
        : createGroup81DriveFileRead(
            this.graph.resource.files,
            this.graph.resource.driveGeometryHost,
          )),
      ...createGroup81Language(this.graph.localized.language),
      ...createGroup81ImportedText(this.graph.localized.importedMessages),
      ...(this.installation === null
        ? []
        : createGroup81Installation(this.installation, this.scheduler!)),
      ...createGroup90DisplayDefault(this.graph.manager, this.graph.resource.errors),
      ...createGroupA0AudioMasters(this.graph.resource.channels, this.graph.resource.errors),
      ...createGroupA0PlaySound(this.graph.playSound),
      ...createGroupA0AudioStatusRelease(this.graph.resource.channels, this.graph.resource.errors),
      ...createGroupA0AudioControls(this.graph.resource.channels, this.graph.resource.errors),
      ...(this.graph.cdAudio === null ? [] : createAokanaCdSlots(this.graph.cdAudio)),
      ...createGroupB0Properties(this.graph.properties),
      ...createGroupB0ModalDialogs(this.graph.dialogs, this.graph.selectionDialog),
      ...createGroupB0FormDialogs(this.graph.ansiDialogs, this.graph.productKeyDialog),
      ...createGroupB0ModelessSettings(this.graph.modelessSettings),
      ...createGroupB0Children(this.graph.children, this.graph.resource.errors).filter(
        ({secondary}) =>
          boundChildState.has(secondary) ||
          (this.graph.fontProvider !== null &&
            (secondary === 0x18 || secondary === 0x19 || secondary === 0x1a || secondary === 0x1b)),
      ),
      ...createGroupB0CursorPolicy(this.graph.cursorPolicy, this.graph.resource.errors),
      ...createGroupB0Blit(this.graph.host, this.graph.resource.errors),
      ...(this.graph.displayReadyForScriptGeometry ? createGroupB0Geometry(this.graph.host) : []),
      ...(this.graph.wallpaper === null ? [] : createGroupB0Wallpaper(this.graph.wallpaper)),
      ...createGroupE0ObjectProperties(this.graph.properties, this.graph.manager),
      ...(this.graph.touch !== null && this.graph.objectRendererReady
        ? createGroup92ObjectPicker(
            this.graph.manager,
            this.graph.input,
            this.graph.cursorPolicy,
            this.graph.touch,
          )
        : []),
      ...(this.graph.objectRendererReady && this.graph.engineCaption !== null
        ? createGroupE0ObjectList(
            this.graph.manager,
            this.graph.selectionDialog,
            this.graph.engineCaption,
          )
        : []),
      ...(this.graph.engineCaption === null
        ? []
        : [
            ...createGroupE0InputCaptures(
              this.graph.input,
              this.graph.selectionDialog,
              this.graph.engineCaption,
            ),
            ...createGroupE0Modules(this.graph.selectionDialog, this.graph.engineCaption),
          ]),
      group81Constant,
    ];
    const keys = new Set<string>();
    for (const definition of definitions) {
      const key = `${definition.primary}:${definition.secondary}`;
      if (
        AOKANA_NATIVE_SLOT_ADDRESSES[definition.primary]?.[definition.secondary] !==
        definition.nativeAddress
      )
        throw new Error(`Aokana partial native fragments have an invalid inventory address ${key}`);
      if (keys.has(key)) throw new Error(`Aokana partial native fragments duplicate ${key}`);
      keys.add(key);
    }
    return definitions.map((definition) => ({
      ...definition,
      execute: (context) => {
        if (context.memory !== this.data.memory)
          throw new Error('Aokana native fragments require the aggregate BP memory');
        return definition.execute(context);
      },
    }));
  }
}
