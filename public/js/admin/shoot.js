// Photos: the photographer's page, built for a phone on the lot.
// Enter a stock number (or the last 6 of the VIN), confirm the car, tap "Take photos": the phone's own camera
// opens, and each shot uploads to that car in the background. Every photo is tied to the car that was on screen
// when it was taken, so moving on to the next car while uploads finish is safe. Failed uploads retry by themselves.
import { sb, html, mount, must, $, on, errMsg, toast, vTitle, miles, uuid } from '../core.js';
import { adminPage } from './layout.js';
import { resizeImage, uploadFile } from './media.js';

const RETRY_DELAYS = [2000, 6000, 15000, 30000];
const CONCURRENCY = 2;
export const normalizeStock = (t) => String(t || '').toUpperCase().replace(/^#/, '').replace(/[\s-]+/g, '').trim();

export default async function shoot(el, params, token = {}) {
  const page = await adminPage(el, 'shoot');
  if (!page) return;
  const { ctx, main } = page;
  const D = ctx.dealership.id;
  document.title = `Photos | ${ctx.dealership.name}`;

  let car = null; // { v, cover, nextPos }
  const queue = []; // { id, file, preview, vid, label, pos, status: 'waiting'|'uploading'|'done'|'failed', tries, error }
  let running = 0;

  mount(main, html`<div class="shoot">
    <form id="find" class="card shoot-find" autocomplete="off">
      <label for="stock">Stock number</label>
      <div class="shoot-row"><input id="stock" name="stock" inputmode="text" autocapitalize="characters" autocorrect="off" spellcheck="false"
        enterkeyhint="search" placeholder="e.g. PJ17152" aria-describedby="stock-hint"><button class="btn">Find</button></div>
      <div class="hint" id="stock-hint">Or the last 6 of the VIN.</div>
      <div id="find-msg"></div>
    </form>
    <div id="car"></div>
    <div id="queue"></div>
  </div>`);
  const input = $('#stock', main);
  input.focus();

  // ---------- find the car ----------
  $('#find', main).addEventListener('submit', async (e) => {
    e.preventDefault();
    const term = normalizeStock(input.value);
    const msg = $('#find-msg', main);
    if (term.length < 3) { msg.innerHTML = String(html`<p class="notice warn">Enter the stock number.</p>`); return; }
    msg.innerHTML = String(html`<p class="small sub">Looking…</p>`);
    try {
      const sel = 'id,slug,condition,year,make,model,trim,stock_number,vin,exterior_color,mileage,status,vehicle_photos(id,url,position,source)';
      let found = must(await sb.from('vehicles').select(sel).eq('dealership_id', D).in('status', ['draft', 'published']).ilike('stock_number', term).limit(5));
      if (!found.length && /^[A-HJ-NPR-Z0-9]{6,17}$/.test(term)) {
        found = must(await sb.from('vehicles').select(sel).eq('dealership_id', D).in('status', ['draft', 'published']).ilike('vin', `%${term}`).limit(5));
      }
      if (!found.length) { msg.innerHTML = String(html`<p class="notice warn">No car in stock with "${term}". Check the number on the key tag.</p>`); return; }
      msg.innerHTML = '';
      if (found.length === 1) pick(found[0]);
      else {
        mount($('#car', main), html`<div class="card"><h2>Which one?</h2>${found.map((v) => html`<button type="button" class="shoot-pick" data-pick="${v.id}">
          <strong>${vTitle(v)}</strong><span>Stock ${v.stock_number || '–'} · VIN …${(v.vin || '').slice(-8)}${v.exterior_color ? ` · ${v.exterior_color}` : ''}</span></button>`)}</div>`);
        on($('#car', main), 'click', '[data-pick]', (ev, b) => pick(found.find((v) => v.id === b.dataset.pick)));
      }
    } catch (err) { msg.innerHTML = String(html`<p class="notice bad">${errMsg(err)}</p>`); }
  });

  function pick(v) {
    const photos = v.vehicle_photos || [];
    const hasReal = photos.some((p) => p.source === 'upload');
    const positions = photos.map((p) => p.position);
    car = { v, cover: !hasReal, max: positions.length ? Math.max(...positions) : -1, min: positions.length ? Math.min(...positions, 0) : 0, seq: 0 };
    drawCar();
    input.value = '';
    input.blur();
  }

  function drawCar() {
    if (!car) { mount($('#car', main), ''); return; }
    const v = car.v;
    const mine = queue.filter((q) => q.vid === v.id);
    const thumb = (v.vehicle_photos || []).slice().sort((a, b) => a.position - b.position)[0];
    mount($('#car', main), html`<div class="card shoot-car">
      <div class="shoot-car-head">${thumb ? html`<img src="${thumb.url}" alt="">` : html`<div class="noimg"></div>`}
        <div><h2>${vTitle(v)}</h2>
          <div class="small">Stock <strong>${v.stock_number || '–'}</strong> · VIN …${(v.vin || '').slice(-8)}</div>
          <div class="small sub">${[v.exterior_color, v.mileage != null ? `${miles(v.mileage)} mi` : null, `${(v.vehicle_photos || []).length} photos on file`].filter(Boolean).join(' · ')}</div></div></div>
      <p class="small" style="margin:10px 0 6px">Check the key tag matches, then shoot.</p>
      <label class="btn shoot-cam">📷 Take photos<input type="file" id="cam" accept="image/*" capture="environment" class="sr-only"></label>
      <label class="btn alt shoot-roll">Add from camera roll<input type="file" id="roll" accept="image/*" multiple class="sr-only"></label>
      <label class="check small"><input type="checkbox" id="cover" ${car.cover ? 'checked' : ''}> Put these photos first (the first one becomes the cover)</label>
      ${mine.length ? html`<p class="small sub" style="margin:6px 0 0">${mine.length} taken for this car this session.</p>` : ''}
      <div class="shoot-print">
        <a class="btn alt sm" href="/admin/vehicles/${v.id}/sticker" target="_blank" data-external>🖨 Window sticker</a>
        ${v.condition !== 'new' ? html`<a class="btn alt sm" href="/v/${v.slug}/buyers-guide?lang=en" target="_blank" data-external>🖨 Buyers Guide</a>` : ''}
      </div>
      ${v.status !== 'published' ? html`<p class="hint" style="margin:4px 0 0">This car isn't live yet, so its QR code won't open until the store publishes it.</p>` : ''}
      <button type="button" class="btn ghost" id="next" style="margin-top:6px">Done, next car</button>
    </div>`);
    const add = (files) => { enqueue([...files]); };
    $('#cam', main).addEventListener('change', (e) => { add(e.target.files); e.target.value = ''; });
    $('#roll', main).addEventListener('change', (e) => { add(e.target.files); e.target.value = ''; });
    $('#cover', main).addEventListener('change', (e) => { car.cover = e.target.checked; });
    $('#next', main).addEventListener('click', () => { car = null; drawCar(); input.focus(); window.scrollTo(0, 0); });
  }

  // ---------- upload queue ----------
  function enqueue(files) {
    const v = car.v;
    for (const file of files.filter((f) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name))) {
      car.seq++;
      // Cover: positions below everything already there, in shooting order. Otherwise after the last photo.
      const pos = car.cover ? car.min - 100000 + car.seq : car.max + car.seq;
      queue.push({ id: uuid(), file, preview: URL.createObjectURL(file), vid: v.id, label: `${vTitle(v)} · ${v.stock_number || ''}`, pos, status: 'waiting', tries: 0 });
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
      q.file = null; // free memory
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
        ? `Uploading… ${done} of ${queue.length} done. Keep this page open.`
        : failed ? `${failed} photo${failed > 1 ? 's' : ''} didn't upload.` : `All ${done} photo${done === 1 ? '' : 's'} uploaded ✓`}</p>
      ${failed ? html`<button type="button" class="btn sm" id="retry">Try again</button>` : ''}
      <div class="shoot-grid">${queue.slice().reverse().map((q) => html`<figure class="shoot-thumb ${q.status}">
        <img src="${q.preview}" alt="">
        <figcaption>${{ waiting: 'Waiting', uploading: 'Uploading…', retrying: 'Retrying…', done: '✓', failed: 'Failed' }[q.status]}</figcaption>
        <span class="shoot-car-tag">${q.label}</span></figure>`)}</div></div>`);
    const r = $('#retry', box);
    r && r.addEventListener('click', () => { queue.filter((q) => q.status === 'failed').forEach((q) => { q.status = 'waiting'; q.tries = 0; }); pump(); drawQueue(); });
  }

  window.addEventListener('online', () => { queue.filter((q) => q.status === 'retrying' || q.status === 'failed').forEach((q) => { q.status = 'waiting'; }); pump(); });
  const warn = (e) => { if (queue.some((q) => !['done', 'failed'].includes(q.status))) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', warn);
  // Uploads keep going if the photographer opens another page in the app; only the leave-page warning is removed.
  token.cleanup = () => window.removeEventListener('beforeunload', warn);
}
