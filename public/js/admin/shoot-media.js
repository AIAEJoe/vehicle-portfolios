// Photos page → "Video & 360°" for the car on screen: a walkaround video, an exterior 360° spin (24 photos walking
// around the car) and an interior 360° photo (from a 360 camera such as Ricoh Theta or Insta360, saved to the
// camera roll). Each car keeps one of each on its page; a new one replaces the old one.
import { sb, html, mount, must, errMsg, toast, vTitle } from '../core.js';
import { resizeImage, uploadFile, removeFile } from './media.js';
import { openCamera, cameraSupported } from './camera.js';
import { openRecorder, recorderSupported, videoPoster, videoDuration, MAX_VIDEO_BYTES } from './recorder.js';
import { openMedia, MEDIA_LABEL, mediaThumb } from '../media-viewers.js';

export const SPIN_FRAMES = 24;
const MIN_SPIN = 8;
const tries = async (fn, n = 4) => {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) { if (i >= n - 1) throw e; await new Promise((r) => setTimeout(r, [1500, 4000, 10000][i] || 10000)); }
  }
};

/** Equirectangular 360 photos are twice as wide as they are tall. */
export async function isPanorama(file) {
  try {
    const bmp = await createImageBitmap(file);
    const r = bmp.width / bmp.height;
    return r > 1.9 && r < 2.1 && bmp.width >= 2000;
  } catch { return false; }
}

