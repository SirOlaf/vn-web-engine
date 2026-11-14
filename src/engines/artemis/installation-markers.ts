import {hasSignedFile, type InstallationRecognizer} from '../../platform/installation-detection.js';

/** Artemis installations keep their resources in `.pfs` archives with the `pf8` signature. */
export const isArtemisInstallation: InstallationRecognizer = (files) =>
  hasSignedFile(files, /\.pfs(\.\d{3})?$/i, ['pf8']);
