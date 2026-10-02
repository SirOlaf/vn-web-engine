import {hasSignedFile, type InstallationRecognizer} from '../../platform/installation-detection.js';

/** RScript installations keep their resources in `.xfl` archives: `LB`, version 1 (0x43CCB0). */
export const isRScriptInstallation: InstallationRecognizer = (files) =>
  hasSignedFile(files, /\.xfl$/i, [[0x4c, 0x42, 0x01]]);
