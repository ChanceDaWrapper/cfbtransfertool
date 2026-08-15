'use strict';

// Turns a Node fs error into something a person can act on.
//
// Raw codes are useless in a bug report. This was reported from the field as
// literally "Could not write file: EBADF: bad file descriptor, write" -- which
// tells the user nothing about what to do, and told us almost nothing about
// what went wrong either.
//
// Lives in lib/ rather than main.js so it can be tested: main.js requires
// electron at load time and cannot be imported from a spec.

// What actually produces each of these on Windows, which is the only platform
// this app ships on:
//
//   EBADF / EIO  -- the write started and the OS aborted it. Overwhelmingly a
//                   file that is not really on the disk: a OneDrive
//                   "online-only" placeholder (Files On-Demand), a network or
//                   external drive that dropped, or a handle another process
//                   invalidated. This is the one that got reported.
//   EPERM/EACCES -- permission. Program Files, a read-only file, antivirus, or
//                   Windows Controlled Folder Access.
//   EBUSY        -- another process holds the file open. Usually Madden itself.
//   ENOENT       -- the directory vanished between the dialog and the write.
//   ENOSPC       -- disk full.
function describeWriteFailure(e, outPath) {
  const code = e && e.code;
  const where = outPath ? `\n\nTried to write:\n${outPath}` : '';
  const detail = `\n\n(${code || 'unknown'}: ${(e && e.message) || e})`;

  // The staging fallback got as far as building the file and only failed to
  // PLACE it. The class is finished and sitting on disk, so the single most
  // useful thing to say is where -- the user can drag it the rest of the way
  // in Explorer, which is exactly the move that works when a direct write
  // does not. Anything else here would be burying the lede.
  if (e && e.stagedPath) {
    return 'Could not save into that folder — but your draft class was built successfully.'
      + '\n\nIt is finished and waiting here:'
      + `\n${e.stagedPath}`
      + '\n\nCopy that file into your Madden saves folder in File Explorer and import as normal.'
      + '\nExplorer can write there even when an app cannot, which is usually a OneDrive'
      + '\nfolder set to online-only.'
      + `\n\nIntended destination:\n${e.destPath || outPath}`
      + `\n\n(${code || 'unknown'})`;
  }

  switch (code) {
    case 'EBADF':
    case 'EIO':
      return 'Could not write the file — Windows rejected the write partway through.'
        + '\n\nThis almost always means the folder is not really on this PC:'
        + '\n  • a OneDrive folder set to online-only — right-click it and choose'
        + '\n    "Always keep on this device", then try again'
        + '\n  • a network or external drive that dropped out'
        + '\n  • the file is open in another program — close Madden and retry'
        + '\n\nSaving to a plain local folder such as your Desktop is the quickest way'
        + '\nto tell which it is. If that works, the folder was the problem, not the file.'
        + where + detail;

    case 'EPERM':
    case 'EACCES':
      return 'Could not write the file — Windows denied permission.'
        + '\n\nUsually the folder is protected (anything under Program Files), the existing'
        + '\nfile is marked read-only, or antivirus / Controlled Folder Access is blocking it.'
        + '\nPick a folder inside your own user profile, such as Documents or Desktop.'
        + where + detail;

    case 'EBUSY':
      return 'Could not write the file — it is in use by another program.'
        + '\n\nClose Madden (and anything else that might have it open) and export again.'
        + where + detail;

    case 'ENOENT':
      return 'Could not write the file — that folder no longer exists.'
        + '\n\nIf it is on a removable or network drive, reconnect it, or pick another folder.'
        + where + detail;

    case 'ENOSPC':
      return 'Could not write the file — the drive is full.' + where + detail;

    case 'EROFS':
      return 'Could not write the file — that drive is read-only.' + where + detail;

    default:
      // Unknown code: still say where, and still surface the raw error so a
      // bug report is diagnosable.
      return `Could not write the file.${where}${detail}`;
  }
}

module.exports = { describeWriteFailure };
