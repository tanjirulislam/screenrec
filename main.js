'use strict';

const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen,
  globalShortcut, Tray, Menu, nativeImage, shell, dialog
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let controlWindow = null;
let overlayWindow = null;
let borderWindow = null;
let tray = null;

let writeStream = null;
let currentPath = null;
let bytesWritten = 0;
let uiState = 'idle';

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_DIR = path.join(app.getPath('videos'), 'ScreenRec');

const PANEL_SIZE = { width: 780, height: 580 };
const COMPACT_SIZE = { width: 320, height: 150 };

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  } catch (err) {
    console.error('Could not save settings:', err);
  }
  return next;
}

function outputDir() {
  const dir = readSettings().savePath || DEFAULT_DIR;
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    fs.mkdirSync(DEFAULT_DIR, { recursive: true });
    return DEFAULT_DIR;
  }
}

/* ------------------------------------------------------------------ */
/* Windows                                                             */
/* ------------------------------------------------------------------ */

function createControlWindow() {
  controlWindow = new BrowserWindow({
    ...PANEL_SIZE,
    resizable: false,
    maximizable: false,
    frame: false,
    backgroundColor: '#FFFFFF',
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Without this, Chromium throttles timers and rAF whenever the window
      // is backgrounded or covered. That starves the capture canvas of frames
      // and the finished video plays back in slow motion.
      backgroundThrottling: false
    }
  });

  controlWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  controlWindow.once('ready-to-show', () => controlWindow.show());

  // Keeps the recorder's own window out of the video it is recording.
  controlWindow.setContentProtection(true);

  controlWindow.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); controlWindow.hide(); }
  });

  controlWindow.on('closed', () => { controlWindow = null; });
}

