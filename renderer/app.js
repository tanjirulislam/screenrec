'use strict';

const $ = (id) => document.getElementById(id);

const el = {
  views: { setup: $('view-setup'), recording: $('view-recording'), busy: $('view-busy') },
  windowSource: $('window-source'), screenSource: $('screen-source'),
  fixedSize: $('fixed-size'), repeatDetail: $('repeat-detail'),
  repeatWrap: $('mode-repeat-wrap'),
  sysAudio: $('sys-audio'), micAudio: $('mic-audio'), micDevice: $('mic-device'),
  camOn: $('cam-on'), camDevice: $('cam-device'), camCorner: $('cam-corner'),
  fps: $('fps'), quality: $('quality'), toMp4: $('to-mp4'),
  optionsGroup: $('options-group'), optionsToggle: $('options-toggle'),
  pathNote: $('path-note'),
  recordBtn: $('btn-record'), folderBtn: $('btn-folder'),
  pauseBtn: $('btn-pause'), stopBtn: $('btn-stop'),
  tally: $('tally'), timecode: $('timecode'), filesize: $('filesize'),
  busyText: $('busy-text'), hint: $('hint'), meter: $('meter'),
  stage: $('stage'), screenVideo: $('screen-video'), camVideo: $('cam-video')
};

const state = {
  mode: 'idle',        // idle | recording | paused
  sources: [],
  lastRegion: null,    // {x, y, w, h} fractions
  recorder: null,
  streams: [],
  audioCtx: null,
  analyser: null,
  rafDraw: 0,
  rafMeter: 0,
  startedAt: 0,
  pausedMs: 0,
  pauseStartedAt: 0,
  tick: 0,
  outPath: null
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
      screens.length > 1 ? `Screen ${i + 1} — ${s.name}` : s.name, s.id
    ))
  );

  el.windowSource.innerHTML = '';
  if (!windows.length) {
    el.windowSource.appendChild(new Option('No open windows found', ''));
  } else {
    windows.forEach((w) => el.windowSource.appendChild(new Option(w.name, w.id)));
  }

  if (keepScreen && screens.some((s) => s.id === keepScreen)) el.screenSource.value = keepScreen;
  if (keepWindow && windows.some((w) => w.id === keepWindow)) el.windowSource.value = keepWindow;
}

async function loadDevices() {
  let devices = await navigator.mediaDevices.enumerateDevices();

  // Labels are blank until permission has been granted once.
  if (devices.some((d) => d.kind === 'audioinput' && !d.label)) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch { /* no mic or permission declined — list stays generic */ }
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
    select.appendChild(new Option(d.label || `${fallback} ${i + 1}`, d.deviceId))
  );
  if (keep && devices.some((d) => d.deviceId === keep)) select.value = keep;
}

function currentMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : 'full';
}

function sourceFor(id) {
  return state.sources.find((s) => s.id === id) || null;
}

/* ------------------------------------------------------------------ */
/* Crop resolution                                                     */
/* ------------------------------------------------------------------ */

/**
 * Turns the selected mode into a crop rectangle in source-frame pixels.
 * Everything is computed from fractions so Windows display scaling
 * never enters the arithmetic.
 */
