// Public Vehicle Portfolio page: /v/<slug>[?s=<share code>]
import {
  sb, html, mount, must, money, miles, vTitle, conditionLabel, telHref, smsHref, loadDealership,
  loadingView, errMsg, $, $$, on, api, store, uuid, initials, copyText, esc,
} from '../core.js';
import { siteHeader, siteFooter } from './site.js';

const DOC_LABELS = {
  window_sticker: 'Window sticker',
  history_report: 'Vehicle history report',
  inspection: 'Inspection / reconditioning report',
  warranty: 'Warranty information',
  brochure: 'Brochure',
  other: 'Document',
};

export default async function portfolio(el, { slug }) {
  mount(el, loadingView());
  const shareCode = new URLSearchParams(location.search).get('s');
  let d, v, share = null, staff = null, smsInfo = null;
  try {
    d = await loadDealership();
    v = must(await sb.from('vehicles')
      .select('*, vehicle_photos(id,url,position,created_at), vehicle_documents(id,kind,title,url)')
      .eq('dealership_id', d.id).eq('slug', slug).maybeSingle());
    if (!v) throw new Error('This vehicle portfolio is not available. It may have been removed.');
    const smsP = sb.rpc('vp_public_sms_info', { p_slug: d.slug });
    if (shareCode) {
      const { data } = await sb.rpc('vp_share_public', { p_code: shareCode });
      if (data && data.vehicle_id === v.id) share = data;
    }
    const staffId = (share && share.staff_id) || v.salesperson_id;
    smsInfo = (await smsP).data;
    if (staffId) {
      const { data } = await sb.from('staff').select('id,full_name,title,phone,email,photo_url').eq('id', staffId).maybeSingle();
      staff = data;
    }
  } catch (e) {
    mount(el, html`${d ? siteHeader(d) : ''}<main class="site-main"><div class="card"><h1>Not found</h1>
      <p>${errMsg(e)}</p><a class="btn" href="/">See all vehicles</a></div></main>`);
    return;
  }

  const photos = (v.vehicle_photos || []).sort((a, b) => a.position - b.position || String(a.created_at).localeCompare(String(b.created_at)));
  const docs = v.vehicle_documents || [];
  const title = vTitle(v);
  const sold = v.status === 'sold';
  const contactPhone = (staff && staff.phone) || d.sms_phone || d.phone;
  const smsBody = `Hi${staff ? ' ' + staff.full_name.split(' ')[0] : ''}, I'm interested in the ${title}${v.stock_number ? ` (stock ${v.stock_number})` : ''}.`;
  document.title = `${sold ? 'SOLD: ' : ''}${title} | ${d.name}`;

  const specRows = [
    ['Year / Make / Model', [v.year, v.make, v.model].filter(Boolean).join(' ')],
    ['Trim', v.trim],
    ['Condition', conditionLabel(v.condition)],
    ['Mileage', v.mileage != null ? miles(v.mileage) : null],
    ['Engine', v.engine],
    ['Transmission', v.transmission],
    ['Drivetrain', v.drivetrain],
    ['Fuel', v.fuel_type],
    ['MPG', v.mpg_city || v.mpg_hwy ? `${v.mpg_city || '–'} city / ${v.mpg_hwy || '–'} hwy` : null],
    ['Body style', v.body_style],
    ['Exterior', v.exterior_color],
    ['Interior', v.interior_color],
    ...Object.entries(v.specs || {}).map(([k, val]) => [k, typeof val === 'object' ? JSON.stringify(val) : val]),
    ['Stock #', v.stock_number],
    ['VIN', v.vin],
  ].filter(([, val]) => val !== null && val !== undefined && val !== '');

  const recalls = Array.isArray(v.recalls) ? v.recalls : null;
  const feesNote = v.fees_note || d.default_fees_note;

  mount(el, html`${siteHeader(d)}
  <main class="site-main">
    ${sold ? html`<div class="sold-banner">This vehicle has been sold. <a href="/" style="color:#fff">See similar vehicles →</a></div>` : ''}
    ${share && share.customer_first_name ? html`<div class="greeting">Hi ${share.customer_first_name}! ${staff ? `${staff.full_name.split(' ')[0]} put together` : 'Here is'} everything about this ${v.make || 'vehicle'} for you.</div>` : ''}

    <section class="card">
      ${photos.length ? html`
      <div class="gallery-main" id="gal">
        <img id="gal-img" src="${photos[0].url}" alt="${title} photo 1" fetchpriority="high">
        ${photos.length > 1 ? html`<button class="nav prev" data-step="-1" aria-label="Previous photo">‹</button>
        <button class="nav next" data-step="1" aria-label="Next photo">›</button>` : ''}
        <span class="count" id="gal-count">1 / ${photos.length}</span>
      </div>
      ${photos.length > 1 ? html`<div class="thumbs" id="thumbs">${photos.map((p, i) => html`<button data-i="${i}" class="${i === 0 ? 'on' : ''}" aria-label="Photo ${i + 1}"><img src="${p.url}" alt="" loading="lazy"></button>`)}</div>` : ''}
      ` : ''}
      <div style="margin-top:14px">
        <div class="sub small">${[v.stock_number && `Stock # ${v.stock_number}`, v.vin && `VIN ${v.vin}`].filter(Boolean).join(' · ')}</div>
        <h1 class="hero-title">${conditionLabel(v.condition)} ${title}</h1>
        <div class="sub">${[v.exterior_color, v.drivetrain, v.mileage != null ? `${miles(v.mileage)} miles` : null].filter(Boolean).join(' · ')}</div>
        ${!sold ? html`<p class="price">${v.price ? money(v.price) : 'Call for price'} ${v.price && v.price_label ? html`<span class="sub">${v.price_label}</span>` : ''}</p>
        ${v.msrp && v.price && Number(v.msrp) > Number(v.price) ? html`<div class="sub small">MSRP ${money(v.msrp)}</div>` : ''}
        ${feesNote ? html`<p class="sub small" style="margin:6px 0 0">${feesNote}</p>` : ''}` : ''}
      </div>
      <div class="btn-row" style="margin-top:14px">
        <button class="btn alt sm" id="share-btn">Share</button>
        ${v.listing_url ? html`<a class="btn ghost sm" href="${v.listing_url}" target="_blank" rel="noopener" data-external>View on our website</a>` : ''}
      </div>
    </section>

    ${staff ? html`<section class="card">
      <h2>Your salesperson</h2>
      <div class="person">
        ${staff.photo_url ? html`<img src="${staff.photo_url}" alt="${staff.full_name}">` : html`<div class="avatar">${initials(staff.full_name)}</div>`}
        <div><strong style="font-size:17px">${staff.full_name}</strong><br><span class="sub">${staff.title || ''}${staff.title ? ' · ' : ''}${d.name}</span></div>
      </div>
      <div class="grid2">
        <a class="btn" href="${telHref(contactPhone)}">Call</a>
        <a class="btn alt" href="${smsHref(contactPhone, smsBody)}">Text</a>
      </div>
      ${staff.email ? html`<p class="small" style="margin:10px 0 0"><a href="mailto:${staff.email}?subject=${encodeURIComponent(title)}">${staff.email}</a></p>` : ''}
      ${d.hours ? html`<p class="sub small" style="margin:8px 0 0">Showroom hours: ${d.hours}</p>` : ''}
    </section>` : ''}

    ${v.features && v.features.length ? html`<section class="card"><h2>Highlights</h2>
      <ul class="chips">${v.features.map((f) => html`<li>${f}</li>`)}</ul></section>` : ''}

    <section class="card"><h2>Specifications</h2>
      <table class="specs">${specRows.map(([k, val]) => html`<tr><td>${k}</td><td>${val}</td></tr>`)}</table>
    </section>

    ${v.description ? html`<section class="card"><h2>About this vehicle</h2><div class="desc">${v.description}</div></section>` : ''}

    ${docs.length ? html`<section class="card"><h2>Documents</h2>
      ${docs.map((doc) => html`<a class="doc-row" href="${doc.url}" target="_blank" rel="noopener" data-external>
        <span><strong>${doc.title || DOC_LABELS[doc.kind]}</strong><br><span class="sub small">${DOC_LABELS[doc.kind] || ''}</span></span>
        <span class="open">Open ↗</span></a>`)}
    </section>` : ''}

    ${recalls ? html`<section class="card"><h2>Safety recalls</h2>
      ${recalls.length ? html`<p class="small sub">NHTSA lists ${recalls.length} recall${recalls.length > 1 ? 's' : ''} for the ${v.year} ${v.make} ${v.model}. Ask us whether each has already been completed on this vehicle.</p>
        ${recalls.map((r) => html`<details class="recall"><summary>${r.component || 'Recall'} <span class="sub small">(${r.campaign})</span></summary>
          <p class="small">${r.summary}</p>${r.remedy ? html`<p class="small"><strong>Remedy:</strong> ${r.remedy}</p>` : ''}</details>`)}`
        : html`<p>No safety recalls are listed by NHTSA for the ${v.year} ${v.make} ${v.model}.</p>`}
      <p class="sub small">Checked ${v.recalls_checked_at ? new Date(v.recalls_checked_at).toLocaleDateString() : ''}. Look up this exact VIN at <a href="https://www.nhtsa.gov/recalls" target="_blank" rel="noopener">nhtsa.gov/recalls</a>.</p>
    </section>` : ''}

    ${!sold ? html`<section class="card" id="test-drive"><h2>Request a test drive</h2>
      <form id="lead-form" novalidate>
        <label for="f-name">Name</label><input id="f-name" name="name" autocomplete="name" required>
        <div class="grid2 stack-sm">
          <div><label for="f-phone">Phone</label><input id="f-phone" name="phone" type="tel" autocomplete="tel"></div>
          <div><label for="f-email">Email</label><input id="f-email" name="email" type="email" autocomplete="email"></div>
        </div>
        <div class="grid2 stack-sm">
          <div><label for="f-date">Preferred day</label><input id="f-date" name="preferred_date" type="date" min="${new Date().toISOString().slice(0, 10)}"></div>
          <div><label for="f-time">Time</label><select id="f-time" name="preferred_time"><option>Morning</option><option>Afternoon</option><option>Evening</option></select></div>
        </div>
        <label for="f-msg">Questions or notes</label><textarea id="f-msg" name="message" rows="2"></textarea>
        ${smsInfo && smsInfo.phone ? html`<label class="check small" style="font-weight:400;align-items:flex-start"><input type="checkbox" name="sms_consent" style="margin-top:3px">
          <span>${smsInfo.consent_language} <a href="/sms-terms" target="_blank">Terms &amp; privacy</a></span></label>` : ''}
        <div class="sr-only" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
        <p class="hint">We'll reach out to confirm a time. No obligation.</p>
        <button class="btn block" type="submit">Request test drive</button>
        <div id="lead-msg"></div>
      </form>
    </section>` : ''}
  </main>
  ${siteFooter(d)}
  ${!sold ? html`<div class="action-bar no-print">
    <a class="btn alt" href="${telHref(contactPhone)}">Call</a>
    <a class="btn alt" href="${smsHref(contactPhone, smsBody)}">Text</a>
    <a class="btn" href="#test-drive" id="td-jump">Test drive</a>
  </div>` : ''}`);

  // ----- gallery -----
  let idx = 0;
  const show = (i) => {
    if (!photos.length) return;
    idx = (i + photos.length) % photos.length;
    const img = $('#gal-img', el);
    img.src = photos[idx].url;
    img.alt = `${title} photo ${idx + 1}`;
    $('#gal-count', el).textContent = `${idx + 1} / ${photos.length}`;
    $$('#thumbs button', el).forEach((b, j) => b.classList.toggle('on', j === idx));
    const on_ = $(`#thumbs button[data-i="${idx}"]`, el);
    if (on_) on_.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    // preload neighbour
    if (photos[idx + 1]) { const p = new Image(); p.src = photos[idx + 1].url; }
  };
  on(el, 'click', '#gal .nav', (e, b) => { e.stopPropagation(); show(idx + Number(b.dataset.step)); });
  on(el, 'click', '#thumbs button', (e, b) => show(Number(b.dataset.i)));
  on(el, 'click', '#gal-img', () => openLightbox(photos, idx, title, (i) => show(i)));
  swipe($('#gal', el), (dir) => show(idx + dir));

  on(el, 'click', '#td-jump', (e) => {
    e.preventDefault();
    $('#test-drive', el).scrollIntoView({ behavior: 'smooth' });
    setTimeout(() => $('#f-name', el).focus({ preventScroll: true }), 400);
  });

  on(el, 'click', '#share-btn', async () => {
    const url = location.origin + location.pathname; // never re-share someone's personal tracking code
    if (navigator.share) {
      try { await navigator.share({ title, text: `${title} at ${d.name}`, url }); } catch { /* cancelled */ }
    } else copyText(url);
  });

  // ----- lead form -----
  const form = $('#lead-form', el);
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = $('#lead-msg', el);
      const data = Object.fromEntries(new FormData(form).entries());
      if (!data.name.trim()) { msg.innerHTML = '<div class="notice bad">Please enter your name.</div>'; return; }
      if (!data.phone.trim() && !data.email.trim()) { msg.innerHTML = '<div class="notice bad">Please enter a phone number or email so we can confirm.</div>'; return; }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        await api('/api/lead', { method: 'POST', body: { ...data, sms_consent: data.sms_consent === 'on', consent_text: data.sms_consent === 'on' ? smsInfo.consent_language : undefined,
          page_url: location.origin + location.pathname, kind: 'test_drive', vehicle_id: v.id, share_code: shareCode } });
        form.reset();
        msg.innerHTML = `<div class="form-ok">Thanks! Your request was sent${staff ? ' to ' + esc(staff.full_name.split(' ')[0]) : ''}. We'll be in touch shortly to confirm.</div>`;
      } catch (err) {
        msg.innerHTML = `<div class="notice bad">${esc(errMsg(err))} You can also call us at ${esc(d.phone || '')}.</div>`;
      } finally {
        btn.disabled = false; btn.textContent = 'Request test drive';
      }
    });
  }

  track(v, shareCode);
}

