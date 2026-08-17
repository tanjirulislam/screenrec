'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  views: {
    setup: $('view-setup'), countdown: $('view-countdown'),
    recording: $('view-recording'), busy: $('view-busy')
  },
  modes: $('modes'), nav: $('nav'),
  modeTitle: $('mode-title'), modeDesc: $('mode-desc'), summary: $('summary'),
  panelScreen: $('panel-screen'), panelWindow: $('panel-window'),
  panelFixed: $('panel-fixed'), panelRegion: $('panel-region'),
  screenSource: $('screen-source'), windowSource: $('window-source'),
  refreshWindows: $('btn-refresh-windows'),
  fixedSize: $('fixed-size'), regionInfo: $('region-info'), pickArea: $('btn-pick-area'),
  sysAudio: $('sys-audio'), micAudio: $('mic-audio'), micDevice: $('mic-device'),
  camOn: $('cam-on'), camDevice: $('cam-device'), camCorner: $('cam-corner'),
  format: $('format'), formatNote: $('format-note'), fps: $('fps'), quality: $('quality'),
  countdownOn: $('countdown'), showBorder: $('show-border'),
  savePath: $('save-path'), chooseFolder: $('btn-choose-folder'),
  openFolder: $('btn-open-folder'), folderBtn: $('btn-folder'),
  recordBtn: $('btn-record'), pauseBtn: $('btn-pause'), stopBtn: $('btn-stop'),
  countNumber: $('count-number'), cancelCount: $('btn-cancel-count'),
  tally: $('tally'), timecode: $('timecode'), filesize: $('filesize'),
  busyText: $('busy-text'), busySub: $('busy-sub'),
  statusDot: $('status-dot'), statusAction: $('btn-status-action'),
  hint: $('hint'), meter: $('meter'),
  stage: $('stage'), screenVideo: $('screen-video'), camVideo: $('cam-video')
};

const MODES = {
  full:      { title: 'Full screen',            desc: 'Records everything on the screen you choose.' },
  notaskbar: { title: 'Screen without taskbar', desc: 'Everything except the bar along the edge of the screen.' },
  region:    { title: 'Selected area',          desc: 'Drag a box around the part you want to record.' },
  fixed:     { title: 'Fixed size',             desc: 'A preset box in the middle of the screen.' },
  window:    { title: 'Single window',          desc: 'One application only. Other windows in front of it are not captured.' },
  repeat:    { title: 'Last area',              desc: 'The same box you drew last time, remembered between sessions.' }
};

const state = {
  mode: 'full',
  status: 'idle',
  sources: [],
  lastRegion: null,
  recorder: null,
  streams: [],
  audioCtx: null,
  analyser: null,
  drawTimer: 0,
  rafMeter: 0,
  countTimer: 0,
  countCancelled: false,
  startedAt: 0,
  pausedMs: 0,
  pauseStartedAt: 0,
  tick: 0,
  outPath: null,
  borderShown: false,
  writeQueue: Promise.resolve(),
  writeFailed: null
};

const DEFAULT_HINT = 'Press Ctrl+Shift+R anywhere to start or stop';

/* ------------------------------------------------------------------ */
/* Sources and devices                                                 */
/* ------------------------------------------------------------------ */

async function loadSources() {
  state.sources = await window.api.listSources();

  const screens = state.sources.filter((s) => s.kind === 'screen');
  const windows = state.sources.filter((s) => s.kind === 'window');

  const keepScreen = el.screenSource.value;
  const keepWindow = el.windowSource.value;

  el.screenSource.innerHTML = '';
  screens.forEach((s, i) =>
    el.screenSource.appendChild(new Option(
      screens.length > 1 ? `Screen ${i + 1}, ${s.name}` : s.name, s.id)));

  el.windowSource.innerHTML = '';
  if (!windows.length) el.windowSource.appendChild(new Option('No open windows found', ''));
  else windows.forEach((w) => el.windowSource.appendChild(new Option(w.name, w.id)));

  if (keepScreen && screens.some((s) => s.id === keepScreen)) el.screenSource.value = keepScreen;
  if (keepWindow && windows.some((w) => w.id === keepWindow)) el.windowSource.value = keepWindow;
}