function resolveCrop(mode, source, frameW, frameH) {
  const whole = { x: 0, y: 0, w: frameW, h: frameH };

  if (mode === 'full' || mode === 'window') return whole;

  if (mode === 'notaskbar') {
    const m = source && source.metrics;
    if (!m) return whole;
    // workArea is the desktop minus the taskbar, whatever size or edge it is.
    const fx = (m.workArea.x - m.bounds.x) / m.bounds.width;
    const fy = (m.workArea.y - m.bounds.y) / m.bounds.height;
    const fw = m.workArea.width / m.bounds.width;
    const fh = m.workArea.height / m.bounds.height;
    return {
      x: Math.round(fx * frameW),
      y: Math.round(fy * frameH),
      w: Math.round(fw * frameW),
      h: Math.round(fh * frameH)
    };
  }

  if (mode === 'fixed') {
    const [w, h] = el.fixedSize.value.split('x').map(Number);
    const cw = Math.min(w, frameW);
    const ch = Math.min(h, frameH);
    return {
      x: Math.round((frameW - cw) / 2),
      y: Math.round((frameH - ch) / 2),
      w: cw,
      h: ch
    };
  }

  if (mode === 'region' || mode === 'repeat') {
    const r = state.lastRegion;
    if (!r) return whole;
    return {
      x: Math.round(r.x * frameW),
      y: Math.round(r.y * frameH),
      w: Math.round(r.w * frameW),
      h: Math.round(r.h * frameH)
    };
  }

  return whole;
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

async function startRecording() {
  if (state.mode !== 'idle') return;
  setHint('');

  const mode = currentMode();
  const sourceId = mode === 'window' ? el.windowSource.value : el.screenSource.value;

  if (!sourceId) {
    return setHint(mode === 'window'
      ? 'Choose a window to record.'
      : 'Choose a screen to record.', true);
  }

  // Rectangular Region asks for the area first; the panel hides while you drag.
  if (mode === 'region') {
    const src = sourceFor(sourceId);
    const rect = await window.api.selectRegion(src ? src.displayId : null);
    if (!rect) return setHint('Region selection cancelled.');
    state.lastRegion = rect;
    await window.api.setSettings({ lastRegion: rect });
    updateRepeatLabel();
  }

  if (mode === 'repeat' && !state.lastRegion) {
    return setHint('No previous region yet — pick Rectangular Region first.', true);
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
          echoCancellation: false,
          noiseSuppression: true
        }
      });
      state.streams.push(micStream);
    }

    // Crop and webcam overlay both happen in one canvas pass, and that
    // canvas is what actually gets recorded.
    const frameW = el.screenVideo.videoWidth;
    const frameH = el.screenVideo.videoHeight;
    const crop = resolveCrop(mode, sourceFor(sourceId), frameW, frameH);

    crop.w -= crop.w % 2;   // H.264 rejects odd dimensions
    crop.h -= crop.h % 2;

    if (crop.w < 2 || crop.h < 2) throw new Error('The selected area is too small.');

    el.stage.width = crop.w;
    el.stage.height = crop.h;
    const ctx = el.stage.getContext('2d', { alpha: false, desynchronized: true });

    const draw = () => {
      ctx.drawImage(el.screenVideo, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
      if (camStream) drawCamera(ctx, crop);
      state.rafDraw = requestAnimationFrame(draw);
    };
    draw();

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
        gain.gain.value = 1.0; // raise this if your mic sits too low in the mix
        n.connect(gain); gain.connect(dest); gain.connect(analyser);
      }

      state.audioCtx = ac;
      state.analyser = analyser;
      audioTracks.push(...dest.stream.getAudioTracks());
      runMeter();
    }

    if (wantSystemAudio && !screenStream.getAudioTracks().length) {
      setHint('Computer sound unavailable for this source — recording video only.', true);
    }

    const mixed = new MediaStream([
      el.stage.captureStream(fps).getVideoTracks()[0],
      ...audioTracks
    ]);

    const recorder = new MediaRecorder(mixed, {
      mimeType: pickMimeType(),
      videoBitsPerSecond: Number(el.quality.value),
      audioBitsPerSecond: 160000
    });

    const { path } = await window.api.beginFile();
    state.outPath = path;

    recorder.ondataavailable = async (e) => {
      if (!e.data || !e.data.size) return;
      const buf = await e.data.arrayBuffer();
      const res = await window.api.writeChunk(buf);
      if (res && res.bytes) el.filesize.textContent = formatBytes(res.bytes);
    };

    recorder.onerror = (ev) =>
      setHint(`Recorder error: ${(ev.error && ev.error.name) || 'unknown'}`, true);

    // If a recorded window closes mid-take, wrap up cleanly instead of hanging.
    screenStream.getVideoTracks()[0].addEventListener('ended', () => {
      if (state.mode !== 'idle') stopRecording();
    });

    state.recorder = recorder;
    recorder.start(2000); // flush to disk every 2 seconds

    state.startedAt = Date.now();
    state.pausedMs = 0;
    el.filesize.textContent = '';
    setMode('recording');
    startClock();
  } catch (err) {
    console.error(err);
    setHint(friendlyError(err), true);
    await cleanup();
    setMode('idle');
  }
}

