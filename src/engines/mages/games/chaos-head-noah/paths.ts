import {windowsLayout} from '../../../../platform/windows-layout.js';

/** The guest profile is explicit and portable; Documents may be redirected.
 * Native 1400617c0/140063b00 use CSIDL_PERSONAL (5), then My Games.
 * Native 14007b320/14007b490 append the descriptor filename directly. */
export function noahPaths(
  documents = 'C:\\Users\\Player\\Documents',
  installation = 'C:\\GOG Games\\CHAOS HEAD NOAH',
) {
  if (!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\)/i.test(documents))
    throw new Error('Documents requires an absolute guest path');
  const directory = documents.replace(/\\+$/, '') + '\\My Games\\Mages Inc\\CHAOS;HEAD NOAH';
  return {
    documents,
    installation,
    directory,
    config: directory + '\\CONFIG.DAT',
    padConfig: directory + '\\PADCONFIG.DAT',
    saveData: directory + '\\SAVEDATA.DAT',
  };
}

export const NOAH_PATHS = noahPaths();
export const NOAH_WINDOWS = windowsLayout(NOAH_PATHS.installation);
