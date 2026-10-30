/** Nonvisual PF8/ASB verification. No media decoding, rendering or extraction. */
import {openArtemisInstallation} from './artemis-installation.mjs';
import {parseAsb} from '../dist/formats/artemis/asb.js';

if (!process.argv[2]) throw new Error('Usage: node tools/verify-artemis.mjs GAME_DIRECTORY');
const installation = await openArtemisInstallation(process.argv[2]);
try {
  const {files} = installation;
  let entries = 0,
    asbRecords = 0,
    asbFiles = 0;
  for (const {archive} of files.archives) {
    entries += archive.entries.length;
    for (const entry of archive.entries)
      if (entry.name.endsWith('.asb')) {
        const program = parseAsb(await archive.read(entry));
        asbRecords += program.records.length;
        asbFiles++;
      }
  }
  const boot = await files.read('system/first.iet');
  const auth = await files.read('system/extend/auth.lua');
  console.log(
    JSON.stringify(
      {
        archives: files.archives.map((a) => a.name),
        entries,
        asbFiles,
        asbRecords,
        bootBytes: boot?.length ?? null,
        authBytes: auth?.length ?? null,
      },
      null,
      2,
    ),
  );
} finally {
  await installation.close();
}
