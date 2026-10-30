// Photos: the photographer's page, built for a phone on the lot (replaces SlipStream's photo upload).
//
// 1. Find the car: stock number, or any 4+ characters of the VIN (usually the last 4).
// 2. Shoot: "Series camera" (in-app, 3×3 grid, keep tapping) or "Phone camera" (the phone's own camera, best for
//    hero shots) or "Camera roll". Each photo uploads to that car in the background.
// 3. Arrange: reorder, make cover, caption or delete any photo of the car, right on the phone.
// 4. Print the window sticker / Buyers Guide, "Save to Photos", "Done, next car".
//
// Every photo is tied to the car on screen when it was taken. A copy stays on the phone until it has uploaded,
// so a dropped signal or closed page doesn't lose anything: the next visit finishes the uploads.
import { sb, html, mount, must, $, on, errMsg, toast, vTitle, miles, uuid } from '../core.js';
import { adminPage } from './layout.js';
import { resizeImage, uploadFile, removeFile } from './media.js';
import { openCamera, cameraSupported } from './camera.js';
import { savePending, removePending, listPending, saveToDevice } from './photo-store.js';
import { auditPhotos, DEFAULT_PHOTO_MIN } from '../photo-audit.js';

const RETRY_DELAYS = [2000, 6000, 15000, 30000];
const CONCURRENCY = 2;
export const normalizeStock = (t) => String(t || '').toUpperCase().replace(/^#/, '').replace(/[\s-]+/g, '').trim();
const SEL = 'id,slug,condition,year,make,model,trim,stock_number,vin,exterior_color,mileage,status,description,vehicle_photos(id,url,position,source,caption,storage_path,created_at)';
const byPos = (a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at));

