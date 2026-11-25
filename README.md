# SubView4Dub

Watch subtitled video while listening to dubbed audio in sync.

Turn SubView4Dub on for a site, and it plays the dubbed audio track in time with the subtitled video on your screen. Your visible tab stays on Sub with full dialogue subtitles and translated on-screen text.

## Features

- **Opt-in per site:** Off everywhere by default until you click the power burst for a site.
- **Automatic sync:** Follows play, pause, seeks, and playback speed without touching your visible tab.
- **Works across player layouts:** Detects both in-player audio language menus and classic Sub/Dub selectors, with no hardcoded websites.
- **Built-in mixer:** Per-site Dub volume, mute original audio, +/-0.5 s timing nudges, Auto Offset for intro differences, and one-click tab switching.
- **Manual mode (Debug tools):** Sync any two HTML5 video tabs or pair a video with a direct audio/HLS URL.

> **Note:** On subscription streaming services, Auto Dub uses a second player stream, so your plan must allow at least two concurrent streams.

## Install

Requires Chrome 119 or newer.

1. Download `subview-<version>.zip` from the [latest release](https://github.com/Jozeph-Zemambo/SubView/releases/latest) and unzip it to a folder you will keep.
2. Open `chrome://extensions` and enable **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder.
4. Open a video page, click the SubView4Dub icon, and tap the burst to turn it on for that site.

Unpacked copies show a yellow notice in the popup when a newer GitHub release is available. To update, replace the folder's contents and click **Reload** in `chrome://extensions`.

## Privacy

SubView4Dub collects no personal data, has no backend servers, no accounts, and no ads. Unpacked installs check GitHub at most once a day for a newer release number; Chrome Web Store installs make no outside requests. See [PRIVACY.md](PRIVACY.md).

## Local development

```sh
npm install
npm run typecheck
npm test
npm run build
```

Load the generated `dist/` folder via **Load unpacked** in `chrome://extensions`.

For technical design details (hosted-copy isolation, audio-by-language detection, stream-limit handling, fine sync, and browser test suites), see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
