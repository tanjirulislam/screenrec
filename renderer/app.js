'use strict';

const $ = (id) => document.getElementById(id);
const $$ = (s) => [...document.querySelectorAll(s)];

const el = {
  views: { setup: $('view-setup'), countdown: $('view-countdown'),
           recording: $('view-recording'), busy: $('view-busy') },
  modes: $('modes'), nav: $('nav'),
  mTitle: $('m-title'), mDesc: $('m-desc'),
  pvShot: $('pv-shot'), pvSize: $('pv-size'), pvDesc: $('pv-desc'),
  pScreen: $('p-screen'), pWindow: $('p-window'), pFixed: $('p-fixed'), pRegion: $('p-region'),
  screenSource: $('screen-source'), windowSource: $('window-source'), refresh: $('btn-refresh'),
  fixedSize: $('fixed-size'), regionInfo: $('region-info'), pickArea: $('btn-pick-area'),
  summary: $('summary'),
  format: $('format'), formatNote: $('format-note'), quality: $('quality'), fps: $('fps'),
  countdownOn: $('countdown'), showBorder: $('show-border'),
  sysAudio: $('sys-audio'), micAudio: $('mic-audio'), micDevice: $('mic-device'),
  camOn: $('cam-on'), camDevice: $('cam-device'), camCorner: $('cam-corner'), meter: $('meter'),
  sysVol: $('sys-vol'), sysVolOut: $('sys-vol-out'),
  micVol: $('mic-vol'), micVolOut: $('mic-vol-out'), ringSweep: $('ring-sweep'),
  savePath: $('save-path'), chooseFolder: $('btn-choose-folder'), openFolder: $('btn-open-folder'),
  folderBtn: $('btn-folder'), aboutVersion: $('about-version'),
  recordBtn: $('btn-record'), pauseBtn: $('btn-pause'), stopBtn: $('btn-stop'),
  countNumber: $('count-number'), cancelCount: $('btn-cancel-count'),
  tally: $('tally'), timecode: $('timecode'), filesize: $('filesize'),
  busyText: $('busy-text'), busySub: $('busy-sub'),
  statusbar: $('statusbar'), statusDot: $('status-dot'), hint: $('hint'),
  statusAction: $('btn-status-action'),
  stage: $('stage'), screenVideo: $('screen-video'), camVideo: $('cam-video')
};

const MODES = {
  full:      { t: 'Full screen',            d: 'Records everything on the screen you choose.',
               pd: 'The whole screen, taskbar included.',        box: { left:'0', top:'0', right:'0', bottom:'0' } },
  notaskbar: { t: 'Screen without taskbar', d: 'Everything except the bar along the edge of the screen.',
               pd: 'The taskbar is cropped out automatically.',  box: { left:'0', top:'0', right:'0', bottom:'9px' } },
  region:    { t: 'Selected area',          d: 'Drag a box around the part you want to record.',
               pd: 'Only the area you draw is captured.',        box: { left:'18%', top:'20%', right:'20%', bottom:'22%' } },
  fixed:     { t: 'Fixed size',             d: 'A preset box in the middle of the screen.',
               pd: 'Useful when every video must match exactly.', box: { left:'17%', top:'16%', right:'17%', bottom:'22%' } },
  window:    { t: 'Single window',          d: 'One application only. Windows in front of it are not captured.',
               pd: 'Other windows on top are not recorded.',     box: { left:'10%', top:'14%', right:'22%', bottom:'26%' } },
  repeat:    { t: 'Last area',              d: 'The same box you drew last time, remembered between sessions.',
               pd: 'Handy for a series of matching clips.',      box: { left:'18%', top:'20%', right:'20%', bottom:'22%' } }
};

const state = {
  mode: 'full', status: 'idle', sources: [], lastRegion: null,
  recorder: null, streams: [], audioCtx: null, analyser: null,
  drawTimer: 0, rafMeter: 0, countTimer: 0, countCancelled: false,
  startedAt: 0, pausedMs: 0, pauseStartedAt: 0, tick: 0,
  outPath: null, borderShown: false, sysGain: null, micGain: null,
  writeQueue: Promise.resolve(), writeFailed: null
};

const DEFAULT_HINT = 'Press Ctrl+Shift+R anywhere to start or save';

/* ------------------------------------------------------------------ */
/* Sources and devices                                                 */
/* ------------------------------------------------------------------ */

