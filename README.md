# SubView — Video Sync

Chrome Manifest V3 extension for synchronizing a visible HTML5 video with extension-owned background audio, or with a second video tab.

Watch a subtitled video while hearing its dubbed audio: turn SubView on for a site, and when the page offers both Sub and Dub it plays the Dub's sound in time with the video on your screen. Your tab stays on Sub.

## Install

SubView isn't on the Chrome Web Store. To install it:

1. Download `subview-<version>.zip` from the [latest release](https://github.com/Jozeph-Zemambo/SubView/releases/latest) and unzip it somewhere you'll keep it.
2. Open `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder.
4. Open a video page, click the SubView icon, and press the burst to turn it on for that site.

Needs Chrome 119 or newer. Chrome doesn't update extensions installed this way, so the popup shows a yellow note at the bottom when a newer release is out. To update, download the new zip, replace the folder's contents, and click **Reload** on SubView's card in `chrome://extensions`.

SubView collects nothing and has no servers. Its one outside request is that version check: at most once a day, when you open the popup, it asks GitHub for the latest release number. See [PRIVACY.md](PRIVACY.md). It doesn't download or save video or audio, and doesn't work with DRM-protected players.

## Local development

```sh
npm install
npm run typecheck
npm test
npm run build
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the generated `dist/` directory.

After rebuilding an already loaded extension, click **Reload** on its extension card and refresh the video page. Chrome 119 or newer is required (offscreen lifecycle API, and content scripts in about:blank/blob frames for hosted Dub pages).

## Popup

The popup (`src/popup/popup.*`) is the everyday control: one power button that turns Auto Dub on or off for the current site, a status line, a readout of the Dub **server** and where the audio comes from (hidden copy or minimized window), Dub volume, mute original audio, Dub timing (offset, in seconds) and auto offset. Settings apply live while a Dub plays in that tab and are saved for the site. The look is "Manga Pop" and follows the system theme: light is Classic Ink (yellow burst, pink lettering, blue buttons); dark swaps the roles (pink burst, yellow lettering). Fonts (Dela Gothic One, Zen Kaku Gothic New; SIL Open Font License, latin subsets) are bundled in `src/popup/fonts/`, so the popup page itself loads nothing from the network. The new-version note (`src/background/update-check.ts`, `src/shared/update.ts`) is fetched by the background worker, only for copies loaded from a folder. Design explorations are in `design/`.

**Debug tools** (link at the bottom; `debug.html`) is the original full popup: manual background audio from a media URL, two-tab sync, tab and video pickers, language detection details and Scan again. `popup.html?tab=<id>` opens the popup for a specific tab (used by tests).

## Background audio (first milestone)

Choose **Background audio**, select the visible tab/video, paste a direct playable HTTP(S) media URL, and start. The extension's offscreen video element supplies the audio without opening another website tab. Volume and **Mute original video** can be changed while active. The mute preference defaults on and is remembered locally. The popup can be closed.

The source must be native playable media (for example, supported MP4, WebM, MP3 or WAV), or an HLS `.m3u8` manifest. HLS playback uses locally bundled hls.js, not executable code from a CDN. An episode webpage URL is not a media URL. DASH and DRM-specific sources are not supported. Streams may still reject extension-origin requests or require authentication; those failures are reported rather than bypassed.

When **Mute original video** is on, the visible video is muted only after background audio starts successfully. Turning it off releases the extension's mute and restores the previous state; it does not forcibly unmute a video the user already muted. Stop restores that state and closes the hidden player. Playback failure restores the visible video's sound; closing/navigating the visible tab stops the session. Chrome may close the hidden document after 30 seconds of audio inactivity; a subsequent visible media event restores it from the saved source and sync state. No silent keepalive or fixed recovery timer is used.

The playback/synchronization core contains no site-specific selectors or provider assumptions. Video discovery includes accessible embedded frames. Frame/document identifiers keep controls attached to the selected player, rather than another frame with the same local video ID. Any future site-specific adapter should be explicit and separate from this core.

## Automatic language detection (second milestone, detection layer)

Opening the popup defaults to the current HTTP(S) tab when no session or explicit selection exists. Selecting a primary tab starts read-only detection of its Sub/Dub controls, independently of whether a top-level video was found. The popup shows the selected language, Dub availability, selected provider when exposed, and any actual Dub links exposed by the controls. Changes update automatically, including navigation in the inspected tab. Only explicitly inspected tabs and Auto Dub's temporary lookup tabs are watched; there is no injection into unrelated tabs. The watcher registration lasts for the browser session and is removed when the tab closes.

The detector uses generic native selects and semantic selected/checked/pressed controls. No site hostname or generated CSS class is hard-coded. Plain text mentions, ambiguous choices, or conflicting selected controls return **Unknown**. A `dub` option value is a language identifier, not a media URL; it is never turned into a guessed link. Page links and direct-media candidates are distinguished. Detection alone never starts playback.

DOM events/mutations drive detection updates; silent JavaScript property changes without events or DOM changes require a rescan. Language controls are inspected in the top document, while video discovery independently probes accessible frames. Closed shadow-root video elements are not supported.

Concurrent inspections of the same page share one pending detection request. Only navigation or tab closure invalidates that page generation; another scan no longer produces a false **The page changed during detection** error. Old-document results are still rejected after real navigation.

An explicit **Scan again** retries a failed Dub lookup and rechecks language if the previous detection failed. Ordinary media events do not continuously retry failures, and a scan during an active lookup does not open a duplicate temporary tab.

### Auto Dub (hosted Dub page)

Auto Dub is off by default and is turned on **per site**, like an ad blocker's allowlist: **Turn on Auto Dub for <site>** saves the site (and that site's volume, offset and mute settings) in `chrome.storage.local`, so it survives browser restarts. Auto Dub then attaches to whichever tab you switch to on an enabled site, including after a restart; while it is playing Dub in one tab it stays there rather than following you to a tab you are only browsing. Per site it also remembers which Dub server played (tried first next time) and which failed (tried last for 24 hours). While the attached tab shows Sub and the episode has a Dub option, SubView loads **a copy of the same episode page inside the extension's offscreen document**, selects Dub there with the page's own controls, and syncs that copy's video to the visible one. The visible tab is never touched. Nothing extracts or re-fetches stream URLs: the site's own player loads its own media, so provider-specific tricks (signed tokens, Referer checks, blob playlists, disguised segments) are handled by the site's code.

How it works (`src/background/auto-dub.ts`, `hosted-dub.ts`, `hosted-host.ts`):

1. Load the episode URL in an iframe in the offscreen document (`src/host/mount.ts`). Session header rules, scoped to this container: the episode page gets its own site as `Referer`; `X-Frame-Options`/`Content-Security-Policy` are removed only from frames on the episode's site and from frames that the episode page (or a player already hosted in it) requests. Each hosted frame adds its site to that list when it starts, so a player's own sub-frames work, while frames requested by anything else (another extension, for example) never match.
2. Two content scripts are registered **only while a hosted page exists**, and act only in frames whose top-most ancestor is an extension page:
   - `hosted/hosted-shim.js` (page world): offscreen documents never lay out or paint, so it reports the page as visible, gives zero-size elements and observers a player-sized box, and runs `requestAnimationFrame` from a timer. It also gives the copy **private storage writes** (`localStorage`/`sessionStorage` reads fall through, writes stay in memory) and namespaces `BroadcastChannel`, so selecting Dub never flips the user's own tabs to Dub.
   - `hosted/hosted-agent.js` (isolated world, exact extension-id check): exposes the frame's videos and Sub/Dub/Server controls to the worker over a runtime port. Frames without a tab can't receive `tabs.sendMessage`, and offscreen frames have no `documentId`, so each agent names its frame with a random key. It keeps every video muted until the worker activates the chosen one.
3. Wait for the copy's Sub video to finish loading (so a late Sub load can't pass for Dub), select Dub, then take the episode-length video that started loading after the selection (`src/shared/hosted-selection.ts`). If the page has a Server/Provider control, the Dub server in the same family as the user's Sub server is preferred (`alpha · embed · s-sub` → `alpha · embed`); a server that doesn't load within 25 s is replaced by the next one.
4. Link it as the secondary endpoint (`tabId` `-2`, addressed by frame key). Sub leads; Dub follows play, pause, seek and speed.

If the player won't start in the offscreen document, the same hosted page (same shim and storage isolation) opens in a **minimized extension window** as a fallback. The popup says which one is in use: **Hidden Dub page** or **Minimized Dub window**. If the Dub stops playing (the copy's player failed or its window closed), it's reloaded once per episode, then reported. A new episode URL closes the old copy and loads the new one. Replacing the visible video relinks the existing copy without reloading it.

Detection and selection are generic (native selects and semantic tab/radio controls), with no site hostnames or CSS classes. Inside hosted copies, visibility checks use attributes and computed style instead of layout boxes, since those documents never lay out.

Limits: cookies set by the copy (including HTTP `Set-Cookie`) and IndexedDB writes are not isolated; storage isolation covers `localStorage`, `sessionStorage` and `BroadcastChannel`. Sites that block framing in script (frame-busting), require a login that only a top-level tab can complete, or use DRM may fail in both containers; the popup reports the reason. Networks that filter streaming hosts affect Chrome traffic generally, not SubView specifically.

## Synchronization and two-tab fallback

Background audio (hidden player or Auto Dub's retained tab) is one-way: the visible Sub video leads and Dub follows. Buffering never transfers control to Dub, and Dub controls cannot seek, pause, or change the speed of Sub. Normal synchronization sends no playback commands to Sub. The explicit Auto Offset lead-in adjustment on setup or enabling the setting remains supported; it is not repeatedly imposed when the user seeks. Manual two-tab sync retains its bidirectional behavior.

### Auto offset

The Timing section has an **Auto offset** switch, off by default. Off uses the retained manual offset. On assumes the longer version has extra material at its beginning and calculates `secondary duration − primary duration + manual correction`. It skips that initial excess in the longer player; it does not identify intros, credits, or matching scenes. The setting applies to background audio, Auto Dub, and two-tab sync. Manual correction remains available while Auto offset is on; the buttons adjust Dub without moving Sub. Switching Auto offset off uses the manual correction alone. The popup expresses this as Dub delay: positive delays Dub and negative advances it.

Both lengths must be finite and known. Until then, the manual offset remains in use and the popup says **Waiting for video lengths**; metadata events drive the calculation, not a delay. For example, Sub at 23:37.184 and Dub at 24:04.769 gives +27.585 seconds: Dub starts that far ahead of Sub. A longer primary video instead skips its own initial excess.

- Choose a primary and secondary tab from the popup.
- Choose one detected `<video>` element in each tab, including accessible embedded frames.
- Enter a signed Dub delay as `hh:mm:ss`; positive values delay Dub and negative values advance it.
- Play, pause, seek, and playback-rate changes are translated through a revisioned canonical timeline.
- A video that ends or buffers does not pause the other video. It can rejoin when the canonical position returns to its playable range.
- Audible `play()` calls can still be rejected by Chrome autoplay policy; the popup reports when manual play is required.

Privileged Chrome pages and Safari packaging are not supported.

## Tests

- `npm test`: unit tests (sync core, controller, detection host, Auto Dub coordinator, hosted video/server selection, offsets, HLS failure formatting).
- `npm run test:hosted`: the built extension against a local site shaped like the hard live cases: a cross-origin player frame that refuses framing (`X-Frame-Options`/`frame-ancestors`), loads only once it is on screen and has painted, a language preference in `localStorage`, and other tabs that follow it through `storage` events. Checks that Dub is selected in the offscreen copy, the visible tab and its storage stay on Sub, drift stays small, seek/pause follow, and Disable removes the copy, its header rules and its scripts.
- `npm run test:playback`, `test:hls`, `test:detection`, `test:auto-offset`: manual background audio, HLS decoding, detection/selection fixtures and offsets.
- `npm run test:live -- <watchUrl> [subServer] [--quick]`: the built extension against a real site (headless, muted). It selects Sub (and a Sub server by value or family name), enables Auto Dub, then plays/seeks/pauses/changes speed while sampling drift through the worker's `subviewDiagnostics.sampleSyncDrift()`. Needs network and a site that is up; not part of `npm test`.

Set `CHROMIUM_PATH` to a Chrome for Testing (or Chromium) executable for the browser tests. `playwright-core` does not download browsers.

## Fine sync

Background Dub is corrected by seeking only when it is more than 350 ms off. Below that, the worker compares the two videos' positions at a common instant (snapshots carry capture timestamps) and nudges the Dub's playback speed by up to ±4% until it is within 15 ms, then returns it to normal speed. Speed-only commands carry no target time, so they never seek.

## History

Until 2026-09-30 Auto Dub found the Dub by opening a lookup tab and reconstructing the provider's stream URL (JW Player getters, request capture, blob playlist graphs, Referer rules), then replayed it in the offscreen player, with a retained Dub tab as fallback. Each new provider needed another fix. The hosted-page design replaced that pipeline; the old code is kept in a local backup, not in this repository.