async function loadDevices() {
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.some((d) => d.kind === 'audioinput' && !d.label)) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch { /* no mic, or permission declined */ }
  }
  fill(el.micDevice, devices.filter((d) => d.kind === 'audioinput'), 'Microphone');
  fill(el.camDevice, devices.filter((d) => d.kind === 'videoinput'), 'Camera');
}

function fill(select, devices, fallback) {
  const keep = select.value;
  select.innerHTML = '';
  if (!devices.length) {
    select.appendChild(new Option(`No ${fallback.toLowerCase()} found`, ''));
    return;
  }
  devices.forEach((d, i) =>
    select.appendChild(new Option(d.label || `${fallback} ${i + 1}`, d.deviceId)));
  if (keep && devices.some((d) => d.deviceId === keep)) select.value = keep;
}

const sourceFor = (id) => state.sources.find((s) => s.id === id) || null;
const activeSourceId = () =>
  state.mode === 'window' ? el.windowSource.value : el.screenSource.value;

/* ------------------------------------------------------------------ */
/* Crop                                                                */
/* ------------------------------------------------------------------ */

function resolveCrop(mode, source, frameW, frameH) {
  const whole = { x: 0, y: 0, w: frameW, h: frameH };
  if (mode === 'full' || mode === 'window') return whole;

  if (mode === 'notaskbar') {
    const m = source && source.metrics;
    if (!m) return whole;
    // workArea is the desktop minus the taskbar, wherever it sits.
    return {
      x: Math.round(((m.workArea.x - m.bounds.x) / m.bounds.width) * frameW),
      y: Math.round(((m.workArea.y - m.bounds.y) / m.bounds.height) * frameH),
      w: Math.round((m.workArea.width / m.bounds.width) * frameW),
      h: Math.round((m.workArea.height / m.bounds.height) * frameH)
    };
  }

  if (mode === 'fixed') {
    const [w, h] = el.fixedSize.value.split('x').map(Number);
    const cw = Math.min(w, frameW);
    const ch = Math.min(h, frameH);
    return { x: Math.round((frameW - cw) / 2), y: Math.round((frameH - ch) / 2), w: cw, h: ch };
  }

  if (mode === 'region' || mode === 'repeat') {
    const r = state.lastRegion;
    if (!r) return whole;
    return {
      x: Math.round(r.x * frameW), y: Math.round(r.y * frameH),
      w: Math.round(r.w * frameW), h: Math.round(r.h * frameH)
    };
  }
  return whole;
}