async function loadSources() {
  state.sources = await window.api.listSources();
  const screens = state.sources.filter((s) => s.kind === 'screen');
  const windows = state.sources.filter((s) => s.kind === 'window');

  const keepS = el.screenSource.value, keepW = el.windowSource.value;

  el.screenSource.innerHTML = '';
  screens.forEach((s, i) => {
    const size = s.metrics ? ` ${s.metrics.bounds.width} x ${s.metrics.bounds.height}` : '';
    el.screenSource.appendChild(new Option(`Screen ${i + 1},${size}`, s.id));
  });

  el.windowSource.innerHTML = '';
  if (!windows.length) el.windowSource.appendChild(new Option('No open windows found', ''));
  else windows.forEach((w) => el.windowSource.appendChild(new Option(w.name, w.id)));

  if (keepS && screens.some((s) => s.id === keepS)) el.screenSource.value = keepS;
  if (keepW && windows.some((w) => w.id === keepW)) el.windowSource.value = keepW;
}

async function loadDevices() {
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.some((d) => d.kind === 'audioinput' && !d.label)) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch { /* no mic or permission declined */ }
  }
  fill(el.micDevice, devices.filter((d) => d.kind === 'audioinput'), 'Microphone');
  fill(el.camDevice, devices.filter((d) => d.kind === 'videoinput'), 'Camera');
}

function fill(select, devices, fallback) {
  const keep = select.value;
  select.innerHTML = '';
  if (!devices.length) { select.appendChild(new Option(`No ${fallback.toLowerCase()} found`, '')); return; }
  devices.forEach((d, i) => select.appendChild(new Option(d.label || `${fallback} ${i + 1}`, d.deviceId)));
  if (keep && devices.some((d) => d.deviceId === keep)) select.value = keep;
}

const sourceFor = (id) => state.sources.find((s) => s.id === id) || null;
const activeSourceId = () => state.mode === 'window' ? el.windowSource.value : el.screenSource.value;

/* ------------------------------------------------------------------ */
/* Crop                                                                */
/* ------------------------------------------------------------------ */

function resolveCrop(mode, source, w, h) {
  const whole = { x: 0, y: 0, w, h };
  if (mode === 'full' || mode === 'window') return whole;

  if (mode === 'notaskbar') {
    const m = source && source.metrics;
    if (!m) return whole;
    if (m.workArea.width >= m.bounds.width && m.workArea.height >= m.bounds.height) return whole;
    return {
      x: Math.round(((m.workArea.x - m.bounds.x) / m.bounds.width) * w),
      y: Math.round(((m.workArea.y - m.bounds.y) / m.bounds.height) * h),
      w: Math.round((m.workArea.width / m.bounds.width) * w),
      h: Math.round((m.workArea.height / m.bounds.height) * h)
    };
  }

  if (mode === 'fixed') {
    const [fw, fh] = el.fixedSize.value.split('x').map(Number);
    const cw = Math.min(fw, w), ch = Math.min(fh, h);
    return { x: Math.round((w - cw) / 2), y: Math.round((h - ch) / 2), w: cw, h: ch };
  }

  if (mode === 'region' || mode === 'repeat') {
    const r = state.lastRegion;
    if (!r) return whole;
    return { x: Math.round(r.x * w), y: Math.round(r.y * h),
             w: Math.round(r.w * w), h: Math.round(r.h * h) };
  }
  return whole;
}

