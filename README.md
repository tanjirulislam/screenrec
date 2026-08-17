# ScreenRec

A Windows screen recorder built with Electron. Region capture, webcam overlay, system audio, and global hotkeys.

![Built with Electron](https://img.shields.io/badge/Electron-31-47848F)
![Platform](https://img.shields.io/badge/platform-Windows-0078D6)
![License](https://img.shields.io/badge/license-MIT-green)

## Download

Grab the latest installer from the [Releases](../../releases) page.

- **ScreenRec-Setup.exe** — installs normally, adds a Start Menu shortcut
- **ScreenRec-portable.exe** — runs directly, installs nothing

Windows shows a SmartScreen warning because the build is not code-signed. Choose **More info → Run anyway**.

## Features

| | |
| --- | --- |
| **Six capture modes** | Full screen, screen without taskbar, drag-out region, fixed-size region, single window, repeat last region |
| **Audio** | System sound and microphone, mixed together or separately |
| **Webcam overlay** | Circular picture-in-picture, positionable in any corner |
| **Global hotkeys** | `Ctrl+Shift+R` start/stop, `Ctrl+Shift+P` pause, `Ctrl+Shift+X` stop |
| **Compact while recording** | The window shrinks to a timecode bar so it stays out of the video |
| **MP4 output** | H.264 via bundled ffmpeg, or raw WebM for instant saves |
| **Tray control** | Runs in the background; hotkeys work with the window hidden |

Recordings save to `Videos\ScreenRec\`. Preferences and the last region persist between sessions.

## How it works

The screen, webcam, and audio are three separate streams combined *before* recording rather than after:

1. `desktopCapturer` enumerates screens and windows.
2. `getUserMedia` with `chromeMediaSource: 'desktop'` captures the screen. On Windows the same call also returns system audio.
3. Each frame is drawn to an offscreen canvas — cropping and the webcam circle happen together in one pass.
4. Microphone and system audio are mixed through a Web Audio graph into a single track.
5. `canvas.captureStream()` and that audio track feed a `MediaRecorder`.
6. Chunks flush to disk every 2 seconds over IPC, so recording length is bounded by disk space rather than RAM.
7. ffmpeg transcodes the finished WebM to H.264 MP4.

### Design notes

**Region coordinates are stored as fractions, not pixels.** This sidesteps Windows display scaling entirely — at 150% DPI, pixel arithmetic silently crops the wrong area, but a fraction of the frame is always a fraction of the frame.

**"Without taskbar" reads Electron's `workArea`** rather than subtracting a hardcoded height, so it stays correct whether the taskbar is docked to any edge, auto-hidden, or on a scaled display.

**Compositing costs CPU** — every frame passes through JavaScript. Negligible at 1080p30, noticeable at 4K60.

**System audio is Windows-only.** The `chromeMediaSource: 'desktop'` audio constraint has no macOS equivalent; porting would require shipping a virtual audio driver or using ScreenCaptureKit.

## Building

GitHub Actions builds this automatically — see [`.github/workflows/build.yml`](.github/workflows/build.yml). Push a tag to publish a release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

To build locally on Windows instead:

```bash
npm install
npm run build     # output in dist/
npm start         # run without building
```

## Project layout

```
main.js              Windows, tray, hotkeys, disk writes, ffmpeg, settings
preload.js           Context-isolated IPC bridge
renderer/
  index.html         Main dialog and recording bar
  styles.css         Native Windows styling
  app.js             Capture modes, compositing, recording
  overlay.html       Region selector
assets/              Application and tray icons
```

## License

MIT
