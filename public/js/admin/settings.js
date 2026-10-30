// Dealership settings: profile & branding, lead routing (Elead ADF), open alerts, inventory feed.
import { sb, html, mount, must, api, $, errMsg, toast, copyText, clearDealerCache, dateTime, setBrand } from '../core.js';
import { adminPage, resetAdminContext } from './layout.js';
import { resizeImage, uploadFile } from './media.js';
import { warrantyProgramCard } from './warranty-program-card.js';

export default async function settings(el) {
  const page = await adminPage(el, 'settings', { adminOnly: true });
  if (!page) return;
  const { ctx, main } = page;
  const D = ctx.dealership.id;
  let d, s;
  async function load() {
    d = must(await sb.from('dealerships').select('*').eq('id', D).single());
    s = must(await sb.from('dealership_settings').select('*').eq('dealership_id', D).single());
  }
  try { await load(); } catch (e) { mount(main, html`<div class="notice bad">${errMsg(e)}</div>`); return; }

  function draw() {
    const ingestUrl = `${location.origin}/api/inventory/ingest?token=${s.feed_ingest_token}`;
    const r = s.feed_last_result;
    const field = (obj, name, label, type = 'text', hint = '', ph = '') => html`<div><label for="s-${name}">${label}</label>
      <input id="s-${name}" name="${name}" type="${type}" value="${obj[name] ?? ''}" placeholder="${ph}">${hint ? html`<div class="hint">${hint}</div>` : ''}</div>`;

    mount(main, html`<div class="page-head"><h1>Settings</h1></div>
    <div class="tabs"><button class="on">General</button><a class="btn ghost" href="/admin/settings/messaging" style="border-radius:0">Texting &amp; email</a></div>

    <form class="card" id="profile"><h2>Dealership profile</h2>
      <div class="grid2 stack-sm">
        ${field(d, 'name', 'Dealership name')}${field(d, 'website', 'Website', 'url')}
        ${field(d, 'phone', 'Main phone', 'tel')}${field(d, 'sms_phone', 'Text-enabled number', 'tel', 'Used for "Text" buttons when a vehicle has no salesperson.')}
        ${field(d, 'email', 'Public email', 'email')}${field(d, 'hours', 'Showroom hours')}
        ${field(d, 'address_line', 'Street address')}${field(d, 'city', 'City')}
        ${field(d, 'state', 'State')}${field(d, 'zip', 'ZIP')}
      </div>
      <label for="s-default_fees_note">Default fees / price disclaimer</label>
      <input id="s-default_fees_note" name="default_fees_note" value="${d.default_fees_note || ''}" placeholder="Plus tax, tag and dealer fees.">
      <div class="grid3">
        <div><label for="s-brand_primary">Brand color</label><input id="s-brand_primary" name="brand_primary" type="color" value="${d.brand_primary}"></div>
        <div><label for="s-brand_accent">Accent color</label><input id="s-brand_accent" name="brand_accent" type="color" value="${d.brand_accent}"></div>
        <div><label for="s-logo">Logo</label><input id="s-logo" name="logo" type="file" accept="image/*"></div>
      </div>
      ${d.logo_url ? html`<p><img src="${d.logo_url}" alt="Current logo" style="height:44px"></p>` : ''}
      <button class="btn" style="margin-top:12px">Save profile</button>
    </form>

    <form class="card" id="routing"><h2>Leads &amp; alerts</h2>
      ${field(s, 'lead_email', 'Email test-drive requests to', 'text', 'Comma-separate several addresses. The assigned salesperson is copied automatically.', 'sales@dealer.com, manager@dealer.com')}
      ${field(s, 'crm_adf_email', 'Elead ADF lead address', 'email', 'Each lead is also sent here as ADF/XML so it lands in Elead. Ask your Elead admin for the store’s ADF import address.', 'xxxxx@eleadtrack.net')}
      <label class="check"><input type="checkbox" name="notify_on_open" ${s.notify_on_open ? 'checked' : ''}> Alert the salesperson (text + email) when a customer opens their personal link</label>
      <div style="max-width:280px">${field(s, 'open_alert_cooldown_minutes', 'Wait between repeat alerts (minutes)', 'number')}</div>
      <button class="btn" style="margin-top:12px">Save</button>
      <p class="hint">Email and texts need RESEND_API_KEY and Twilio keys set in Cloudflare. See the README.</p>
    </form>

    <form class="card" id="bg"><h2>FTC Buyers Guide</h2>
      <p class="sub small">Shown on every used vehicle page and printed for the window. Vehicle-specific warranty terms are set on each vehicle's <b>Buyers Guide</b> tab.</p>
      <div class="grid2 stack-sm">
        ${field(d, 'bg_complaint_name', 'Complaints after sale: name or position', 'text', 'For example "General Manager" or a person\'s name.', 'General Manager')}
        ${field(d, 'bg_complaint_phone', 'Complaints after sale: phone', 'tel', 'Until set, the dealership\'s main phone is shown.')}
      </div>
      <label for="s-bg_default_warranty">Default for vehicles without their own warranty terms</label>
      <select id="s-bg_default_warranty" name="bg_default_warranty">
        <option value="" ${!d.bg_default_warranty ? 'selected' : ''}>None. Show "As Is" and flag the vehicle as warranty data pending</option>
        <option value="as_is" ${d.bg_default_warranty === 'as_is' ? 'selected' : ''}>As Is - no dealer warranty</option>
        <option value="implied_only" ${d.bg_default_warranty === 'implied_only' ? 'selected' : ''}>Implied warranties only</option>
      </select>
      <div class="hint">Choose only what you actually do. Some states limit or prohibit "as is" sales; in those states use "Implied warranties only".</div>
      <label class="check"><input type="checkbox" name="bg_default_service_contract" ${d.bg_default_service_contract ? 'checked' : ''}> We offer service contracts on our used vehicles (applies to vehicles without their own terms)</label>
      <label class="check"><input type="checkbox" name="bg_signature_line" ${d.bg_signature_line ? 'checked' : ''}> Add the optional buyer signature line to the guide</label>
      <button class="btn" style="margin-top:12px">Save Buyers Guide settings</button>
    </form>
    <div id="wp"></div>

    <form class="card" id="ws"><h2>Window stickers</h2>
      <label for="s-sticker_disclaimer">Small print at the bottom of every dealer window sticker</label>
      <textarea id="s-sticker_disclaimer" name="sticker_disclaimer" rows="3" placeholder="Prices exclude tax, tag, title and dealer fees. Rebates subject to change; see dealer for details.">${d.sticker_disclaimer || ''}</textarea>
      <div class="hint">Keep it accurate for every vehicle. Warranty terms belong on the Buyers Guide, not here.</div>
      <button class="btn" style="margin-top:12px">Save window sticker settings</button>
    </form>

    <div class="card"><h2>Inventory feed (HomeNet / vAuto)</h2>
      <form id="feed">
        ${field(s, 'feed_url', 'Feed URL (HTTPS)', 'url', 'The CSV download link from HomeNet/vAuto. It’s checked every hour.', 'https://…/inventory.csv')}
        <div class="grid2 stack-sm">
          ${field(s, 'feed_auth_header', 'Authorization header (optional)', 'text', 'Only if the feed URL needs a password, e.g. "Basic dXNlcjpwYXNz".')}
          ${field(s, 'feed_dealer_id', 'Only rows with DealerId (optional)', 'text', 'If the file contains several stores.')}
        </div>
        <label class="check"><input type="checkbox" name="feed_auto_publish" ${s.feed_auto_publish ? 'checked' : ''}> Publish new vehicles from the feed automatically</label>
        <label class="check"><input type="checkbox" name="feed_mark_missing_sold" ${s.feed_mark_missing_sold ? 'checked' : ''}> Mark vehicles sold when they drop out of the feed</label>
        <div class="btn-row" style="margin-top:12px"><button class="btn">Save feed settings</button>
          <button type="button" class="btn alt" id="sync" ${s.feed_url ? '' : 'disabled'}>Sync now</button></div>
      </form>
      <div style="margin-top:16px">
        <strong>Last sync:</strong> ${s.feed_last_sync_at ? dateTime(s.feed_last_sync_at) : 'never'}
        ${r ? (r.error ? html`<div class="notice bad">Last attempt failed (${r.source}, ${dateTime(r.at)}): ${r.error}</div>`
          : html`<div class="notice ok">${r.rows} vehicles in feed · ${r.inserted} added · ${r.updated} updated · ${r.marked_sold} marked sold${r.locked ? ` · ${r.locked} locked` : ''}${r.skipped ? ` · ${r.skipped} skipped (no valid VIN)` : ''} (${r.source})</div>`) : ''}
      </div>
      <h3 style="font-size:16px;margin-top:20px">Receive the feed by SFTP</h3>
      <p class="small sub">For providers that can only send by SFTP (Dealer Inspire, HomeNet). Give them the SFTP host and password from Vehicle Portfolios support, plus:</p>
      <ul class="small" style="margin-top:0">
        <li>Username: <strong>${d.slug}</strong></li>
        <li>Upload folder: their home folder (no subfolder needed)</li>
        <li>File: CSV or tab-delimited with a header row, full inventory, any file name ending in .csv or .txt</li>
      </ul>
      <p class="small sub">Each upload is imported within a minute. Results show under "Last sync" above as "sftp: &lt;file name&gt;".</p>
      <h3 style="font-size:16px;margin-top:20px">Upload a feed file by hand</h3>
      <form id="upload" class="copy-field"><input type="file" name="file" accept=".csv,.txt,text/csv" required aria-label="CSV file"><button class="btn alt">Upload &amp; sync</button></form>
      <h3 style="font-size:16px;margin-top:20px">Relay address (if HomeNet can only send by FTP)</h3>
      <p class="small sub">Point an FTP-to-HTTPS relay at this address (POST the CSV). Keep it private: it includes your secret token.</p>
      <div class="copy-field"><input readonly value="${ingestUrl}" aria-label="Ingest URL"><button type="button" class="btn alt sm" id="copy-ingest">Copy</button></div>
    </div>`);

    $('#copy-ingest', main).onclick = () => copyText(ingestUrl);

    $('#profile', main).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const patch = {};
      for (const k of ['name', 'website', 'phone', 'sms_phone', 'email', 'hours', 'address_line', 'city', 'state', 'zip', 'default_fees_note', 'brand_primary', 'brand_accent']) {
        patch[k] = String(fd.get(k) ?? '').trim() || null;
      }
      if (!patch.name) { toast('Dealership name is required', 'bad'); return; }
      try {
        const logo = fd.get('logo');
        if (logo && logo.size) patch.logo_url = (await uploadFile(D, 'brand', await resizeImage(logo, 800, 0.9))).url;
        d = must(await sb.from('dealerships').update(patch).eq('id', D).select().single());
        clearDealerCache(); resetAdminContext(); setBrand(d);
        toast('Profile saved');
        draw();
      } catch (err) { toast(errMsg(err), 'bad'); }
    });

    $('#ws', main).addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        d = must(await sb.from('dealerships').update({ sticker_disclaimer: String(new FormData(e.target).get('sticker_disclaimer') || '').trim() || null }).eq('id', D).select().single());
        clearDealerCache(); resetAdminContext();
        toast('Window sticker settings saved');
        draw();
      } catch (err) { toast(errMsg(err), 'bad'); }
    });
    $('#bg', main).addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const patch = {
        bg_complaint_name: String(fd.get('bg_complaint_name') || '').trim() || null,
        bg_complaint_phone: String(fd.get('bg_complaint_phone') || '').trim() || null,
        bg_default_warranty: fd.get('bg_default_warranty') || null,
        bg_default_service_contract: fd.get('bg_default_service_contract') === 'on',
        bg_signature_line: fd.get('bg_signature_line') === 'on',
      };
      try {
        d = must(await sb.from('dealerships').update(patch).eq('id', D).select().single());
        clearDealerCache(); resetAdminContext();
        toast('Buyers Guide settings saved. Reprint window guides for vehicles that use the default.');
        draw();
      } catch (err) { toast(errMsg(err), 'bad'); }
    });

    async function saveSettings(form, keys, checks) {
      const fd = new FormData(form);
      const patch = {};
      for (const k of keys) patch[k] = String(fd.get(k) ?? '').trim() || null;
      for (const k of checks) patch[k] = fd.get(k) === 'on';
      if ('open_alert_cooldown_minutes' in patch) patch.open_alert_cooldown_minutes = Math.max(0, parseInt(patch.open_alert_cooldown_minutes || '60', 10) || 60);
      s = must(await sb.from('dealership_settings').update(patch).eq('dealership_id', D).select().single());
      toast('Saved');
      draw();
    }
    $('#routing', main).addEventListener('submit', (e) => {
      e.preventDefault();
      saveSettings(e.target, ['lead_email', 'crm_adf_email', 'open_alert_cooldown_minutes'], ['notify_on_open']).catch((err) => toast(errMsg(err), 'bad'));
    });
    $('#feed', main).addEventListener('submit', (e) => {
      e.preventDefault();
      saveSettings(e.target, ['feed_url', 'feed_auth_header', 'feed_dealer_id'], ['feed_auto_publish', 'feed_mark_missing_sold']).catch((err) => toast(errMsg(err), 'bad'));
    });

    $('#sync', main).addEventListener('click', async (e) => {
      const b = e.target; b.disabled = true; b.textContent = 'Syncing…';
      try {
        const res = await api('/api/inventory/sync', { method: 'POST', auth: true });
        toast(`Feed synced: ${res.result.inserted} added, ${res.result.updated} updated`);
      } catch (err) { toast(errMsg(err), 'bad'); }
      await load(); draw();
    });
    $('#upload', main).addEventListener('submit', async (e) => {
      e.preventDefault();
      const b = e.target.querySelector('button'); b.disabled = true; b.textContent = 'Syncing…';
      try {
        const res = await api('/api/inventory/ingest', { method: 'POST', auth: true, raw: new FormData(e.target) });
        toast(`Feed synced: ${res.result.inserted} added, ${res.result.updated} updated`);
      } catch (err) { toast(errMsg(err), 'bad'); }
      await load(); draw();
    });
    warrantyProgramCard($('#wp', main), { dealership: d, onSaved: (prog) => { d.bg_program = prog; } });
  }
  draw();
}