function cropAsRegion(mode, source, frameW, frameH) {
  if (mode === 'window') return null;
  const c = resolveCrop(mode, source, frameW, frameH);
  if (c.x === 0 && c.y === 0 && c.w === frameW && c.h === frameH) return null;
  return { x: c.x / frameW, y: c.y / frameH, w: c.w / frameW, h: c.h / frameH };
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

function runCountdown(seconds) {
  return new Promise((resolve) => {
    state.countCancelled = false;
    let n = seconds;
    el.countNumber.textContent = String(n);
    showView('countdown');

    state.countTimer = setInterval(() => {
      if (state.countCancelled) { clearInterval(state.countTimer); return resolve(false); }
      n -= 1;
      if (n <= 0) { clearInterval(state.countTimer); return resolve(true); }
      el.countNumber.textContent = String(n);
    }, 1000);
  });
}

async function startRecording() {
  if (state.status !== 'idle') return;
  setHint('');

  const mode = state.mode;
  const sourceId = activeSourceId();

  if (!sourceId) {
    return setHint(mode === 'window' ? 'Choose a window to record.' : 'Choose a screen to record.', true);
  }

  if (mode === 'region') {
    const ok = await pickArea();
    if (!ok) return;
  }

  if (mode === 'repeat' && !state.lastRegion) {
    return setHint('No saved area yet, use Select area once first.', true);
  }

  if (el.countdownOn.checked) {
    const proceed = await runCountdown(3);
    if (!proceed) { showView('setup'); return setHint('Cancelled.'); }
  }

  const fps = Number(el.fps.value);

  try {
    const wantSystemAudio = el.sysAudio.checked;

    const screenStream = await navigator.mediaDevices.getUserMedia({
      audio: wantSystemAudio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxFrameRate: fps
        }
      }
    });
    state.streams.push(screenStream);

    el.screenVideo.srcObject = screenStream;
    await el.screenVideo.play();
    await waitForFrame(el.screenVideo);

    let camStream = null;
    if (el.camOn.checked) {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: el.camDevice.value ? { exact: el.camDevice.value } : undefined,
          width: { ideal: 640 }, height: { ideal: 480 }
        }
      });
      state.streams.push(camStream);
      el.camVideo.srcObject = camStream;
      await el.camVideo.play();
    }

    let micStream = null;
    if (el.micAudio.checked) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: el.micDevice.value ? { exact: el.micDevice.value } : undefined,
          echoCancellation: false, noiseSuppression: true
        }
      });
      state.streams.push(micStream);
    }

    const frameW = el.screenVideo.videoWidth;
    const frameH = el.screenVideo.videoHeight;
    const source = sourceFor(sourceId);
    const crop = resolveCrop(mode, source, frameW, frameH);

    crop.w -= crop.w % 2;   // H.264 rejects odd dimensions
    crop.h -= crop.h % 2;
    if (crop.w < 2 || crop.h < 2) throw new Error('The selected area is too small.');

    el.stage.width = crop.w;
    el.stage.height = crop.h;
    const ctx = el.stage.getContext('2d', { alpha: false, desynchronized: true });

    // captureStream(0) captures only frames we explicitly request, so this
    // fixed-rate timer drives the video timeline. requestAnimationFrame was
    // the old approach: it stalls whenever the window is covered, which
    // starved the recording of frames and made playback run in slow motion.
    const canvasStream = el.stage.captureStream(0);
    const videoTrack = canvasStream.getVideoTracks()[0];

    const drawFrame = () => {
      ctx.drawImage(el.screenVideo, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
      if (camStream) drawCamera(ctx, crop);
      if (videoTrack.requestFrame) videoTrack.requestFrame();
    };

    drawFrame();
    state.drawTimer = setInterval(drawFrame, Math.round(1000 / fps));

    const audioTracks = [];
    if (wantSystemAudio || micStream) {
      const ac = new AudioContext();
      const dest = ac.createMediaStreamDestination();
      const analyser = ac.createAnalyser();
      analyser.fftSize = 512;

      if (wantSystemAudio && screenStream.getAudioTracks().length) {
        const n = ac.createMediaStreamSource(new MediaStream(screenStream.getAudioTracks()));
        n.connect(dest); n.connect(analyser);
      }
      if (micStream) {
        const n = ac.createMediaStreamSource(micStream);
        const gain = ac.createGain();
        gain.gain.value = 1.0;
        n.connect(gain); gain.connect(dest); gain.connect(analyser);
      }

      state.audioCtx = ac;
      state.analyser = analyser;
      audioTracks.push(...dest.stream.getAudioTracks());
      runMeter();
    }

    if (wantSystemAudio && !screenStream.getAudioTracks().length) {
      setHint('Computer sound is unavailable for this source, recording video only.', true);
    }

    const recorder = new MediaRecorder(new MediaStream([videoTrack, ...audioTracks]), {
      mimeType: pickMimeType(),
      videoBitsPerSecond: Number(el.quality.value),
      audioBitsPerSecond: 128000
    });

    const { path } = await window.api.beginFile();
    state.outPath = path;

    // Chunks must reach disk in the order MediaRecorder emits them. The
    // handler is deliberately synchronous: it appends to a promise chain
    // rather than awaiting, so two chunks can never be in flight at once.
    state.writeQueue = Promise.resolve();
    state.writeFailed = null;

    recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const blob = e.data;
      state.writeQueue = state.writeQueue.then(async () => {
        if (state.writeFailed) return;
        const buf = await blob.arrayBuffer();
        const res = await window.api.writeChunk(buf);
        if (res && res.bytes) el.filesize.textContent = formatBytes(res.bytes);
      }).catch((err) => {
        state.writeFailed = err;
        console.error('Chunk write failed:', err);
      });
    };

    recorder.onerror = (ev) =>
      setHint(`Recorder error: ${(ev.error && ev.error.name) || 'unknown'}`, true);

    screenStream.getVideoTracks()[0].addEventListener('ended', () => {
      if (state.status !== 'idle') stopRecording();
    });

    state.recorder = recorder;
    recorder.start(2000);

    if (el.showBorder.checked && source) {
      window.api.showBorder({
        displayId: source.displayId,
        region: cropAsRegion(mode, source, frameW, frameH)
      });
      state.borderShown = true;
    }

    state.startedAt = Date.now();
    state.pausedMs = 0;
    el.filesize.textContent = '';
    el.timecode.textContent = '00:00:00';
    setStatus('recording');
    startClock();
  } catch (err) {
    console.error(err);
    setHint(friendlyError(err), true);
    await cleanup();
    setStatus('idle');
    showView('setup');
  }
}

