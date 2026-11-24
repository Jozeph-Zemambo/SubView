# SubView — Video Sync: Privacy Policy

Last updated: 23 November 2026 (added: automatic reload settings and what a reload puts back; Chrome Web Store copies never check for a new version; a site you turn off keeps its settings)

SubView is a browser extension that plays an alternate-language audio version of the video you are watching, in sync with that video.

## What SubView collects

Nothing. SubView does not collect, transmit, sell or share any information about you or your browsing. It has no servers, no accounts, no analytics and no ads.

## Checking for a new version

A copy installed from a release zip can't update itself. So when you open the popup, at most once a day, SubView asks GitHub for the number of its latest release (`api.github.com/repos/Jozeph-Zemambo/SubView/releases/latest`) and shows a note if a newer one is out. The request carries nothing about you, your settings or the sites you visit. Like any web request, GitHub sees the IP address it comes from.

Copies installed from the Chrome Web Store are updated by the browser itself and never make this request.

## What SubView stores on your device

To remember your choices, SubView saves the following in your browser's extension storage, on your device only:

- the sites you turned SubView on for (the site's hostname), including any you later turned off, so their settings come back if you turn SubView on there again;
- for each of those sites: Dub volume, timing offset, whether the original audio is muted, whether auto offset is on, whether you allowed SubView to reload the tab automatically, whether the site's pages need SubView's frame-compatibility mode, and the name of the Dub server that last worked or recently failed;
- the latest release number GitHub reported, and when to ask again.

While it is running, SubView also keeps the current playback state (which tab and video are being synced) in temporary session storage, which the browser clears when it closes. The same session storage holds two timestamps: when SubView last closed its second copy of a page, and when it last reloaded a tab, so it can wait out a site's cooldown and never reload a tab twice in quick succession.

This information never leaves your browser. Removing the extension deletes it.

## What SubView accesses while it runs

On a site you turned it on for, SubView reads the page's video position and its Sub/Dub and server controls, and loads a second copy of the same page inside the extension to play that page's dubbed audio. The second copy is loaded from the same website you are already visiting, using your browser's existing connection and cookies for that site. SubView does not read or send this content anywhere else.

When you ask SubView to reload the tab, or have allowed it to do so automatically, it first notes that player's current choices (such as audio language, subtitles, playback position and whether it was playing) and puts them back once the reloaded player is ready. This note is kept only temporarily on your device, in the extension's memory, and is discarded once it has been used, or after about a minute.

SubView does not touch pages on sites you have not turned it on for, unless you pick that tab yourself in Debug tools.

## Changes

If this policy changes, the new version will be posted here with a new date.

## Contact

Open an issue on this repository.
