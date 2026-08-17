'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listSources: () => ipcRenderer.invoke('sources:list'),
  selectRegion: (displayId) => ipcRenderer.invoke('region:select', displayId),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  beginFile: () => ipcRenderer.invoke('file:begin'),
  writeChunk: (arrayBuffer) => ipcRenderer.invoke('file:chunk', arrayBuffer),
  endFile: (opts) => ipcRenderer.invoke('file:end', opts),
  reveal: (filePath) => ipcRenderer.invoke('file:reveal', filePath),
  play: (filePath) => ipcRenderer.invoke('file:play', filePath),
  outputDir: () => ipcRenderer.invoke('app:outputDir'),

  setState: (state) => ipcRenderer.invoke('state:set', state),
  setCompact: (compact) => ipcRenderer.invoke('window:compact', compact),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  hide: () => ipcRenderer.invoke('window:hide'),

  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, action) => cb(action)),
  onConvertProgress: (cb) => ipcRenderer.on('convert:progress', (_e, t) => cb(t)),

  // Region overlay only.
  sendRegion: (rect) => ipcRenderer.send('region:result', rect),
  cancelRegion: () => ipcRenderer.send('region:cancel')
});
