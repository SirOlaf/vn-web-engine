# Mobile files and audio

Both game players use the project-level installation picker, cache and browser audio host.
The native engines still read the same byte ranges, wait for real playback, and use their
original loading order.

## Using local game files

1. Open the player through HTTPS (or localhost on the device running the browser).
2. Choose **Choose game folder**. Where supported, this requests a read-only directory
   handle and reads selected files on demand, without an application-created archive copy.
   Keep the source folder available and unchanged while playing. Select it again after reload.
3. If folder selection omits files, try **Use browser folder picker**, where offered, or
   **Add files**. **Add one file** uses a single-file picker for managers without multiple
   selection. Added files accumulate; a new folder replaces the selection. For Aokana include
   the root archives, `BGI.gdb` and game executable. For NOAH include `Game.exe` and `Data/*.cpk`.
   Expand **selected files** to see the exact paths the browser returned if files are missing.
   macOS `._` sidecars and `.DS_Store` metadata are ignored during installation selection.
4. To retain an installation in the browser, choose device files,
   then choose **Keep game files in browser** before Play. The copy has byte progress and
   cancellation. When finished, the current player uses the saved copy immediately.
5. On later visits choose **Open saved game files**. **Remove saved game files** deletes
   installation bytes only; browser saves and settings remain separate.

The preferred direct directory API is supported by current Chromium, including supporting
Android releases. Safari uses the folder-input fallback. iOS Safari added folder inputs in
18.4, but WebKit's iOS picker imports selected directories into temporary storage: a web
application cannot promise zero-copy folder access on iOS. OPFS provides the deliberate
persistent-copy alternative; writable file streams arrived in Safari 26.
See [Chrome's File System Access documentation](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access),
[WebKit's folder-input release notes](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/),
[the iOS picker implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/ios/forms/WKFileUploadPanel.mm),
and [Safari 26 storage support](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/).

The cache streams files into OPFS in bounded chunks, then publishes a completed manifest.
Cancellation or a failed replacement retains the previous completed installation. Replacement
temporarily needs space for both copies. Close other players using that installation before
replacing or removing it: deleting backing files can invalidate their open file snapshots.
After a tab closes during a copy, a later save cleans abandoned generations when Web Locks
is available; removing the saved installation also clears them.

Persistence is requested but the browser decides whether to grant it. Private browsing,
quota limits, browser eviction and clearing site data can remove cached installations.
See [WebKit's storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/).
These are local game assets, not an offline application install: the viewer page and its
JavaScript still need the static website. GitHub Pages supplies HTTPS; for a local server,
LAN HTTP lacks the secure context needed by advanced file/storage APIs. Use the HTTPS setup
in the project README.

## Vorbis decoding and audio recovery

Ogg Vorbis now uses a shared WebAssembly libvorbis decoder, preserving the PCM samples
and stream boundaries that native playback waits depend on. A decoder-only WebKit
comparison returned 3,981 frames for a synthetic 4,109-frame stream. For Aokana's
`ASUKA` clip it returned 64,832 frames instead of 64,892, with the first 128 samples
missing. This is a decoding error even when the browser audio clock is advancing.
The shared decoder supplies the actual boundary PCM; it does not pad with silence,
shorten native waits or substitute a timer for playback completion.

The decoder is bundled with the application and works with device files, browser-cached
files and server sources. Its [third-party notices](../third_party/ogg-vorbis/README.md)
describe the pinned dependency and included licenses. The shared worker retained all 4,109
synthetic frames and completed playback through WebKit's audio worklet. All four startup
voices decoded to their native lengths; ASUKA's full PCM matched native within `4.17e-7`.
Playback past the splash screens has also been confirmed on the affected iPhone.

The shared host monitors each audio context, retries activation from gestures and page
return, and exposes **Resume audio** outside the canvas even during startup. **Audio
diagnostics** in Game options reports context state, device sample rate and real audio
clock. Refresh it twice to check whether that clock advances if playback appears stalled.

Previously Aokana resumed its context only once; the existing shared recovery helper had
no production consumers. The player now uses that helper without rebuilding buffers or
pretending native playback completed. NOAH also starts all audio-context activation calls
before awaiting any of them, preserving the initiating gesture. WebKit has reported
interrupted/suspended playback failures; see [the WebKit interruption report](https://bugs.webkit.org/show_bug.cgi?id=273511).
Audio-context recovery addresses a separate failure mode from the Vorbis boundary error.
Physical-device playback and game visuals require user verification.

File reads display activity outside the canvas, including bytes read and
how long the oldest pending read has been waiting. Startup and browser movie preparation
have separate activity labels; movie metadata loading and buffering are distinguished
from application file reads. These indicators observe work without advancing native clocks
or declaring playback complete. They are activity reports, not estimated completion times.

Fullscreen movies selected from device files or browser storage now pass the exact file
region directly to browser media playback, including movies inside archives. Previously
this path read the entire movie in 128 KiB chunks and copied it again before playback.
The shared source helper uses [Blob ranges](https://www.w3.org/TR/FileAPI/#slice-method-algo)
to avoid those application-created copies. The browser still owns its internal buffering.
Server byte-range transport remains available to development tools. The player uses device
files or the installation cache, avoiding network latency during gameplay. The initial pre-splash delay
reported on Android Brave with internal-storage files still needs device timing evidence;
the activity labels help distinguish startup work, file reads, and media preparation.