function cropAsRegion(mode, source, w, h) {
  if (mode === 'window') return null;
  const c = resolveCrop(mode, source, w, h);
  if (c.x === 0 && c.y === 0 && c.w === w && c.h === h) return null;
  return { x: c.x / w, y: c.y / h, w: c.w / w, h: c.h / h };
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

function runCountdown(seconds) {
  return new Promise((resolve) => {
    state.countCancelled = false;
    let n = seconds;

    const paint = () => {
      el.countNumber.textContent = String(n);
      // 327 is the circumference of the r=52 ring.
      el.ringSweep.style.transition = 'none';
      el.ringSweep.style.strokeDashoffset = '0';
      requestAnimationFrame(() => {
        el.ringSweep.style.transition = 'stroke-dashoffset .95s linear';
        el.ringSweep.style.strokeDashoffset = '327';
      });
    };

    paint();
    showView('countdown');
    window.api.setCompact(true);

    state.countTimer = setInterval(() => {
      if (state.countCancelled) { clearInterval(state.countTimer); return resolve(false); }
      n -= 1;
      if (n <= 0) { clearInterval(state.countTimer); return resolve(true); }
      paint();
    }, 1000);
  });
}

async function startRecording() {
  if (state.status !== 'idle') return;
  setStatusBar('');

  const mode = state.mode;
  if (mode === 'region') { if (!await pickArea()) return; }
  if (mode === 'repeat' && !state.lastRegion) {
    return setStatusBar('No saved area yet. Use Select area once first.', 'err');
  }

  await loadSources();
  const sourceId = activeSourceId();
  if (!sourceId) {
    return setStatusBar(mode === 'window' ? 'Choose a window to record.' : 'Choose a screen to record.', 'err');
  }

  if (el.countdownOn.checked) {
    if (!await runCountdown(3)) { showView('setup'); window.api.setCompact(false); return setStatusBar('Cancelled.'); }
  }

  const fps = Number(el.fps.value);

  try {
    const wantSys = el.sysAudio.checked;

    const screenStream = await navigator.mediaDevices.getUserMedia({
      audio: wantSys ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: fps } }
    });
    state.streams.push(screenStream);

    await attachVideo(el.screenVideo, screenStream);

    let camStream = null;
    if (el.camOn.checked) {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: el.camDevice.value ? { exact: el.camDevice.value } : undefined,
                 width: { ideal: 640 }, height: { ideal: 480 } }
      });
      state.streams.push(camStream);
      await attachVideo(el.camVideo, camStream);
    }

    let micStream = null;
    if (el.micAudio.checked) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: el.micDevice.value ? { exact: el.micDevice.value } : undefined,
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      state.streams.push(micStream);
    }

    const frameW = el.screenVideo.videoWidth, frameH = el.screenVideo.videoHeight;
    const source = sourceFor(sourceId);
    const crop = resolveCrop(mode, source, frameW, frameH);
    crop.w -= crop.w % 2;
    crop.h -= crop.h % 2;
    if (crop.w < 2 || crop.h < 2) throw new Error('The selected area is too small.');

    el.stage.width = crop.w;
    el.stage.height = crop.h;
    const ctx = el.stage.getContext('2d', { alpha: false, desynchronized: true });

    const drawFrame = () => {
      ctx.drawImage(el.screenVideo, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
      if (camStream) drawCamera(ctx, crop);
    };

    // Paint before capturing. A canvas that has never been drawn to can hand
    // back a track producing no frames, which is how a recording ends up with
    // audio and no video.
    drawFrame();

    // captureStream(fps) samples at a fixed rate on its own, giving constant
    // frame rate video. The interval keeps the canvas fresh; it replaced
    // requestAnimationFrame, which Chromium stalls when the window is covered.
    const canvasStream = el.stage.captureStream(fps);
    const videoTrack = canvasStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('Could not start capturing the screen. Try again.');
    state.drawTimer = setInterval(drawFrame, Math.round(1000 / fps));

    const audioTracks = [];
    if (wantSys || micStream) {
      const ac = new AudioContext();
      const dest = ac.createMediaStreamDestination();
      const analyser = ac.createAnalyser();
      analyser.fftSize = 512;
      if (wantSys && screenStream.getAudioTracks().length) {
        const n = ac.createMediaStreamSource(new MediaStream(screenStream.getAudioTracks()));
        const g = ac.createGain();
        g.gain.value = Number(el.sysVol.value) / 100;
        state.sysGain = g;
        n.connect(g); g.connect(dest); g.connect(analyser);
      }
      if (micStream) {
        const n = ac.createMediaStreamSource(micStream);
        const g = ac.createGain();
        g.gain.value = Number(el.micVol.value) / 100;
        state.micGain = g;
        n.connect(g); g.connect(dest); g.connect(analyser);
      }
      state.audioCtx = ac; state.analyser = analyser;
      audioTracks.push(...dest.stream.getAudioTracks());
      runMeter();
    }

    const recorder = new MediaRecorder(new MediaStream([videoTrack, ...audioTracks]), {
      mimeType: pickMimeType(),
      videoBitsPerSecond: Number(el.quality.value),
      audioBitsPerSecond: 128000
    });

    const { path } = await window.api.beginFile();
    state.outPath = path;

    // Chunks must land in the order MediaRecorder emits them. This handler is
    // deliberately synchronous: it appends to a promise chain rather than
    // awaiting, so two chunks are never in flight at once. An async handler
    // here shuffles clusters on disk and truncates playback.
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
      }).catch((err) => { state.writeFailed = err; console.error('Chunk write failed:', err); });
    };

    recorder.onerror = (ev) =>
      setStatusBar(`Recorder error: ${(ev.error && ev.error.name) || 'unknown'}`, 'err');

    screenStream.getVideoTracks()[0].addEventListener('ended', () => {
      if (state.status !== 'idle') stopRecording();
    });

    state.recorder = recorder;
    recorder.start(2000);

    if (el.showBorder.checked && source && mode !== 'window') {
      window.api.showBorder({ displayId: source.displayId,
                              region: cropAsRegion(mode, source, frameW, frameH) });
      state.borderShown = true;
    }

    console.log(`Capturing ${crop.w}x${crop.h} from ${frameW}x${frameH}, mode=${mode}`);

    state.startedAt = Date.now();
    state.pausedMs = 0;
    el.filesize.textContent = '';
    el.timecode.textContent = '00:00:00';
    setStatus('recording');
    startClock();
  } catch (err) {
    console.error(err);
    await cleanup();
    setStatus('idle');
    showView('setup');
    window.api.setCompact(false);
    setStatusBar(friendlyError(err), 'err');
  }
}