function drawCamera(ctx, crop) {
  const size = Math.round(Math.min(crop.w, crop.h) * 0.22);
  const pad = Math.round(size * 0.14);
  const corner = el.camCorner.value;
  const x = corner.endsWith('l') ? pad : crop.w - size - pad;
  const y = corner.startsWith('t') ? pad : crop.h - size - pad;

  const vw = el.camVideo.videoWidth;
  const vh = el.camVideo.videoHeight;
  if (!vw || !vh) return;

  // Center-crop to a square before masking to a circle.
  const side = Math.min(vw, vh);
  const sx = (vw - side) / 2;
  const sy = (vh - side) / 2;

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
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm'
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';
}

function togglePause() {
  if (state.mode === 'recording') {
    state.recorder.pause();
    state.pauseStartedAt = Date.now();
    setMode('paused');
  } else if (state.mode === 'paused') {
    state.recorder.resume();
    state.pausedMs += Date.now() - state.pauseStartedAt;
    setMode('recording');
  }
}

async function stopRecording() {
  if (state.mode === 'idle' || !state.recorder) return;

  const recorder = state.recorder;
  const finished = new Promise((res) =>
    recorder.addEventListener('stop', res, { once: true }));
  recorder.stop();
  await finished;

  await cleanup();
  showView('busy');
  el.busyText.textContent = el.toMp4.checked ? 'Converting to MP4…' : 'Saving…';

  const result = await window.api.endFile({ toMp4: el.toMp4.checked });
  state.outPath = result.path;

  setMode('idle');

  if (!result.path) setHint('Nothing was recorded.', true);
  else if (result.error) setHint(`Saved as WebM — ${result.error}`, true);
  else setHint(`Saved ${result.path.split(/[\\/]/).pop()}`);

  el.timecode.textContent = '00:00:00';
  el.filesize.textContent = '';
}

async function cleanup() {
  cancelAnimationFrame(state.rafDraw);
  cancelAnimationFrame(state.rafMeter);
  clearInterval(state.tick);

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
/* Views and readout                                                   */
/* ------------------------------------------------------------------ */

function showView(name) {
  Object.entries(el.views).forEach(([key, node]) => { node.hidden = key !== name; });
}

function setMode(mode) {
  state.mode = mode;
  window.api.setState(mode);

  const active = mode !== 'idle';
  showView(active ? 'recording' : 'setup');
  window.api.setCompact(active);

  el.tally.classList.toggle('paused', mode === 'paused');
  el.pauseBtn.textContent = mode === 'paused' ? 'Resume' : 'Pause';
}

function startClock() {
  clearInterval(state.tick);
  state.tick = setInterval(() => {
    if (state.mode !== 'recording') return;
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
      bar.style.height = `${2 + level * 10}px`;
      bar.className = level > 0.75 ? 'peak' : level > 0.05 ? 'on' : '';
    });
    state.rafMeter = requestAnimationFrame(loop);
  };
  loop();
}

function resetMeter() {
  bars.forEach((b) => { b.style.height = '2px'; b.className = ''; });
}

function setHint(text, isError = false) {
  el.hint.textContent = text || DEFAULT_HINT;
  el.hint.classList.toggle('error', Boolean(text) && isError);
}

function friendlyError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError') return 'Windows blocked the capture. Check privacy settings.';
  if (name === 'NotFoundError') return 'That window closed. Reopen the list and try again.';
  if (name === 'NotReadableError') return 'Another app is using that camera or microphone.';
  return (err && err.message) || 'Could not start the recording.';
}

