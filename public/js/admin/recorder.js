// Walkaround video recorder for the Photos page. Records in the page (MediaRecorder) at 720p and about 2.5 Mbit/s,
// so a 2-minute walkaround is roughly 40 MB and uploads over a phone connection. A phone's own camera app records
// 4K files that are often hundreds of MB, which is why this exists; "Video from camera roll" still takes short clips.
import { html, mount } from '../core.js';

export const MAX_VIDEO_SECONDS = 120;
export const MAX_VIDEO_BYTES = 45 * 1024 * 1024;

export const recorderSupported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

// MP4 plays everywhere (iPhone Safari records it; Chrome 126+ too). WebM is the fallback for older Chrome.
export function pickVideoType() {
  const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
}

const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function openRecorder({ onVideo, onClose, label = '', maxSeconds = MAX_VIDEO_SECONDS }) {
  const box = document.createElement('div');
  box.className = 'cam rec';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Record video');
  document.body.appendChild(box);
  document.body.classList.add('cam-open');
  mount(box, html`<div class="cam-stage"><video playsinline muted autoplay class="rec-live"></video>
      <video playsinline controls class="rec-review" hidden></video>
      <div class="cam-frame"><div class="cam-grid" aria-hidden="true"><i></i><i></i><i></i><i></i></div></div>
      <div class="cam-msg" role="status" aria-live="polite">Starting camera…</div>
      <div class="cam-hint">Hold the phone sideways. Start at the front corner and walk slowly around the car; finish inside.</div></div>
    <div class="cam-bar">
      <button type="button" class="rec-mic" aria-pressed="true" title="Sound">🎙</button>
      <button type="button" class="cam-shutter rec-btn" aria-label="Start recording" disabled></button>
      <button type="button" class="cam-done">Cancel</button>
    </div>
    <div class="cam-bar rec-after" hidden>
      <button type="button" class="btn alt" data-retake>Retake</button>
      <button type="button" class="btn" data-use>Use this video</button>
    </div>
    <div class="cam-top"><span class="cam-label">${label}</span><span class="cam-count rec-time" aria-live="off">0:00 / ${clock(maxSeconds)}</span></div>`);

  const live = box.querySelector('.rec-live');
  const review = box.querySelector('.rec-review');
  const msg = box.querySelector('.cam-msg');
  const btn = box.querySelector('.rec-btn');
  const time = box.querySelector('.rec-time');
  const mic = box.querySelector('.rec-mic');
  let stream = null, rec = null, chunks = [], started = 0, tick = null, result = null, closed = false, sound = true;

  async function start() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    btn.disabled = true;
    const video = { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: sound }).catch((e) => {
        if (!sound) throw e;
        sound = false; mic.setAttribute('aria-pressed', 'false'); // no microphone permission: record without sound
        return navigator.mediaDevices.getUserMedia({ video, audio: false });
      });
      if (closed) { stream.getTracks().forEach((t) => t.stop()); return; }
      live.srcObject = stream;
      await live.play().catch(() => {});
      msg.textContent = '';
      btn.disabled = false;
    } catch (e) {
      msg.textContent = e && e.name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow the camera for this site in your phone\'s settings, or use "Video from camera roll".'
        : 'The camera couldn\'t start. Use "Video from camera roll" instead.';
    }
  }

  function stopRec() {
    if (rec && rec.state !== 'inactive') rec.stop();
    clearInterval(tick);
  }

  btn.addEventListener('click', () => {
    if (rec && rec.state === 'recording') { stopRec(); return; }
    const type = pickVideoType();
    chunks = [];
    try {
      rec = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 96_000 });
    } catch {
      rec = new MediaRecorder(stream);
    }
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const mime = (rec.mimeType || type || 'video/webm').split(';')[0];
      const blob = new Blob(chunks, { type: mime });
      const seconds = Math.round((Date.now() - started) / 1000);
      result = { file: new File([blob], `walkaround-${Date.now()}.${mime.includes('mp4') ? 'mp4' : 'webm'}`, { type: mime }), seconds };
      box.classList.remove('recording');
      live.hidden = true;
      review.hidden = false;
      review.src = URL.createObjectURL(blob);
      box.querySelector('.cam-bar:not(.rec-after)').hidden = true;
      box.querySelector('.rec-after').hidden = false;
      if (blob.size > MAX_VIDEO_BYTES) msg.textContent = `This video is ${(blob.size / 1048576).toFixed(0)} MB, over the ${MAX_VIDEO_BYTES / 1048576} MB limit. Retake it a little shorter.`;
    };
    rec.start(1000);
    started = Date.now();
    box.classList.add('recording');
    btn.setAttribute('aria-label', 'Stop recording');
    mic.disabled = true;
    tick = setInterval(() => {
      const s = (Date.now() - started) / 1000;
      time.textContent = `${clock(s)} / ${clock(maxSeconds)}`;
      if (s >= maxSeconds) stopRec();
    }, 250);
  });

  mic.addEventListener('click', () => {
    sound = !sound;
    mic.setAttribute('aria-pressed', String(sound));
    start();
  });
  box.querySelector('[data-retake]').addEventListener('click', () => {
    if (review.src) URL.revokeObjectURL(review.src);
    review.removeAttribute('src');
    result = null;
    msg.textContent = '';
    review.hidden = true;
    live.hidden = false;
    box.querySelector('.cam-bar:not(.rec-after)').hidden = false;
    box.querySelector('.rec-after').hidden = true;
    btn.setAttribute('aria-label', 'Start recording');
    mic.disabled = false;
    time.textContent = `0:00 / ${clock(maxSeconds)}`;
  });
  box.querySelector('[data-use]').addEventListener('click', () => {
    if (!result || result.file.size > MAX_VIDEO_BYTES) return;
    const r = result;
    close();
    onVideo(r.file, r.seconds);
  });

  function close() {
    if (closed) return;
    closed = true;
    stopRec();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (review.src) URL.revokeObjectURL(review.src);
    document.body.classList.remove('cam-open');
    box.remove();
    onClose && onClose();
  }
  box.querySelector('.cam-done').addEventListener('click', close);
  start();
  return { close };
}

/** A still from about 1 second in, as a JPEG File, for the video's poster. Null if the browser can't decode it. */
export function videoPoster(file, maxSide = 1280) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (out) => { if (done) return; done = true; URL.revokeObjectURL(url); resolve(out); };
    setTimeout(() => finish(null), 8000);
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.addEventListener('loadeddata', () => {
      const d = Number.isFinite(v.duration) ? v.duration : 2;
      v.currentTime = Math.min(1, d / 2);
    }, { once: true });
    v.addEventListener('seeked', () => {
      try {
        const scale = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        c.toBlob((b) => finish(b ? new File([b], 'poster.jpg', { type: 'image/jpeg' }) : null), 'image/jpeg', 0.82);
      } catch { finish(null); }
    }, { once: true });
    v.addEventListener('error', () => finish(null), { once: true });
    v.src = url;
  });
}

/** Duration in seconds of a video file (camera-roll clips), or null. */
export function videoDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const finish = (d) => { URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? Math.round(d) : null); };
    setTimeout(() => finish(null), 6000);
    v.preload = 'metadata';
    v.addEventListener('loadedmetadata', () => finish(v.duration), { once: true });
    v.addEventListener('error', () => finish(null), { once: true });
    v.src = url;
  });
}
