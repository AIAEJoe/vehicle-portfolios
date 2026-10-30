// In-app series camera for the Photos page: live view with a 3×3 rule-of-thirds grid, tap the shutter as many
// times as needed, "Done" to finish. Each shot is handed to onPhoto(blob) straight away, so it starts uploading
// while the photographer keeps shooting.
//
// Quality: on Android (Chrome) shots use ImageCapture.takePhoto(), the camera's full-resolution still. Browsers
// without it (iPhone Safari) take the frame from the camera's video stream, asking for the highest resolution the
// phone allows (usually 4K). That is sharp, but skips the phone's own photo processing; the Photos page keeps a
// "Phone camera" button for hero shots.
import { html, mount } from '../core.js';

export const cameraSupported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

export function openCamera({ onPhoto, onClose, label = '' }) {
  const box = document.createElement('div');
  box.className = 'cam';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Camera');
  document.body.appendChild(box);
  document.body.classList.add('cam-open');
  mount(box, html`<div class="cam-stage"><video playsinline muted autoplay></video>
      <div class="cam-frame"><div class="cam-grid" aria-hidden="true"><i></i><i></i><i></i><i></i></div></div>
      <div class="cam-flash"></div><div class="cam-msg" role="status" aria-live="polite">Starting camera…</div></div>
    <div class="cam-bar">
      <button type="button" class="cam-grid-toggle" aria-pressed="true" title="Grid">#</button>
      <button type="button" class="cam-shutter" aria-label="Take photo" disabled></button>
      <button type="button" class="cam-done">Done</button>
    </div>
    <div class="cam-top"><span class="cam-label">${label}</span><span class="cam-count" aria-live="polite">0 photos</span><img class="cam-last" alt="" hidden></div>`);

  const video = box.querySelector('video');
  const frame = box.querySelector('.cam-frame');
  const msg = box.querySelector('.cam-msg');
  const shutter = box.querySelector('.cam-shutter');
  const countEl = box.querySelector('.cam-count');
  const last = box.querySelector('.cam-last');
  let stream = null;
  let imageCapture = null;
  let count = 0;
  let busy = false;
  let closed = false;

  // Keep the grid exactly over the picture that will be captured (the video is letterboxed, not cropped).
  const fit = () => {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const sw = video.clientWidth, sh = video.clientHeight;
    const scale = Math.min(sw / vw, sh / vh);
    Object.assign(frame.style, { width: `${vw * scale}px`, height: `${vh * scale}px`, left: `${(sw - vw * scale) / 2}px`, top: `${(sh - vh * scale) / 2}px` });
  };
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
      });
      if (closed) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      const track = stream.getVideoTracks()[0];
      if (typeof window.ImageCapture === 'function') { try { imageCapture = new window.ImageCapture(track); } catch { imageCapture = null; } }
      await new Promise((r) => (video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true })));
      fit();
      msg.textContent = '';
      shutter.disabled = false;
    } catch (e) {
      msg.textContent = e && e.name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow the camera for this site in your phone\'s settings, or close this and use "Phone camera".'
        : 'The camera couldn\'t start. Close this and use "Phone camera" instead.';
    }
  })();

  async function grab() {
    if (imageCapture) {
      try { return await imageCapture.takePhoto(); } catch { /* fall back to a video frame */ }
    }
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92));
  }

  shutter.addEventListener('click', async () => {
    if (busy || shutter.disabled) return;
    busy = true;
    box.classList.add('flash');
    setTimeout(() => box.classList.remove('flash'), 120);
    try {
      const blob = await grab();
      if (blob) {
        count++;
        const file = new File([blob], `IMG_${Date.now()}_${count}.jpg`, { type: blob.type || 'image/jpeg' });
        countEl.textContent = `${count} photo${count === 1 ? '' : 's'}`;
        if (last.src) URL.revokeObjectURL(last.src);
        last.src = URL.createObjectURL(file);
        last.hidden = false;
        onPhoto(file);
      }
    } finally { busy = false; }
  });
  box.querySelector('.cam-grid-toggle').addEventListener('click', (e) => {
    const on = box.classList.toggle('no-grid') === false;
    e.currentTarget.setAttribute('aria-pressed', String(on));
  });
  const close = () => {
    if (closed) return;
    closed = true;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    window.removeEventListener('resize', fit);
    window.removeEventListener('orientationchange', fit);
    document.body.classList.remove('cam-open');
    if (last.src) URL.revokeObjectURL(last.src);
    box.remove();
    onClose && onClose(count);
  };
  box.querySelector('.cam-done').addEventListener('click', close);
  return { close };
}
