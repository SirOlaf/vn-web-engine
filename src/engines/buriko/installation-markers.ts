import {hasSignedFile, type InstallationRecognizer} from '../../platform/installation-detection.js';

/** BGI installations keep their resources in `.arc` PackFile or ARC20 archives. */
export const isBurikoInstallation: InstallationRecognizer = (files) =>
  hasSignedFile(files, /\.arc$/i, ['PackFile    ', 'BURIKO ARC20']);
