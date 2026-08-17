'use strict';

const {
  app, BrowserWindow, ipcMain, desktopCapturer, screen,
  globalShortcut, Tray, Menu, nativeImage, shell
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let controlWindow = null;
let overlayWindow = null;
let tray = null;

let writeStream = null;
let currentPath = null;
let bytesWritten = 0;
let uiState = 'idle'; // idle | recording | paused

const OUTPUT_DIR = path.join(app.getPath('videos'), 'ScreenRec');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const PANEL_SIZE = { width: 420, height: 640 };
const COMPACT_SIZE = { width: 300, height: 150 };

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
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

/* ------------------------------------------------------------------ */
/* Windows                                                             */
/* ------------------------------------------------------------------ */

function createControlWindow() {
  controlWindow = new BrowserWindow({
    ...PANEL_SIZE,
    resizable: false,
    maximizable: false,
    frame: false,
    backgroundColor: '#F3F3F3',
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  controlWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  controlWindow.once('ready-to-show', () => controlWindow.show());

  // Closing parks the app in the tray so the hotkeys keep working.
  controlWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      controlWindow.hide();
    }
  });

  controlWindow.on('closed', () => { controlWindow = null; });
}

function openRegionOverlay(displayId) {
  return new Promise((resolve) => {
    const displays = screen.getAllDisplays();
    const target =
      displays.find((d) => String(d.id) === String(displayId)) ||
      screen.getPrimaryDisplay();

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

/* ------------------------------------------------------------------ */
/* Tray + hotkeys                                                      */
/* ------------------------------------------------------------------ */

function trayIcon() {
  const file = path.join(__dirname, 'assets', 'tray.png');
  if (fs.existsSync(file)) {
    return nativeImage.createFromPath(file).resize({ width: 16, height: 16 });
  }
  return nativeImage.createEmpty();
}

function refreshTray() {
  if (!tray) return;

  const label = { idle: 'Ready', recording: 'Recording', paused: 'Paused' }[uiState];

  tray.setToolTip(`ScreenRec — ${label}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `ScreenRec — ${label}`, enabled: false },
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
    { label: 'Open recordings folder', click: openOutputDir },
    { type: 'separator' },
    { label: 'Exit', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
}

function showPanel() {
  if (!controlWindow) createControlWindow();
  else { controlWindow.show(); controlWindow.focus(); }
}

function openOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  shell.openPath(OUTPUT_DIR);
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
    const ok = globalShortcut.register(combo, () => send('hotkey', action));
    if (!ok) console.warn(`Hotkey unavailable (already taken): ${combo}`);
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
        // workArea already excludes the taskbar, which is exactly what
        // "full screen without taskbar" needs — no guessing at its height.
        metrics = { bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor };
      }

      return { id: s.id, name: s.name, displayId: s.display_id || null, kind, metrics };
    });
});

ipcMain.handle('region:select', async (_e, displayId) => openRegionOverlay(displayId));

ipcMain.handle('settings:get', async () => readSettings());
ipcMain.handle('settings:set', async (_e, patch) => writeSettings(patch));

ipcMain.handle('file:begin', async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  currentPath = path.join(OUTPUT_DIR, `recording-${stamp}.webm`);
  writeStream = fs.createWriteStream(currentPath);
  bytesWritten = 0;
  return { path: currentPath };
});

ipcMain.handle('file:chunk', async (_e, arrayBuffer) => {
  if (!writeStream) return { ok: false };
  const buf = Buffer.from(arrayBuffer);
  bytesWritten += buf.length;
  await new Promise((res, rej) =>
    writeStream.write(buf, (err) => (err ? rej(err) : res()))
  );
  return { ok: true, bytes: bytesWritten };
});

ipcMain.handle('file:end', async (_e, { toMp4 }) => {
  if (!writeStream) return { path: null };
  await new Promise((res) => writeStream.end(res));
  writeStream = null;

  const webmPath = currentPath;
  currentPath = null;

  if (!toMp4) return { path: webmPath, converted: false };

  try {
    const mp4Path = webmPath.replace(/\.webm$/, '.mp4');
    await convertToMp4(webmPath, mp4Path);
    fs.unlinkSync(webmPath);
    return { path: mp4Path, converted: true };
  } catch (err) {
    console.error('MP4 conversion failed:', err);
    return { path: webmPath, converted: false, error: String(err.message || err) };
  }
});

ipcMain.handle('file:reveal', async (_e, filePath) => {
  if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
  else openOutputDir();
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
    } catch { /* Windows-only decoration; never fatal */ }
  }
});

// While recording, the panel shrinks to a small timecode bar and moves to a
// corner — a full settings dialog left open would end up inside the video.
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
ipcMain.handle('app:outputDir', () => OUTPUT_DIR);

ipcMain.on('region:cancel', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
});

/* ------------------------------------------------------------------ */
/* ffmpeg                                                              */
/* ------------------------------------------------------------------ */

function ffmpegPath() {
  try {
    return require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
  } catch {
    return null;
  }
}

function convertToMp4(input, output) {
  return new Promise((resolve, reject) => {
    const bin = ffmpegPath();
    if (!bin || !fs.existsSync(bin)) {
      return reject(new Error('ffmpeg not found; keeping .webm'));
    }
    const args = [
      '-y', '-i', input,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      output
    ];
    const proc = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      const m = /time=(\d+):(\d+):(\d+)/.exec(stderr.slice(-400));
      if (m) send('convert:progress', `${m[1]}:${m[2]}:${m[3]}`);
    });
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`ffmpeg exited ${code}`))
    );
  });
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

// A listener here stops Electron's default quit-on-last-window,
// which is what keeps the tray icon and hotkeys alive.
app.on('window-all-closed', () => {});
app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