function drawCamera(ctx, crop) {
  const size = Math.round(Math.min(crop.w, crop.h) * 0.22);
  const pad = Math.round(size * 0.14);
  const c = el.camCorner.value;
  const x = c.endsWith('l') ? pad : crop.w - size - pad;
  const y = c.startsWith('t') ? pad : crop.h - size - pad;
  const vw = el.camVideo.videoWidth, vh = el.camVideo.videoHeight;
  if (!vw || !vh) return;
  const side = Math.min(vw, vh), sx = (vw - side) / 2, sy = (vh - side) / 2;

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

const pickMimeType = () =>
  ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';

function togglePause() {
  if (state.status === 'stopping' || !state.recorder) return;
  if (state.status === 'recording') {
    state.recorder.pause();
    clearInterval(state.drawTimer);
    state.pauseStartedAt = Date.now();
    setStatus('paused');
  } else if (state.status === 'paused') {
    state.recorder.resume();
    state.pausedMs += Date.now() - state.pauseStartedAt;
    setStatus('recording');
  }
}

async function stopRecording() {
  if (state.status === 'idle' || state.status === 'stopping' || !state.recorder) return;

  const recorder = state.recorder;
  state.status = 'stopping';

  const done = new Promise((res) => {
    recorder.addEventListener('stop', res, { once: true });
    // A stalled source can leave the stop event unfired, which used to freeze
    // the window until something else nudged the recorder.
    setTimeout(res, 6000);
  });

  try {
    if (recorder.state === 'paused') recorder.resume();
    if (recorder.state !== 'inactive') recorder.stop();
  } catch (err) {
    console.error('Stop failed:', err);
  }
  await done;

  showView('busy');
  el.busyText.textContent = 'Saving';
  el.busySub.textContent = 'Writing the last few seconds';

  await cleanup();
  try { await state.writeQueue; } catch { /* reported below */ }

  const format = el.format.value;
  el.busyText.textContent = format === 'mp4' ? 'Converting to MP4' : 'Finishing';
  el.busySub.textContent = format === 'mp4' ? 'This takes about as long as the recording' : 'Just a moment';

  const result = await window.api.endFile({ format, fps: Number(el.fps.value) });
  state.outPath = result.path;

  state.status = 'idle';
  window.api.setState('idle');
  window.api.setCompact(false);
  showView('setup');

  if (!result.path) return setStatusBar('Nothing was recorded.', 'err');
  if (state.writeFailed) return setStatusBar('Saved, but some data was dropped.', 'err');
  if (result.warning) return setStatusBar(result.warning, 'err');
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
  state.audioCtx = null; state.analyser = null; state.recorder = null;
  state.sysGain = null; state.micGain = null;
  el.screenVideo.srcObject = null;
  el.camVideo.srcObject = null;
  resetMeter();
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

const showView = (name) =>
  Object.entries(el.views).forEach(([k, n]) => { n.hidden = k !== name; });

function setStatus(status) {
  state.status = status;
  window.api.setState(status);
  const active = status !== 'idle';
  if (active) showView('recording');
  window.api.setCompact(active);
  el.tally.classList.toggle('pause', status === 'paused');
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
  const t = Math.max(0, Math.floor(ms / 1000)), p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}:${p(Math.floor(t / 60) % 60)}:${p(t % 60)}`;
}

function formatBytes(b) {
  if (b < 1048576) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}

const bars = [];
for (let i = 0; i < 15; i++) bars.push(el.meter.appendChild(document.createElement('i')));

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
      bar.className = level > 0.75 ? 'pk' : level > 0.05 ? 'on' : '';
    });
    state.rafMeter = requestAnimationFrame(loop);
  };
  loop();
}

const resetMeter = () => bars.forEach((b) => { b.style.height = '2px'; b.className = ''; });

function setStatusBar(text, kind) {
  el.hint.textContent = text || DEFAULT_HINT;
  el.statusbar.classList.toggle('err', kind === 'err');
  el.statusDot.className = `dot ${kind === 'ok' ? '' : kind === 'err' ? 'err' : 'idle'}`;
  el.statusAction.hidden = !(kind === 'ok' && state.outPath);
}

function friendlyError(err) {
  const n = err && err.name;
  if (n === 'NotAllowedError') return 'Windows blocked the capture. Check privacy settings.';
  if (n === 'NotFoundError') return 'That window closed. Refresh the list and try again.';
  if (n === 'NotReadableError') return 'Another app is using that camera or microphone.';
  return (err && err.message) || 'Could not start the recording.';
}

/**
 * Attaches a stream and waits for a genuinely new frame.
 * The element is reset first because videoWidth keeps its previous value,
 * so a naive check passes instantly on the second recording and the canvas
 * ends up drawing an empty element.
 */
async function attachVideo(videoEl, stream) {
  try { videoEl.pause(); } catch {}
  videoEl.srcObject = null;
  videoEl.load();

  videoEl.srcObject = stream;
  await videoEl.play();

  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    if (videoEl.requestVideoFrameCallback) videoEl.requestVideoFrameCallback(done);
    else videoEl.addEventListener('loadeddata', done, { once: true });
    setTimeout(done, 4000);
  });

  if (!videoEl.videoWidth || !videoEl.videoHeight) {
    throw new Error('The screen source produced no picture. Try again.');
  }
}

/* ------------------------------------------------------------------ */
/* Mode, pages, preview                                                */
/* ------------------------------------------------------------------ */

async function setMode(mode) {
  state.mode = mode;
  $$('.mode').forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });

  const m = MODES[mode];
  el.mTitle.textContent = m.t;
  el.mDesc.textContent = m.d;
  el.pvDesc.textContent = m.pd;
  Object.assign(el.pvShot.style, { left: '', top: '', right: '', bottom: '' }, m.box);

  el.pScreen.hidden = mode === 'window';
  el.pWindow.hidden = mode !== 'window';
  el.pFixed.hidden = mode !== 'fixed';
  el.pRegion.hidden = !(mode === 'region' || mode === 'repeat');

  if (mode === 'window') await loadSources();
  savePrefs();
  updatePreviewSize();
  updateSummary();
  setStatusBar('');
}

// Shows the real pixel size that will be recorded, so a broken mode is
// visible before you record rather than after.
function updatePreviewSize() {
  const src = sourceFor(activeSourceId());
  if (state.mode === 'window') { el.pvSize.textContent = 'Matches the window'; return; }
  if (!src || !src.metrics) { el.pvSize.textContent = 'Detecting'; return; }

  const b = src.metrics.bounds;
  const scale = src.metrics.scaleFactor || 1;
  const w = Math.round(b.width * scale), h = Math.round(b.height * scale);
  const c = resolveCrop(state.mode, src, w, h);
  el.pvSize.textContent = `${c.w - c.w % 2} x ${c.h - c.h % 2}`;
}

const showPage = (page) => {
  $$('.nav[data-page]').forEach((b) => b.classList.toggle('on', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('on', p.dataset.page === page));
};

function updateRegionLabel() {
  const r = state.lastRegion;
  el.regionInfo.textContent = r
    ? `Saved area, ${Math.round(r.w * 100)}% x ${Math.round(r.h * 100)}% of the screen`
    : 'No area chosen yet';
  const btn = el.modes.querySelector('.mode[data-mode="repeat"]');
  if (btn) btn.disabled = !r;
}

function updateSummary() {
  const chip = (label, on) => `<span class="chip${on ? '' : ' off'}">${label}</span>`;
  el.summary.innerHTML = [
    chip(el.sysAudio.checked ? 'Computer sound' : 'Computer sound off', el.sysAudio.checked),
    chip(el.micAudio.checked ? 'Microphone' : 'Microphone off', el.micAudio.checked),
    chip(el.camOn.checked ? 'Webcam' : 'Webcam off', el.camOn.checked),
    chip(`${el.fps.value} fps`, true),
    chip(el.format.value === 'mp4' ? 'MP4' : 'WebM', true)
  ].join('');
}

const updateFormatNote = () => {
  el.formatNote.textContent = el.format.value === 'mp4'
    ? 'MP4 needs a conversion pass that takes roughly as long as the recording.'
    : 'WebM is written the moment you press Save. It plays in any browser, VLC, and most editors.';
};

async function pickArea() {
  const src = sourceFor(el.screenSource.value);
  const rect = await window.api.selectRegion(src ? src.displayId : null);
  if (!rect) { setStatusBar('Area selection cancelled.'); return false; }
  state.lastRegion = rect;
  await window.api.setSettings({ lastRegion: rect });
  updateRegionLabel();
  updatePreviewSize();
  setStatusBar('');
  return true;
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

function applyVolumes() {
  el.sysVolOut.textContent = `${el.sysVol.value}%`;
  el.micVolOut.textContent = `${el.micVol.value}%`;
  if (state.sysGain) state.sysGain.gain.value = Number(el.sysVol.value) / 100;
  if (state.micGain) state.micGain.gain.value = Number(el.micVol.value) / 100;
}

function syncEnabled() {
  el.sysVol.disabled = !el.sysAudio.checked;
  el.micVol.disabled = !el.micAudio.checked;
  el.micDevice.disabled = !el.micAudio.checked;
  el.camDevice.disabled = !el.camOn.checked;
  el.camCorner.disabled = !el.camOn.checked;
}

const savePrefs = () => window.api.setSettings({
  mode: state.mode, fixedSize: el.fixedSize.value,
  sysAudio: el.sysAudio.checked, micAudio: el.micAudio.checked,
  camOn: el.camOn.checked, camCorner: el.camCorner.value,
  format: el.format.value, fps: el.fps.value, quality: el.quality.value,
  countdown: el.countdownOn.checked, showBorder: el.showBorder.checked,
  sysVol: el.sysVol.value, micVol: el.micVol.value
});

el.modes.addEventListener('click', (e) => {
  const b = e.target.closest('.mode');
  if (b && !b.disabled) setMode(b.dataset.mode);
});

el.nav.addEventListener('click', (e) => {
  const b = e.target.closest('.nav[data-page]');
  if (b) showPage(b.dataset.page);
});

[el.sysAudio, el.micAudio, el.camOn, el.camCorner, el.quality, el.countdownOn, el.showBorder]
  .forEach((c) => c.addEventListener('change', () => { syncEnabled(); savePrefs(); updateSummary(); }));

[el.fps, el.fixedSize].forEach((c) => c.addEventListener('change', () => {
  savePrefs(); updateSummary(); updatePreviewSize();
}));

el.format.addEventListener('change', () => { updateFormatNote(); savePrefs(); updateSummary(); });

[el.sysVol, el.micVol].forEach((r) =>
  r.addEventListener('input', () => { applyVolumes(); savePrefs(); }));
el.screenSource.addEventListener('change', updatePreviewSize);
el.refresh.addEventListener('click', loadSources);
el.pickArea.addEventListener('click', pickArea);

el.chooseFolder.addEventListener('click', async () => {
  const res = await window.api.chooseFolder();
  if (!res) return;
  if (res.error) return setStatusBar(res.error, 'err');
  el.savePath.textContent = res.path;
  el.savePath.title = res.path;
  setStatusBar('');
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
$('btn-min2').addEventListener('click', () => window.api.minimize());
$('btn-hide').addEventListener('click', () => window.api.hide());

window.api.onHotkey((a) => {
  if (a === 'toggle') state.status === 'idle' ? startRecording() : stopRecording();
  else if (a === 'pause') togglePause();
  else if (a === 'stop') stopRecording();
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
  if (saved.sysVol) el.sysVol.value = saved.sysVol;
  if (saved.micVol) el.micVol.value = saved.micVol;

  el.savePath.textContent = saved.savePath || '';
  el.savePath.title = saved.savePath || '';
  el.aboutVersion.textContent = `ScreenRec, version ${saved.version || ''}`;

  updateRegionLabel();
  updateFormatNote();
  syncEnabled();
  applyVolumes();
  await setMode(saved.mode && MODES[saved.mode] && !(saved.mode === 'repeat' && !state.lastRegion)
    ? saved.mode : 'full');

  showPage('record');
  showView('setup');
  setStatusBar('');
})();