export default async function shoot(el, params, token = {}) {
  const page = await adminPage(el, 'shoot');
  if (!page) return;
  const { ctx, main } = page;
  const D = ctx.dealership.id;
  const MIN = ctx.dealership.photo_min || DEFAULT_PHOTO_MIN;
  const canEdit = ctx.isAdmin || ctx.isPhotographer;
  document.title = `Photos | ${ctx.dealership.name}`;

  if (!canEdit) {
    mount(main, html`<div class="shoot"><div class="card"><h2>Photos</h2><p>Only photographers and dealership admins can add or change vehicle photos.
      You can see every car's photos on its Photos tab.</p><a class="btn alt" href="/admin/vehicles">Vehicles</a></div></div>`);
    return;
  }

  let car = null; // { v, photos, cover, max, min, seq, session: File[] }
  const queue = []; // { id, file, preview, vid, label, pos, status, tries, error }
  let running = 0;

  mount(main, html`<div class="shoot">
    <form id="find" class="card shoot-find" autocomplete="off">
      <label for="stock">Stock number or VIN</label>
      <div class="shoot-row"><input id="stock" name="stock" inputmode="text" autocapitalize="characters" autocorrect="off" spellcheck="false"
        enterkeyhint="search" placeholder="e.g. PJ17152 or 6227" aria-describedby="stock-hint"><button class="btn">Find</button></div>
      <div class="hint" id="stock-hint">Any 4 or more characters of the VIN work, usually the last 4.</div>
      <div id="find-msg"></div>
    </form>
    <div id="car"></div>
    <div id="manage"></div>
    <div id="queue"></div>
  </div>`);
  const input = $('#stock', main);
  input.focus();

  // ---------- find the car ----------
  $('#find', main).addEventListener('submit', async (e) => {
    e.preventDefault();
    const term = normalizeStock(input.value);
    const msg = $('#find-msg', main);
    if (term.length < 3) { msg.innerHTML = String(html`<p class="notice warn">Enter a stock number, or at least 4 characters of the VIN.</p>`); return; }
    msg.innerHTML = String(html`<p class="small sub">Looking…</p>`);
    try {
      const base = () => sb.from('vehicles').select(SEL).eq('dealership_id', D).in('status', ['draft', 'published']);
      const [byStock, byVin] = await Promise.all([
        base().ilike('stock_number', term).limit(5).then(must),
        term.length >= 4 && /^[A-HJ-NPR-Z0-9]+$/.test(term) ? base().ilike('vin', `%${term}%`).limit(12).then(must) : Promise.resolve([]),
      ]);
      const found = [...byStock, ...byVin.filter((v) => !byStock.some((x) => x.id === v.id))];
      if (!found.length) { msg.innerHTML = String(html`<p class="notice warn">No car in stock matches "${term}". Check the key tag or the VIN on the dash.</p>`); return; }
      msg.innerHTML = '';
      if (found.length === 1) pick(found[0]);
      else {
        mount($('#manage', main), '');
        mount($('#car', main), html`<div class="card"><h2>${found.length} cars match "${term}"</h2>${found.map((v) => html`<button type="button" class="shoot-pick" data-pick="${v.id}">
          <strong>${vTitle(v)}</strong><span>Stock ${v.stock_number || '–'} · VIN ${vinMarked(v.vin, term)}${v.exterior_color ? ` · ${v.exterior_color}` : ''}</span></button>`)}</div>`);
        on($('#car', main), 'click', '[data-pick]', (ev, b) => pick(found.find((v) => v.id === b.dataset.pick)));
      }
    } catch (err) { msg.innerHTML = String(html`<p class="notice bad">${errMsg(err)}</p>`); }
  });

  function pick(v) {
    const photos = (v.vehicle_photos || []).slice().sort(byPos);
    car = { v, photos, cover: !photos.some((p) => p.source === 'upload'), seq: 0, session: [] };
    bounds();
    drawCar();
    drawManage();
    input.value = '';
    input.blur();
  }
  function bounds() {
    const pos = car.photos.map((p) => p.position);
    car.max = pos.length ? Math.max(...pos) : -1;
    car.min = pos.length ? Math.min(...pos, 0) : 0;
  }
  async function refreshPhotos() {
    if (!car) return;
    const id = car.v.id;
    const rows = must(await sb.from('vehicle_photos').select('id,url,position,source,caption,storage_path,created_at').eq('vehicle_id', id));
    if (!car || car.v.id !== id) return;
    car.photos = rows.sort(byPos);
    car.v.vehicle_photos = car.photos;
    drawCar();
    drawManage();
  }

  function drawCar() {
    if (!car) { mount($('#car', main), ''); mount($('#manage', main), ''); return; }
    const v = car.v;
    const a = auditPhotos(v, car.photos, MIN);
    const pending = queue.filter((q) => q.vid === v.id && q.status !== 'done' && q.status !== 'failed').length;
    mount($('#car', main), html`<div class="card shoot-car">
      <div class="shoot-car-head">${car.photos[0] ? html`<img src="${car.photos[0].url}" alt="">` : html`<div class="noimg"></div>`}
        <div><h2>${vTitle(v)}</h2>
          <div class="small">Stock <strong>${v.stock_number || '–'}</strong> · VIN …${(v.vin || '').slice(-8)}</div>
          <div class="small sub">${[v.exterior_color, v.mileage != null ? `${miles(v.mileage)} mi` : null].filter(Boolean).join(' · ')}</div>
          <div class="shoot-min ${a.meetsMinimum ? 'ok' : ''}">${a.count} of ${MIN} photos${a.meetsMinimum ? ' ✓' : ''}${pending ? ` · ${pending} uploading` : ''}</div></div></div>
      <p class="small" style="margin:10px 0 6px">Check the key tag matches, then shoot.</p>
      ${cameraSupported() ? html`<button type="button" class="btn shoot-cam" id="series">📷 Series camera <small>grid · keep tapping</small></button>` : ''}
      <div class="shoot-two">
        <label class="btn alt">Phone camera<input type="file" id="cam" accept="image/*" capture="environment" class="sr-only"></label>
        <label class="btn alt">Camera roll<input type="file" id="roll" accept="image/*" multiple class="sr-only"></label>
      </div>
      <label class="check small"><input type="checkbox" id="cover" ${car.cover ? 'checked' : ''}> Put new photos first (the first one becomes the cover)</label>
      <div class="shoot-print">
        <a class="btn alt sm" href="/admin/vehicles/${v.id}/sticker" target="_blank" data-external>🖨 Window sticker</a>
        ${v.condition !== 'new' ? html`<a class="btn alt sm" href="/v/${v.slug}/buyers-guide?lang=en" target="_blank" data-external>🖨 Buyers Guide</a>` : ''}
      </div>
      ${v.status !== 'published' ? html`<p class="hint" style="margin:4px 0 0">This car isn't live yet, so its QR code won't open until the store publishes it.</p>` : ''}
      <div class="shoot-two" style="margin-top:6px">
        ${car.session.length ? html`<button type="button" class="btn ghost" id="save-device">Save ${car.session.length} to Photos</button>` : ''}
        <button type="button" class="btn ghost" id="next">Done, next car</button>
      </div>
    </div>`);
    const add = (files) => enqueue([...files]);
    const series = $('#series', main);
    series && series.addEventListener('click', () => {
      const label = `${vTitle(v)} · ${v.stock_number || ''}`;
      openCamera({ label, onPhoto: (f) => add([f]), onClose: (n) => { if (n) toast(`${n} photo${n === 1 ? '' : 's'} taken`); } });
    });
    $('#cam', main).addEventListener('change', (e) => { add(e.target.files); e.target.value = ''; });
    $('#roll', main).addEventListener('change', (e) => { add(e.target.files); e.target.value = ''; });
    $('#cover', main).addEventListener('change', (e) => { car.cover = e.target.checked; });
    const sd = $('#save-device', main);
    sd && sd.addEventListener('click', async () => {
      const r = await saveToDevice(car.session);
      if (r === 'shared' || r === 'downloaded') toast(r === 'shared' ? 'Choose "Save Images" to keep them in Photos' : 'Photos downloaded');
    });
    $('#next', main).addEventListener('click', () => { car = null; drawCar(); input.focus(); window.scrollTo(0, 0); });
  }

  // ---------- arrange: reorder, cover, caption, delete ----------
  function drawManage() {
    const box = $('#manage', main);
    if (!car || !box) return;
    const list = car.photos;
    if (!list.length) { mount(box, ''); return; }
    mount(box, html`<div class="card"><h2>Arrange ${list.length} photo${list.length === 1 ? '' : 's'}</h2>
      <p class="hint" style="margin-top:0">This is the order customers see. Use the arrows to move a photo, ★ to make it the cover.</p>
      <ol class="shoot-arrange">${list.map((p, i) => html`<li data-photo="${p.id}">
        <img src="${p.url}" alt="Photo ${i + 1}" loading="lazy">
        <div class="shoot-arrange-body">
          <div class="shoot-arrange-top"><b>${i === 0 ? 'Cover' : `#${i + 1}`}</b>${p.source !== 'upload' ? html`<span class="small sub"> ${p.source === 'feed' ? 'feed' : 'stock'} photo</span>` : ''}</div>
          <input class="shoot-caption" data-caption="${p.id}" value="${p.caption || ''}" maxlength="200" placeholder="Caption (optional)" aria-label="Caption for photo ${i + 1}">
          <div class="shoot-arrange-btns">
            <button type="button" data-move="-1" data-id="${p.id}" aria-label="Move earlier" ${i === 0 ? 'disabled' : ''}>▲</button>
            <button type="button" data-move="1" data-id="${p.id}" aria-label="Move later" ${i === list.length - 1 ? 'disabled' : ''}>▼</button>
            ${i ? html`<button type="button" data-cover="${p.id}" aria-label="Make cover">★</button>` : ''}
            <button type="button" data-del="${p.id}" aria-label="Delete photo ${i + 1}" class="del">🗑</button>
          </div>
        </div></li>`)}</ol></div>`);
  }
  async function saveOrder(next) {
    const changed = next.map((p, i) => ({ p, i })).filter(({ p, i }) => p.position !== i);
    car.photos = next.map((p, i) => ({ ...p, position: i }));
    bounds();
    drawManage();
    drawCar();
    for (const { p, i } of changed) {
      const { error } = await sb.from('vehicle_photos').update({ position: i }).eq('id', p.id);
      if (error) { toast(errMsg(error), 'bad'); await refreshPhotos(); return; }
    }
  }
  on(main, 'click', '#manage [data-move]', (e, b) => {
    const list = [...car.photos];
    const i = list.findIndex((p) => p.id === b.dataset.id);
    const j = i + Number(b.dataset.move);
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    saveOrder(list);
  });
  on(main, 'click', '#manage [data-cover]', (e, b) => {
    const p = car.photos.find((x) => x.id === b.dataset.cover);
    saveOrder([p, ...car.photos.filter((x) => x !== p)]);
  });
  on(main, 'click', '#manage [data-del]', async (e, b) => {
    const p = car.photos.find((x) => x.id === b.dataset.del);
    if (!p || !confirm('Delete this photo?')) return;
    const { error } = await sb.from('vehicle_photos').delete().eq('id', p.id);
    if (error) { toast(errMsg(error), 'bad'); return; }
    if (p.storage_path) removeFile(p.storage_path).catch(() => {});
    car.photos = car.photos.filter((x) => x !== p);
    bounds();
    drawManage();
    drawCar();
  });
  on(main, 'change', '#manage [data-caption]', async (e, inp) => {
    const caption = inp.value.trim() || null;
    const { error } = await sb.from('vehicle_photos').update({ caption }).eq('id', inp.dataset.caption);
    if (error) { toast(errMsg(error), 'bad'); return; }
    const p = car.photos.find((x) => x.id === inp.dataset.caption);
    if (p) p.caption = caption;
    inp.classList.add('saved');
    setTimeout(() => inp.classList.remove('saved'), 1200);
    drawCar();
  });

  // ---------- upload queue (with a safety copy on the phone) ----------
  function enqueue(files) {
    const v = car.v;
    for (const file of files.filter((f) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name))) {
      car.seq++;
      // New photos first (cover): below everything already there, in shooting order. Otherwise after the last one.
      const pos = car.cover ? car.min - 100000 + car.seq : car.max + car.seq;
      const q = { id: uuid(), file, preview: URL.createObjectURL(file), vid: v.id, label: `${vTitle(v)} · ${v.stock_number || ''}`, pos, status: 'waiting', tries: 0 };
      queue.push(q);
      car.session.push(file);
      savePending({ id: q.id, dealership_id: D, vid: q.vid, label: q.label, pos, name: file.name, type: file.type, blob: file, created: Date.now() });
    }
    drawCar();
    drawQueue();
    pump();
  }

  function pump() {
    while (running < CONCURRENCY) {
      const next = queue.find((q) => q.status === 'waiting');
      if (!next) break;
      running++;
      upload(next).finally(() => { running--; drawQueue(); pump(); });
    }
  }

  async function upload(q) {
    q.status = 'uploading';
    drawQueue();
    try {
      const small = await resizeImage(q.file);
      const { path, url } = await uploadFile(D, `vehicles/${q.vid}`, small);
      must(await sb.from('vehicle_photos').insert({ vehicle_id: q.vid, dealership_id: D, url, storage_path: path, position: q.pos, source: 'upload', uploaded_by: ctx.user.id }));
      q.status = 'done';
      removePending(q.id);
      if (car && car.v.id === q.vid) refreshPhotos().catch(() => {});
    } catch (err) {
      q.tries++;
      q.error = errMsg(err);
      if (q.tries <= RETRY_DELAYS.length) {
        q.status = 'retrying';
        setTimeout(() => { if (q.status === 'retrying') { q.status = 'waiting'; pump(); } }, RETRY_DELAYS[q.tries - 1]);
      } else {
        q.status = 'failed';
      }
    }
  }

  function drawQueue() {
    const box = $('#queue', main);
    if (!box) return;
    if (!queue.length) { box.innerHTML = ''; return; }
    const done = queue.filter((q) => q.status === 'done').length;
    const failed = queue.filter((q) => q.status === 'failed').length;
    const pending = queue.length - done - failed;
    box.innerHTML = String(html`<div class="card"><h2>Uploads</h2>
      <p class="shoot-status ${failed ? 'bad' : pending ? '' : 'ok'}" role="status" aria-live="polite">${pending
        ? `Uploading… ${done} of ${queue.length} done. A copy stays on this phone until each one is uploaded.`
        : failed ? `${failed} photo${failed > 1 ? 's' : ''} didn't upload. They're still saved on this phone.` : `All ${done} photo${done === 1 ? '' : 's'} uploaded ✓`}</p>
      ${failed ? html`<button type="button" class="btn sm" id="retry">Try again</button>` : ''}
      <div class="shoot-grid">${queue.slice().reverse().map((q) => html`<figure class="shoot-thumb ${q.status}">
        <img src="${q.preview}" alt="">
        <figcaption>${{ waiting: 'Waiting', uploading: 'Uploading…', retrying: 'Retrying…', done: '✓', failed: 'Failed' }[q.status]}</figcaption>
        <span class="shoot-car-tag">${q.label}</span></figure>`)}</div></div>`);
    const r = $('#retry', box);
    r && r.addEventListener('click', () => { queue.filter((q) => q.status === 'failed').forEach((q) => { q.status = 'waiting'; q.tries = 0; }); pump(); drawQueue(); });
  }

  // Finish anything left from an earlier visit (page closed, phone locked, no signal).
  listPending(D).then((left) => {
    const fresh = left.filter((r) => !queue.some((q) => q.id === r.id));
    if (!fresh.length) return;
    for (const r of fresh) {
      const file = new File([r.blob], r.name || 'photo.jpg', { type: r.type || 'image/jpeg' });
      queue.push({ id: r.id, file, preview: URL.createObjectURL(file), vid: r.vid, label: r.label, pos: r.pos, status: 'waiting', tries: 0 });
    }
    toast(`Finishing ${fresh.length} photo${fresh.length === 1 ? '' : 's'} from earlier`);
    drawQueue();
    pump();
  }).catch(() => {});

  window.addEventListener('online', () => { queue.filter((q) => q.status === 'retrying' || q.status === 'failed').forEach((q) => { q.status = 'waiting'; }); pump(); });
  const warn = (e) => { if (queue.some((q) => !['done', 'failed'].includes(q.status))) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', warn);
  // Uploads keep going if the photographer opens another page in the app; only the leave-page warning is removed.
  token.cleanup = () => window.removeEventListener('beforeunload', warn);
}

// "1G1YC3D46P513[6227]" style: show the whole VIN with the matched part in bold, so near-matches can be told apart.
function vinMarked(vin, term) {
  vin = String(vin || '');
  const i = vin.indexOf(term);
  if (i < 0 || !term) return `…${vin.slice(-8)}`;
  return html`${vin.slice(0, i)}<b>${vin.slice(i, i + term.length)}</b>${vin.slice(i + term.length)}`;
}