function drawCamera(ctx, crop) {
  const size = Math.round(Math.min(crop.w, crop.h) * 0.22);
  const pad = Math.round(size * 0.14);
  const corner = el.camCorner.value;
  const x = corner.endsWith('l') ? pad : crop.w - size - pad;
  const y = corner.startsWith('t') ? pad : crop.h - size - pad;

  const vw = el.camVideo.videoWidth, vh = el.camVideo.videoHeight;
  if (!vw || !vh) return;

  const side = Math.min(vw, vh);
  const sx = (vw - side) / 2, sy = (vh - side) / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(el.camVideo, sx, sy, side, side, x, y, size, size);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = Math.max(2, size * 0.012);
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function pickMimeType() {
  return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';
}

function togglePause() {
  if (state.status === 'recording') {
    state.recorder.pause();
    clearInterval(state.drawTimer);          // stop feeding frames while paused
    state.pauseStartedAt = Date.now();
    setStatus('paused');
  } else if (state.status === 'paused') {
    state.recorder.resume();
    state.pausedMs += Date.now() - state.pauseStartedAt;
    setStatus('recording');
  }
}

async function stopRecording() {
  if (state.status === 'idle' || !state.recorder) return;

  const recorder = state.recorder;
  const finished = new Promise((res) => recorder.addEventListener('stop', res, { once: true }));
  if (recorder.state === 'paused') recorder.resume();
  recorder.stop();
  await finished;

  showView('busy');
  el.busyText.textContent = 'Saving';
  el.busySub.textContent = 'Writing the last few seconds';

  await cleanup();

  // Every queued chunk has to land before the file is closed.
  try { await state.writeQueue; } catch { /* recorded below */ }

  const format = el.format.value;
  el.busyText.textContent = format === 'mp4' ? 'Converting to MP4' : 'Finishing';
  el.busySub.textContent = format === 'mp4'
    ? 'This takes about as long as the recording'
    : 'Just a moment';

  const result = await window.api.endFile({ format, fps: Number(el.fps.value) });
  state.outPath = result.path;

  state.status = 'idle';
  window.api.setState('idle');
  window.api.setCompact(false);
  showView('setup');

  if (!result.path) return setStatusBar('Nothing was recorded.', 'error');
  if (state.writeFailed) return setStatusBar('Recording saved, but some data was dropped.', 'error');
  if (result.warning) return setStatusBar(result.warning, 'error');

  setStatusBar(`Saved ${result.path.split(/[\\/]/).pop()}`, 'ok');
}

async function cleanup() {
  clearInterval(state.drawTimer);
  clearInterval(state.tick);
  cancelAnimationFrame(state.rafMeter);

  if (state.borderShown) { window.api.hideBorder(); state.borderShown = false; }

  state.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  state.streams = [];

  if (state.audioCtx) { try { await state.audioCtx.close(); } catch {} }
  state.audioCtx = null;
  state.analyser = null;
  state.recorder = null;

  el.screenVideo.srcObject = null;
  el.camVideo.srcObject = null;
  resetMeter();
}

/* ------------------------------------------------------------------ */
/* Views and state                                                     */
/* ------------------------------------------------------------------ */

function showView(name) {
  Object.entries(el.views).forEach(([key, node]) => { node.hidden = key !== name; });
}

function setStatus(status) {
  state.status = status;
  window.api.setState(status);

  const active = status !== 'idle';
  if (active) showView('recording');
  window.api.setCompact(active);

  el.tally.classList.toggle('paused', status === 'paused');
  el.pauseBtn.textContent = status === 'paused' ? 'Resume' : 'Pause';
}

function startClock() {
  clearInterval(state.tick);
  state.tick = setInterval(() => {
    if (state.status !== 'recording') return;
    el.timecode.textContent = formatClock(Date.now() - state.startedAt - state.pausedMs);
  }, 250);
}

function formatClock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)}`;
}

function formatBytes(b) {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

const bars = [...el.meter.children];

function runMeter() {
  const data = new Uint8Array(state.analyser.frequencyBinCount);
  const loop = () => {
    state.analyser.getByteFrequencyData(data);
    const step = Math.floor(data.length / bars.length);
    bars.forEach((bar, i) => {
      let sum = 0;
      for (let j = i * step; j < (i + 1) * step; j++) sum += data[j];
      const level = sum / step / 255;
      bar.style.height = `${2 + level * 11}px`;
      bar.className = level > 0.75 ? 'peak' : level > 0.05 ? 'on' : '';
    });
    state.rafMeter = requestAnimationFrame(loop);
  };
  loop();
}

const resetMeter = () => bars.forEach((b) => { b.style.height = '2px'; b.className = ''; });

function setStatusBar(text, kind) {
  el.hint.textContent = text || DEFAULT_HINT;
  const bar = el.hint.parentElement;
  bar.classList.toggle('error', kind === 'error');
  bar.classList.toggle('ok', kind === 'ok');
  el.statusDot.hidden = !kind;
  el.statusDot.className = `status-dot ${kind || ''}`;
  el.statusAction.hidden = !(kind && state.outPath);
}

const setHint = (text, isError) => setStatusBar(text, isError ? 'error' : null);

function friendlyError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError') return 'Windows blocked the capture. Check privacy settings.';
  if (name === 'NotFoundError') return 'That window closed. Refresh the list and try again.';
  if (name === 'NotReadableError') return 'Another app is using that camera or microphone.';
  return (err && err.message) || 'Could not start the recording.';
}

function waitForFrame(video) {
  return new Promise((resolve) => {
    if (video.videoWidth) return resolve();
    video.addEventListener('loadedmetadata', resolve, { once: true });
  });
}

/* ------------------------------------------------------------------ */
/* Mode, pages, summary                                                */
/* ------------------------------------------------------------------ */

async function setMode(mode) {
  state.mode = mode;

  el.modes.querySelectorAll('.mode').forEach((b) =>
    b.setAttribute('aria-checked', String(b.dataset.mode === mode)));

  el.modeTitle.textContent = MODES[mode].title;
  el.modeDesc.textContent = MODES[mode].desc;

  el.panelScreen.hidden = mode === 'window';
  el.panelWindow.hidden = mode !== 'window';
  el.panelFixed.hidden = mode !== 'fixed';
  el.panelRegion.hidden = !(mode === 'region' || mode === 'repeat');

  if (mode === 'window') await loadSources();

  savePrefs();
  updateSummary();
  setHint('');
}

function showPage(page) {
  el.nav.querySelectorAll('.nav-item[data-page]').forEach((b) =>
    b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach((p) =>
    p.classList.toggle('active', p.dataset.page === page));
}

function updateRegionLabel() {
  const r = state.lastRegion;
  el.regionInfo.textContent = r
    ? `Saved area, ${Math.round(r.w * 100)}% × ${Math.round(r.h * 100)}% of the screen`
    : 'No area chosen yet';
  const repeatBtn = el.modes.querySelector('.mode[data-mode="repeat"]');
  if (repeatBtn) repeatBtn.disabled = !r;
}

function updateSummary() {
  const parts = [];
  const sound = [];
  if (el.sysAudio.checked) sound.push('computer sound');
  if (el.micAudio.checked) sound.push('microphone');
  parts.push(sound.length ? `Sound: ${sound.join(' + ')}` : 'No sound');
  if (el.camOn.checked) parts.push('webcam overlay on');
  parts.push(`${el.fps.value} fps`);
  parts.push(el.format.value === 'mp4' ? 'MP4' : 'WebM');
  el.summary.textContent = parts.join(' · ');
}

function updateFormatNote() {
  el.formatNote.textContent = el.format.value === 'mp4'
    ? 'Converting takes roughly as long as the recording itself. Choose WebM if you want the file straight away.'
    : 'Saved the moment you stop. Plays in any browser, VLC, and most editors.';
}

async function pickArea() {
  const src = sourceFor(el.screenSource.value);
  const rect = await window.api.selectRegion(src ? src.displayId : null);
  if (!rect) { setHint('Area selection cancelled.'); return false; }
  state.lastRegion = rect;
  await window.api.setSettings({ lastRegion: rect });
  updateRegionLabel();
  setHint('');
  return true;
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function syncEnabled() {
  el.micDevice.disabled = !el.micAudio.checked;
  el.camDevice.disabled = !el.camOn.checked;
  el.camCorner.disabled = !el.camOn.checked;
}

function savePrefs() {
  window.api.setSettings({
    mode: state.mode,
    fixedSize: el.fixedSize.value,
    sysAudio: el.sysAudio.checked,
    micAudio: el.micAudio.checked,
    camOn: el.camOn.checked,
    camCorner: el.camCorner.value,
    format: el.format.value,
    fps: el.fps.value,
    quality: el.quality.value,
    countdown: el.countdownOn.checked,
    showBorder: el.showBorder.checked
  });
}

el.modes.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode');
  if (btn && !btn.disabled) setMode(btn.dataset.mode);
});

el.nav.addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item[data-page]');
  if (btn) showPage(btn.dataset.page);
});

[el.sysAudio, el.micAudio, el.camOn, el.camCorner, el.fps, el.quality, el.fixedSize,
 el.countdownOn, el.showBorder].forEach((c) =>
  c.addEventListener('change', () => { syncEnabled(); savePrefs(); updateSummary(); }));

el.format.addEventListener('change', () => { updateFormatNote(); savePrefs(); updateSummary(); });

el.pickArea.addEventListener('click', pickArea);
el.refreshWindows.addEventListener('click', loadSources);

el.chooseFolder.addEventListener('click', async () => {
  const res = await window.api.chooseFolder();
  if (!res) return;
  if (res.error) return setHint(res.error, true);
  el.savePath.textContent = res.path;
  el.savePath.title = res.path;
  setHint('');
});

el.recordBtn.addEventListener('click', startRecording);
el.stopBtn.addEventListener('click', stopRecording);
el.pauseBtn.addEventListener('click', togglePause);
el.cancelCount.addEventListener('click', () => { state.countCancelled = true; });

const openFolder = () => window.api.reveal(null);
el.openFolder.addEventListener('click', openFolder);
el.folderBtn.addEventListener('click', openFolder);

el.statusAction.addEventListener('click', () => window.api.reveal(state.outPath));

$('btn-min').addEventListener('click', () => window.api.minimize());
$('btn-hide').addEventListener('click', () => window.api.hide());

window.api.onHotkey((action) => {
  if (action === 'toggle') state.status === 'idle' ? startRecording() : stopRecording();
  else if (action === 'pause') togglePause();
  else if (action === 'stop') stopRecording();
});

window.api.onConvertProgress((p) => {
  el.busyText.textContent = p.label || 'Finishing';
  el.busySub.textContent = p.time || '';
});
navigator.mediaDevices.addEventListener('devicechange', loadDevices);

(async function init() {
  await loadSources();
  await loadDevices();

  const saved = await window.api.getSettings();
  state.lastRegion = saved.lastRegion || null;

  if (saved.fixedSize) el.fixedSize.value = saved.fixedSize;
  if (saved.camCorner) el.camCorner.value = saved.camCorner;
  if (saved.format) el.format.value = saved.format;
  if (saved.fps) el.fps.value = saved.fps;
  if (saved.quality) el.quality.value = saved.quality;
  if (typeof saved.sysAudio === 'boolean') el.sysAudio.checked = saved.sysAudio;
  if (typeof saved.micAudio === 'boolean') el.micAudio.checked = saved.micAudio;
  if (typeof saved.camOn === 'boolean') el.camOn.checked = saved.camOn;
  if (typeof saved.countdown === 'boolean') el.countdownOn.checked = saved.countdown;
  if (typeof saved.showBorder === 'boolean') el.showBorder.checked = saved.showBorder;

  el.savePath.textContent = saved.savePath || '';
  el.savePath.title = saved.savePath || '';

  updateRegionLabel();
  updateFormatNote();
  syncEnabled();

  const startMode = (saved.mode && MODES[saved.mode] && !(saved.mode === 'repeat' && !state.lastRegion))
    ? saved.mode : 'full';
  await setMode(startMode);

  showPage('record');
  showView('setup');
  setHint('');
})();