async function track(v, shareCode) {
  try {
    // Staff previewing a portfolio from the dashboard shouldn't count as a customer open
    const { data } = await sb.auth.getSession();
    if (data && data.session) return;
    let visitor = store('vp_visitor');
    if (!visitor) visitor = store('vp_visitor', uuid()) || uuid();
    await fetch('/api/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vehicle_id: v.id, share_code: shareCode, visitor_id: visitor, referrer: document.referrer || null }),
      keepalive: true,
    });
  } catch { /* tracking must never break the page */ }
}

function swipe(target, cb) {
  if (!target) return;
  let x0 = null, y0 = null;
  target.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  target.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) cb(dx < 0 ? 1 : -1);
    x0 = null;
  });
}

function openLightbox(photos, start, title, onClose) {
  let i = start;
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Photo viewer');
  const render = () => {
    box.innerHTML = String(html`<img src="${photos[i].url}" alt="${title} photo ${i + 1}">
      <button class="close" aria-label="Close">✕</button>
      ${photos.length > 1 ? html`<button class="prev" aria-label="Previous">‹</button><button class="next" aria-label="Next">›</button>` : ''}
      <div class="count">${i + 1} / ${photos.length}</div>`);
  };
  const close = () => { box.remove(); document.removeEventListener('keydown', key); document.body.style.overflow = ''; onClose(i); };
  const step = (n) => { i = (i + n + photos.length) % photos.length; render(); };
  const key = (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') step(1); if (e.key === 'ArrowLeft') step(-1); };
  box.addEventListener('click', (e) => {
    if (e.target.closest('.next')) step(1);
    else if (e.target.closest('.prev')) step(-1);
    else if (e.target.closest('.close') || e.target === box) close();
  });
  swipe(box, step);
  document.addEventListener('keydown', key);
  document.body.style.overflow = 'hidden';
  render();
  document.body.appendChild(box);
  box.querySelector('.close').focus();
}
