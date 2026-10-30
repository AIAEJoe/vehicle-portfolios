// Viewers for a car's walkaround video, exterior 360° spin and interior 360° photo. Used on the customer page and
// in the admin. Each opens full screen and closes with ✕, Esc or the back of the modal.
import { html, mount } from './core.js';

export const MEDIA_LABEL = { video: 'Walkaround video', spin: '360° exterior', interior360: '360° interior' };
export const MEDIA_ICON = { video: '▶', spin: '⟲', interior360: '◎' };

/** vehicle_media rows → one per kind (latest first wins), in the order customers see them. */
export function pickMedia(rows) {
  const out = [];
  for (const kind of ['spin', 'interior360', 'video']) {
    const m = (rows || []).filter((r) => r.kind === kind)
      .sort((a, b) => (a.position - b.position) || String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (m) out.push(m);
  }
  return out;
}
export const mediaThumb = (m) => m.poster_url || (m.kind === 'spin' ? (m.frames[0] || {}).url : m.kind === 'interior360' ? m.url : null);

function modal(title) {
  const box = document.createElement('div');
  box.className = 'mv';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-label', title);
  document.body.appendChild(box);
  document.body.classList.add('mv-open');
  mount(box, html`<div class="mv-top"><strong>${title}</strong><button type="button" class="mv-x" aria-label="Close">✕</button></div><div class="mv-body"></div>`);
  const cleanups = [];
  const close = () => {
    cleanups.forEach((f) => { try { f(); } catch { /* ignore */ } });
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('mv-open');
    box.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  box.querySelector('.mv-x').addEventListener('click', close);
  box.querySelector('.mv-x').focus();
  return { box, body: box.querySelector('.mv-body'), close, onClose: (f) => cleanups.push(f) };
}

export function openMedia(m, title = '') {
  const label = `${MEDIA_LABEL[m.kind] || 'Media'}${title ? ` · ${title}` : ''}`;
  if (m.kind === 'video') return openVideo(m, label);
  if (m.kind === 'spin') return openSpin(m, label);
  if (m.kind === 'interior360') return openPano(m, label);
  return null;
}

function openVideo(m, label) {
  const mv = modal(label);
  mount(mv.body, html`<video class="mv-video" src="${m.url}" ${m.poster_url ? html`poster="${m.poster_url}"` : ''} controls playsinline autoplay preload="metadata"></video>`);
  const v = mv.body.querySelector('video');
  mv.onClose(() => { v.pause(); v.removeAttribute('src'); v.load(); });
  return mv;
}

/** Exterior spin: drag (or arrow keys / buttons) to turn the car. Turns once by itself until touched. */
export function openSpin(m, label) {
  const mv = modal(label);
  const frames = (m.frames || []).map((f) => f.url).filter(Boolean);
  mount(mv.body, html`<div class="spin" tabindex="0" aria-label="360 degree view. Drag or use the arrow keys to turn the car.">
    <img class="spin-img" src="${frames[0]}" alt="Frame 1 of ${frames.length}" draggable="false">
    <div class="spin-load" aria-hidden="true"><i></i></div>
    <div class="spin-hint">⟵ Drag to turn ⟶</div></div>
    <div class="spin-ctrl"><button type="button" class="btn alt sm" data-step="-1" aria-label="Turn left">◀</button>
      <span class="small spin-n">1 / ${frames.length}</span>
      <button type="button" class="btn alt sm" data-step="1" aria-label="Turn right">▶</button></div>`);
  const stage = mv.body.querySelector('.spin');
  const img = mv.body.querySelector('.spin-img');
  const nEl = mv.body.querySelector('.spin-n');
  const bar = mv.body.querySelector('.spin-load i');
  let idx = 0, loaded = 0, auto = null, drag = null;
  const imgs = frames.map((u) => { const i = new Image(); i.decoding = 'async'; i.onload = i.onerror = () => { loaded++; bar.style.width = `${(loaded / frames.length) * 100}%`; if (loaded === frames.length) stage.classList.add('ready'); }; i.src = u; return i; });
  const show = (i) => {
    idx = ((i % frames.length) + frames.length) % frames.length;
    img.src = frames[idx];
    img.alt = `Frame ${idx + 1} of ${frames.length}`;
    nEl.textContent = `${idx + 1} / ${frames.length}`;
  };
  const stopAuto = () => { if (auto) { clearInterval(auto); auto = null; } stage.classList.add('touched'); };
  let turned = 0;
  auto = setInterval(() => { if (loaded < frames.length) return; show(idx + 1); if (++turned >= frames.length) stopAuto(); }, 110);
  stage.addEventListener('pointerdown', (e) => { stopAuto(); drag = { x: e.clientX, i: idx }; stage.setPointerCapture(e.pointerId); });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const per = Math.max(6, stage.clientWidth / frames.length / 1.2);
    show(drag.i - Math.round((e.clientX - drag.x) / per));
  });
  const end = () => { drag = null; };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { stopAuto(); show(idx - 1); e.preventDefault(); }
    if (e.key === 'ArrowRight') { stopAuto(); show(idx + 1); e.preventDefault(); }
  });
  mv.body.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => { stopAuto(); show(idx + Number(b.dataset.step)); }));
  mv.onClose(() => { stopAuto(); imgs.forEach((i) => { i.src = ''; }); });
  return mv;
}

// Pannellum (MIT) draws the interior 360 photo; loaded only when someone opens one.
const PANNELLUM = 'https://cdnjs.cloudflare.com/ajax/libs/pannellum/2.5.6/';
let pannellumP = null;
function loadPannellum() {
  if (window.pannellum) return Promise.resolve(window.pannellum);
  if (!pannellumP) {
    pannellumP = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = `${PANNELLUM}pannellum.css`;
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = `${PANNELLUM}pannellum.js`;
      s.onload = () => (window.pannellum ? resolve(window.pannellum) : reject(new Error('viewer missing')));
      s.onerror = () => { pannellumP = null; reject(new Error('The 360 viewer could not load.')); };
      document.head.appendChild(s);
    });
  }
  return pannellumP;
}

function openPano(m, label) {
  const mv = modal(label);
  mount(mv.body, html`<div class="pano" id="pano-${m.id}"><p class="pano-msg">Loading 360° view…</p></div>`);
  const el = mv.body.querySelector('.pano');
  let viewer = null;
  loadPannellum().then((p) => {
    if (!el.isConnected) return;
    el.innerHTML = '';
    viewer = p.viewer(el, { type: 'equirectangular', panorama: m.url, autoLoad: true, autoRotate: -2, showFullscreenCtrl: false, compass: false, hfov: 100, crossOrigin: 'anonymous' });
  }).catch(() => {
    mount(el, html`<p class="pano-msg">The 360° viewer couldn't load. Here's the full photo:</p><img src="${m.url}" alt="360 degree interior photo" class="pano-flat">`);
  });
  mv.onClose(() => { if (viewer && viewer.destroy) viewer.destroy(); });
  return mv;
}
