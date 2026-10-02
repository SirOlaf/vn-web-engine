import {hasSignedFile, type InstallationRecognizer} from '../../platform/installation-detection.js';

/** MAGES installations keep their scripts and messages in CRI archives below `Data`
 * (or chosen without it): `script.cpk` with a `CPK ` header beside `mes00.cpk`. */
export const isMagesInstallation: InstallationRecognizer = async (files) =>
  files.some((file) => /^(\/data)?\/mes00\.cpk$/i.test(file.path)) &&
  hasSignedFile(files, /^(\/data)?\/script\.cpk$/i, ['CPK ']);