export function mediaSection({ box, ctx, D }) {
  let v = null;
  let items = [];
  const jobs = []; // { id, vid, kind, label, status, done, total, error, run }

  async function load() {
    if (!v) return;
    const id = v.id;
    const { data, error } = await sb.from('vehicle_media').select('*').eq('vehicle_id', id).order('created_at', { ascending: false });
    if (!v || v.id !== id) return;
    items = error ? null : data || [];
    draw();
  }

  function draw() {
    if (!box) return;
    if (!v) { mount(box, ''); return; }
    if (items === null) { mount(box, html`<div class="card"><h2>Video &amp; 360°</h2><p class="notice warn">Video and 360° aren't set up yet. Ask an admin to run the latest SQL update.</p></div>`); return; }
    const has = (k) => items.find((m) => m.kind === k);
    const mine = jobs.filter((j) => j.vid === v.id);
    mount(box, html`<div class="card shoot-media"><h2>Video &amp; 360°</h2>
      <div class="shoot-media-grid">
        ${['spin', 'interior360', 'video'].map((k) => {
          const m = has(k);
          const th = m && mediaThumb(m);
          return html`<div class="sm-item ${m ? 'has' : ''}">
            <div class="sm-thumb">${th ? html`<img src="${th}" alt="" loading="lazy">` : html`<span>${k === 'video' ? '▶' : k === 'spin' ? '⟲' : '◎'}</span>`}</div>
            <div class="sm-body"><strong>${MEDIA_LABEL[k]}</strong>
              <div class="small sub">${m ? (k === 'spin' ? `${m.frames.length} frames` : k === 'video' && m.duration_seconds ? `${Math.floor(m.duration_seconds / 60)}:${String(Math.round(m.duration_seconds % 60)).padStart(2, '0')}` : 'Added') : 'None yet'}</div>
              <div class="sm-btns">
                ${k === 'spin' ? html`${cameraSupported() ? html`<button type="button" class="btn alt sm" data-spin>${m ? 'Reshoot' : 'Shoot'} spin</button>` : ''}
                  <label class="btn ghost sm">From roll<input type="file" accept="image/*" multiple class="sr-only" data-spin-roll></label>` : ''}
                ${k === 'interior360' ? html`<label class="btn alt sm">${m ? 'Replace' : 'Add'} 360 photo<input type="file" accept="image/*" class="sr-only" data-pano></label>` : ''}
                ${k === 'video' ? html`${recorderSupported() ? html`<button type="button" class="btn alt sm" data-rec>${m ? 'Re-record' : 'Record'}</button>` : ''}
                  <label class="btn ghost sm">From roll<input type="file" accept="video/*" class="sr-only" data-video-roll></label>` : ''}
                ${m ? html`<button type="button" class="btn ghost sm" data-view="${m.id}">View</button><button type="button" class="btn ghost sm del" data-mdel="${m.id}" aria-label="Delete ${MEDIA_LABEL[k]}">🗑</button>` : ''}
              </div></div></div>`;
        })}
      </div>
      <p class="hint" style="margin:8px 0 0"><b>Spin:</b> stand about 10 ft from the car, take the first photo at the front corner, then take one big sidestep around the car between shots, keeping it centered (${SPIN_FRAMES} shots). <b>Interior 360:</b> take it with the 360 camera's app, save it to the phone, then add it here.</p>
      ${mine.length ? html`<ul class="sm-jobs">${mine.map((j) => html`<li class="${j.status}">${j.label}: ${j.status === 'failed'
        ? html`<span>didn't upload (${j.error})</span> <button type="button" class="btn sm" data-jretry="${j.id}">Try again</button>`
        : j.status === 'done' ? '✓ uploaded' : `uploading${j.total > 1 ? ` ${j.done} of ${j.total}` : '…'}`}</li>`)}</ul>` : ''}
    </div>`);
  }

  function job(kind, label, run) {
    const j = { id: Math.random().toString(36).slice(2), vid: v.id, kind, label, status: 'uploading', done: 0, total: 1, error: null, run };
    jobs.push(j);
    exec(j);
    return j;
  }
  async function exec(j) {
    j.status = 'uploading';
    j.error = null;
    draw();
    try {
      await j.run(j, () => draw());
      j.status = 'done';
      toast(`${j.label} uploaded`);
      if (v && v.id === j.vid) await load();
    } catch (e) {
      j.status = 'failed';
      j.error = errMsg(e);
      draw();
    }
  }

  // Keep only the newest of each kind: remove the older rows (and their files) once the new one is saved.
  async function replaceOld(vid, kind, keepId) {
    const { data } = await sb.from('vehicle_media').select('*').eq('vehicle_id', vid).eq('kind', kind);
    for (const m of (data || []).filter((x) => x.id !== keepId)) await removeMedia(m);
  }
  async function removeMedia(m) {
    const { error } = await sb.from('vehicle_media').delete().eq('id', m.id);
    if (error) throw error;
    const paths = [m.storage_path, m.poster_path, ...(m.frames || []).map((f) => f.path)].filter(Boolean);
    for (const p of paths) removeFile(p).catch(() => {});
  }

  function addVideo(file, seconds) {
    if (file.size > MAX_VIDEO_BYTES) { toast(`That video is ${(file.size / 1048576).toFixed(0)} MB. The limit is ${MAX_VIDEO_BYTES / 1048576} MB: record it here instead, or trim it.`, 'bad'); return; }
    const vid = v.id;
    const done = { video: null, poster: null };
    job('video', 'Walkaround video', async () => {
      const dur = seconds || await videoDuration(file);
      if (!done.poster) { const pf = await videoPoster(file); if (pf) done.poster = await tries(() => uploadFile(D, `vehicles/${vid}`, pf)); }
      if (!done.video) done.video = await tries(() => uploadFile(D, `vehicles/${vid}`, file));
      const row = must(await sb.from('vehicle_media').insert({ vehicle_id: vid, dealership_id: D, kind: 'video', url: done.video.url, storage_path: done.video.path,
        poster_url: done.poster ? done.poster.url : null, poster_path: done.poster ? done.poster.path : null, duration_seconds: dur, uploaded_by: ctx.user.id }).select().single());
      await replaceOld(vid, 'video', row.id);
    });
  }

  function addSpin(files) {
    if (files.length < MIN_SPIN) { toast(`A spin needs at least ${MIN_SPIN} photos (you took ${files.length}). Nothing was saved.`, 'bad'); return; }
    const vid = v.id;
    const frames = [];
    job('spin', `360° spin (${files.length} photos)`, async (j, redraw) => {
      j.total = files.length;
      for (let i = frames.length; i < files.length; i++) {
        const small = await resizeImage(files[i], 1280, 0.8);
        frames.push(await tries(() => uploadFile(D, `vehicles/${vid}`, small)));
        j.done = frames.length;
        redraw();
      }
      const row = must(await sb.from('vehicle_media').insert({ vehicle_id: vid, dealership_id: D, kind: 'spin', frames: frames.map((f) => ({ url: f.url, path: f.path })),
        poster_url: frames[0].url, uploaded_by: ctx.user.id }).select().single());
      await replaceOld(vid, 'spin', row.id);
    });
  }

  async function addPano(file) {
    if (!(await isPanorama(file))) {
      toast('That isn\'t a 360° photo. Use the full 360 image saved by your 360 camera\'s app (it\'s twice as wide as it is tall).', 'bad');
      return;
    }
    const vid = v.id;
    let up = null;
    job('interior360', '360° interior photo', async () => {
      if (!up) up = await tries(async () => uploadFile(D, `vehicles/${vid}`, await resizeImage(file, 4096, 0.85)));
      const row = must(await sb.from('vehicle_media').insert({ vehicle_id: vid, dealership_id: D, kind: 'interior360', url: up.url, storage_path: up.path, uploaded_by: ctx.user.id }).select().single());
      await replaceOld(vid, 'interior360', row.id);
    });
  }

  box.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !v) return;
    const label = `${vTitle(v)} · ${v.stock_number || ''}`;
    if (b.matches('[data-rec]')) openRecorder({ label, onVideo: (f, s) => addVideo(f, s) });
    if (b.matches('[data-spin]')) {
      const shots = [];
      openCamera({ label: `360° spin · ${label}`, limit: SPIN_FRAMES, ghost: true,
        hint: 'Line the car up with the faint picture of your last shot, then take one big sidestep around the car.',
        onPhoto: (f) => shots.push(f), onClose: () => { if (shots.length) addSpin(shots); } });
    }
    if (b.dataset.view) { const m = items.find((x) => x.id === b.dataset.view); if (m) openMedia(m, vTitle(v)); }
    if (b.dataset.mdel) {
      const m = items.find((x) => x.id === b.dataset.mdel);
      if (!m || !confirm(`Delete the ${MEDIA_LABEL[m.kind].toLowerCase()}?`)) return;
      try { await removeMedia(m); toast('Deleted'); await load(); } catch (err) { toast(errMsg(err), 'bad'); }
    }
    if (b.dataset.jretry) { const j = jobs.find((x) => x.id === b.dataset.jretry); if (j) exec(j); }
  });
  box.addEventListener('change', (e) => {
    const inp = e.target;
    if (!v || !inp.files || !inp.files.length) return;
    const files = [...inp.files];
    if (inp.matches('[data-video-roll]')) addVideo(files[0]);
    if (inp.matches('[data-spin-roll]')) addSpin(files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })));
    if (inp.matches('[data-pano]')) addPano(files[0]);
    inp.value = '';
  });

  return {
    show(vehicle) { v = vehicle; items = []; draw(); if (v) load(); },
    pending: () => jobs.some((j) => j.status === 'uploading'),
  };
}