function waitForFrame(video) {
  return new Promise((resolve) => {
    if (video.videoWidth) return resolve();
    video.addEventListener('loadedmetadata', resolve, { once: true });
  });
}

function updateRepeatLabel() {
  const r = state.lastRegion;
  el.repeatDetail.textContent = r ? `${Math.round(r.w * 100)}% × ${Math.round(r.h * 100)}%` : '';
  el.repeatWrap.querySelector('input').disabled = !r;
  el.repeatWrap.style.opacity = r ? '1' : '0.45';
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function syncEnabled() {
  const mode = currentMode();
  el.windowSource.disabled = mode !== 'window';
  el.fixedSize.disabled = mode !== 'fixed';
  el.screenSource.disabled = mode === 'window';
  el.micDevice.disabled = !el.micAudio.checked;
  el.camDevice.disabled = !el.camOn.checked;
  el.camCorner.disabled = !el.camOn.checked;
}

function savePrefs() {
  window.api.setSettings({
    mode: currentMode(),
    fixedSize: el.fixedSize.value,
    sysAudio: el.sysAudio.checked,
    micAudio: el.micAudio.checked,
    camOn: el.camOn.checked,
    camCorner: el.camCorner.value,
    fps: el.fps.value,
    quality: el.quality.value,
    toMp4: el.toMp4.checked
  });
}

document.querySelectorAll('input[name="mode"]').forEach((r) =>
  r.addEventListener('change', async () => {
    syncEnabled();
    savePrefs();
    setHint('');
    // Windows open and close constantly, so refresh the list on entry.
    if (currentMode() === 'window') await loadSources();
  }));

[el.sysAudio, el.micAudio, el.camOn, el.camCorner, el.fps, el.quality, el.toMp4, el.fixedSize]
  .forEach((c) => c.addEventListener('change', () => { syncEnabled(); savePrefs(); }));

el.recordBtn.addEventListener('click', startRecording);
el.stopBtn.addEventListener('click', stopRecording);
el.pauseBtn.addEventListener('click', togglePause);
el.folderBtn.addEventListener('click', () => window.api.reveal(state.outPath));

el.optionsToggle.addEventListener('click', () => {
  const open = el.optionsGroup.classList.toggle('collapsed') === false;
  el.optionsToggle.setAttribute('aria-expanded', String(open));
});

$('btn-min').addEventListener('click', () => window.api.minimize());
$('btn-hide').addEventListener('click', () => window.api.hide());

window.api.onHotkey((action) => {
  if (action === 'toggle') state.mode === 'idle' ? startRecording() : stopRecording();
  else if (action === 'pause') togglePause();
  else if (action === 'stop') stopRecording();
});

window.api.onConvertProgress((t) => { el.busyText.textContent = `Converting to MP4… ${t}`; });

navigator.mediaDevices.addEventListener('devicechange', loadDevices);

(async function init() {
  await loadSources();
  await loadDevices();

  const saved = await window.api.getSettings();
  state.lastRegion = saved.lastRegion || null;

  const radio = document.querySelector(`input[name="mode"][value="${saved.mode}"]`);
  if (radio && !(saved.mode === 'repeat' && !state.lastRegion)) radio.checked = true;

  if (saved.fixedSize) el.fixedSize.value = saved.fixedSize;
  if (saved.camCorner) el.camCorner.value = saved.camCorner;
  if (saved.fps) el.fps.value = saved.fps;
  if (saved.quality) el.quality.value = saved.quality;
  if (typeof saved.sysAudio === 'boolean') el.sysAudio.checked = saved.sysAudio;
  if (typeof saved.micAudio === 'boolean') el.micAudio.checked = saved.micAudio;
  if (typeof saved.camOn === 'boolean') el.camOn.checked = saved.camOn;
  if (typeof saved.toMp4 === 'boolean') el.toMp4.checked = saved.toMp4;

  el.pathNote.textContent = `Saving to ${await window.api.outputDir()}`;

  updateRepeatLabel();
  syncEnabled();
  setMode('idle');
  setHint('');
})();