function openRegionOverlay(displayId) {
  return new Promise((resolve) => {
    const target = displayFor(displayId);
    const { x, y, width, height } = target.bounds;
    const panelWasVisible = controlWindow && controlWindow.isVisible();
    if (panelWasVisible) controlWindow.hide();

    overlayWindow = new BrowserWindow({
      x, y, width, height,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      fullscreenable: false,
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    overlayWindow.setContentProtection(true);
    overlayWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('region:result', onResult);
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
      overlayWindow = null;
      if (panelWasVisible && controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.show();
      }
      resolve(result);
    };

    const onResult = (_evt, rect) => finish(rect);
    ipcMain.on('region:result', onResult);
    overlayWindow.on('closed', () => finish(null));
  });
}

/**
 * A click-through frame drawn around whatever is being captured, so it is
 * obvious that recording is live. Content protection keeps it out of the
 * video itself, the border is for the person, not the viewer.
 */
function showBorder(displayId, region) {
  hideBorder();

  const display = displayFor(displayId);
  const b = display.bounds;

  const rect = region
    ? {
        x: Math.round(b.x + region.x * b.width),
        y: Math.round(b.y + region.y * b.height),
        width: Math.round(region.w * b.width),
        height: Math.round(region.h * b.height)
      }
    : { x: b.x, y: b.y, width: b.width, height: b.height };

  if (rect.width < 8 || rect.height < 8) return;

  borderWindow = new BrowserWindow({
    ...rect,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });

  borderWindow.setIgnoreMouseEvents(true, { forward: true });
  borderWindow.setAlwaysOnTop(true, 'screen-saver');
  borderWindow.setContentProtection(true);
  borderWindow.loadFile(path.join(__dirname, 'renderer', 'border.html'));
}

function hideBorder() {
  if (borderWindow && !borderWindow.isDestroyed()) borderWindow.close();
  borderWindow = null;
}

function displayFor(displayId) {
  return screen.getAllDisplays().find((d) => String(d.id) === String(displayId))
    || screen.getPrimaryDisplay();
}

/* ------------------------------------------------------------------ */
/* Tray + hotkeys                                                      */
/* ------------------------------------------------------------------ */

function trayIcon() {
  const file = path.join(__dirname, 'assets', 'tray.png');
  return fs.existsSync(file)
    ? nativeImage.createFromPath(file).resize({ width: 16, height: 16 })
    : nativeImage.createEmpty();
}

function refreshTray() {
  if (!tray) return;
  const label = { idle: 'Ready', recording: 'Recording', paused: 'Paused' }[uiState];

  tray.setToolTip(`ScreenRec, ${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `ScreenRec, ${label}`, enabled: false },
    { type: 'separator' },
    {
      label: uiState === 'idle' ? 'Start recording' : 'Stop recording',
      accelerator: 'Ctrl+Shift+R',
      click: () => send('hotkey', 'toggle')
    },
    {
      label: uiState === 'paused' ? 'Resume' : 'Pause',
      enabled: uiState !== 'idle',
      click: () => send('hotkey', 'pause')
    },
    { type: 'separator' },
    { label: 'Show recorder', click: showPanel },
    { label: 'Open recordings folder', click: () => shell.openPath(outputDir()) },
    { type: 'separator' },
    { label: 'Exit', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
}

function showPanel() {
  if (!controlWindow) createControlWindow();
  else { controlWindow.show(); controlWindow.focus(); }
}

function send(channel, payload) {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send(channel, payload);
  }
}

function registerHotkeys() {
  const map = {
    'CommandOrControl+Shift+R': 'toggle',
    'CommandOrControl+Shift+P': 'pause',
    'CommandOrControl+Shift+X': 'stop'
  };
  for (const [combo, action] of Object.entries(map)) {
    if (!globalShortcut.register(combo, () => send('hotkey', action))) {
      console.warn(`Hotkey unavailable: ${combo}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

ipcMain.handle('sources:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 0, height: 0 }
  });
  const displays = screen.getAllDisplays();

  return sources
    .filter((s) => s.name !== 'ScreenRec')
    .map((s) => {
      const kind = s.id.startsWith('screen') ? 'screen' : 'window';
      let metrics = null;
      if (kind === 'screen') {
        const d = displays.find((dd) => String(dd.id) === String(s.display_id))
          || screen.getPrimaryDisplay();
        metrics = { bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor };
      }
      return { id: s.id, name: s.name, displayId: s.display_id || null, kind, metrics };
    });
});

ipcMain.handle('region:select', async (_e, displayId) => openRegionOverlay(displayId));
ipcMain.handle('border:show', async (_e, { displayId, region }) => showBorder(displayId, region));
ipcMain.handle('border:hide', async () => hideBorder());

ipcMain.handle('settings:get', async () => ({ ...readSettings(), savePath: outputDir() }));
ipcMain.handle('settings:set', async (_e, patch) => writeSettings(patch));

ipcMain.handle('settings:chooseFolder', async () => {
  const res = await dialog.showOpenDialog(controlWindow, {
    title: 'Choose where recordings are saved',
    defaultPath: outputDir(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;

  const dir = res.filePaths[0];
  try {
    // Prove it is writable now rather than failing mid-recording.
    const probe = path.join(dir, `.screenrec-${Date.now()}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
  } catch {
    return { error: 'That folder is not writable. Pick another one.' };
  }

  writeSettings({ savePath: dir });
  return { path: dir };
});

ipcMain.handle('file:begin', async () => {
  const dir = outputDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  currentPath = path.join(dir, `recording-${stamp}.part`);
  writeStream = fs.createWriteStream(currentPath);
  bytesWritten = 0;
  return { path: currentPath };
});

ipcMain.handle('file:chunk', async (_e, arrayBuffer) => {
  if (!writeStream) return { ok: false };
  const buf = Buffer.from(arrayBuffer);
  bytesWritten += buf.length;
  await new Promise((res, rej) =>
    writeStream.write(buf, (err) => (err ? rej(err) : res())));
  return { ok: true, bytes: bytesWritten };
});

ipcMain.handle('file:end', async (_e, { format, fps }) => {
  if (!writeStream) return { path: null };
  await new Promise((res) => writeStream.end(res));
  writeStream = null;

  const raw = currentPath;
  currentPath = null;
  if (!raw || !fs.existsSync(raw) || fs.statSync(raw).size === 0) {
    return { path: null };
  }

  const wantMp4 = format === 'mp4';
  const final = raw.replace(/\.part$/, wantMp4 ? '.mp4' : '.webm');

  try {
    if (wantMp4) await transcodeMp4(raw, final, fps || 30);
    else await remuxWebm(raw, final);
    fs.unlinkSync(raw);
    return { path: final };
  } catch (err) {
    console.error('Post-processing failed:', err);
    // Never strand the recording: keep the raw bytes under a playable name.
    try { fs.renameSync(raw, final.replace(/\.mp4$/, '.webm')); } catch {}
    return {
      path: final.replace(/\.mp4$/, '.webm'),
      warning: 'Saved without re-encoding. Some players may show the wrong length.'
    };
  }
});

ipcMain.handle('file:reveal', async (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
  else shell.openPath(outputDir());
});

ipcMain.handle('file:play', async (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) shell.openPath(filePath);
});

ipcMain.handle('state:set', async (_e, state) => {
  uiState = state;
  refreshTray();
  if (controlWindow && !controlWindow.isDestroyed()) {
    try {
      const icon = trayIcon();
      const live = state === 'recording' && !icon.isEmpty();
      controlWindow.setOverlayIcon(live ? icon : null, live ? 'Recording' : '');
    } catch { /* Windows-only decoration */ }
  }
});

ipcMain.handle('window:compact', async (_e, compact) => {
  if (!controlWindow || controlWindow.isDestroyed()) return;
  const size = compact ? COMPACT_SIZE : PANEL_SIZE;
  controlWindow.setContentSize(size.width, size.height, false);
  controlWindow.setAlwaysOnTop(Boolean(compact));
  if (compact) {
    const { workArea } = screen.getPrimaryDisplay();
    controlWindow.setPosition(
      workArea.x + workArea.width - size.width - 24,
      workArea.y + 24
    );
  } else {
    controlWindow.center();
  }
});

ipcMain.handle('window:minimize', () => controlWindow && controlWindow.minimize());
ipcMain.handle('window:hide', () => controlWindow && controlWindow.hide());

ipcMain.on('region:cancel', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
});

/* ------------------------------------------------------------------ */
/* ffmpeg                                                              */
/* ------------------------------------------------------------------ */

function ffmpegPath() {
  try { return require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked'); }
  catch { return null; }
}

function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    const bin = ffmpegPath();
    if (!bin || !fs.existsSync(bin)) return reject(new Error('ffmpeg not found'));

    const proc = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      const m = /time=(\d+):(\d+):(\d+)/.exec(stderr.slice(-400));
      if (m) send('convert:progress', { label, time: `${m[1]}:${m[2]}:${m[3]}` });
    });
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
  });
}

// Rewrites the container only. Takes a second or two even for long
// recordings, and gives the file the duration MediaRecorder leaves out.
function remuxWebm(input, output) {
  return runFfmpeg(
    ['-y', '-fflags', '+genpts', '-i', input, '-c', 'copy', '-f', 'webm', output],
    'Finishing'
  );
}

function transcodeMp4(input, output, fps) {
  return runFfmpeg([
    '-y', '-fflags', '+genpts', '-i', input,
    '-vf', `fps=${fps}`, '-vsync', 'cfr',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    output
  ], 'Converting');
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showPanel);

  app.whenReady().then(() => {
    createControlWindow();
    tray = new Tray(trayIcon());
    tray.on('click', showPanel);
    refreshTray();
    registerHotkeys();
  });
}

app.on('window-all-closed', () => {});
app.on('before-quit', () => { app.isQuitting = true; hideBorder(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
