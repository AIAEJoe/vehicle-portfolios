// Two-way customer conversations (texts + emails) for one dealership, with consent status and history.
import { sb, html, mount, must, api, $, on, errMsg, toast, timeAgo, dateTime, config } from '../core.js';
import { adminPage } from './layout.js';

const STATUS_ICON = { queued: '…', accepted: '…', sending: '…', sent: '✓', delivered: '✓✓', received: '', undelivered: '⚠ not delivered', failed: '⚠ failed', bounced: '⚠ bounced', complained: '⚠ marked spam' };
const fmtPhone = (p) => { const m = String(p || '').match(/^\+1(\d{3})(\d{3})(\d{4})$/); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p; };
const CONSENT_LABEL = { opted_in: 'OK to text', opted_out: 'Texted STOP', unknown: 'No text permission yet' };

export default async function inbox(el) {
  const page = await adminPage(el, 'inbox');
  if (!page) return;
  const { ctx, main } = page;
  const D = ctx.dealership.id;
  let customers = [];
  let lastMsg = {};
  let staff = [];
  let smsInfo = {};
  let current = new URLSearchParams(location.search).get('c');
  let filter = 'all';

  mount(main, html`<div class="page-head"><h1>Inbox</h1>
      <div class="btn-row"><select id="flt" style="width:auto" aria-label="Filter">
        <option value="all">All conversations</option><option value="unread">Unread</option><option value="mine">Assigned to me</option></select>
        <button class="btn sm" id="new">New message</button></div></div>
    <div id="sms-note"></div>
    <div class="inbox" id="ib"><div class="convos" id="convos"></div><div class="thread" id="thread"></div></div>`);

  async function loadList() {
    const [c, m, s, info] = await Promise.all([
      sb.from('customers').select('*').eq('dealership_id', D).order('last_message_at', { ascending: false, nullsFirst: false }).limit(300).then(must),
      sb.from('messages').select('customer_id,body,subject,direction,channel,created_at').eq('dealership_id', D).eq('audience', 'customer').order('created_at', { ascending: false }).limit(800).then(must),
      sb.from('staff').select('id,full_name,active').eq('dealership_id', D).order('full_name').then(must),
      sb.rpc('vp_public_sms_info', { p_slug: config.dealer }).then(must),
    ]);
    customers = c; staff = s; smsInfo = info || {};
    lastMsg = {};
    for (const x of m) if (x.customer_id && !lastMsg[x.customer_id]) lastMsg[x.customer_id] = x;
    $('#sms-note', main).innerHTML = smsInfo.sms_enabled ? '' : String(html`<div class="notice warn">Texting from ${smsInfo.phone || 'the dealership number'} turns on once 10DLC registration is approved. Email works now.</div>`);
    drawList();
  }

  function drawList() {
    let list = customers.filter((c) => lastMsg[c.id] || c.id === current);
    if (filter === 'unread') list = list.filter((c) => c.unread_count > 0);
    if (filter === 'mine') list = list.filter((c) => ctx.me && c.assigned_staff_id === ctx.me.id);
    mount($('#convos', main), list.length ? html`${list.map((c) => {
      const m = lastMsg[c.id] || {};
      return html`<a class="convo ${c.id === current ? 'on' : ''}" href="/admin/inbox?c=${c.id}" data-c="${c.id}">
        <div class="top"><strong>${c.full_name || fmtPhone(c.phone) || c.email}</strong>
          <span class="small sub">${c.unread_count ? html`<span class="unread">${c.unread_count}</span> ` : ''}${timeAgo(c.last_message_at || m.created_at)}</span></div>
        <div class="snip">${m.direction === 'outbound' ? 'You: ' : ''}${m.channel === 'email' ? `✉ ${m.subject || ''} ` : ''}${m.body || ''}</div></a>`;
    })}` : html`<p class="sub" style="padding:16px">No conversations yet. Replies to your texts and emails show up here.</p>`);
    $('#ib', main).classList.toggle('has-thread', !!current);
  }

  async function openThread(id) {
    current = id;
    history.replaceState({}, '', id ? `/admin/inbox?c=${id}` : '/admin/inbox');
    drawList();
    const box = $('#thread', main);
    if (!id) { mount(box, html`<p class="sub" style="padding:20px">Pick a conversation.</p>`); return; }
    mount(box, html`<div class="loading"><div class="spinner"></div></div>`);
    let c, msgs, consents;
    try {
      [c, msgs, consents] = await Promise.all([
        sb.from('customers').select('*').eq('id', id).eq('dealership_id', D).single().then(must),
        sb.from('messages').select('*').eq('customer_id', id).eq('audience', 'customer').order('created_at', { ascending: true }).limit(500).then(must),
        sb.from('consent_records').select('*').eq('customer_id', id).order('created_at', { ascending: true }).then(must),
      ]);
    } catch (e) { mount(box, html`<div class="notice bad">${errMsg(e)}</div>`); return; }
    if (c.unread_count) {
      sb.rpc('vp_mark_read', { p_customer_id: id }).then(() => { c.unread_count = 0; const x = customers.find((k) => k.id === id); if (x) x.unread_count = 0; drawList(); });
    }
    const timeline = [
      ...msgs.map((m) => ({ t: m.created_at, m })),
      ...consents.map((r) => ({ t: r.created_at, r })),
    ].sort((a, b) => String(a.t).localeCompare(String(b.t)));
    const recentInbound = c.last_inbound_at && Date.now() - new Date(c.last_inbound_at) < 72 * 3600e3;
    const needsAttest = c.sms_consent_status === 'unknown' && !recentInbound;

    mount(box, html`
      <div class="thread-head">
        <div><button class="btn ghost sm" id="back" aria-label="Back">←</button>
          <strong style="font-size:17px">${c.full_name || 'Customer'}</strong>
          <span class="small sub">${[fmtPhone(c.phone), c.email].filter(Boolean).join(' · ')}</span><br>
          <span class="consent-pill ${c.sms_consent_status}">${CONSENT_LABEL[c.sms_consent_status]}</span>
          ${c.email_opted_out ? html` <span class="consent-pill opted_out">Unsubscribed from email</span>` : ''}</div>
        <div class="btn-row">
          <select id="assign" style="width:auto;min-height:34px;padding:4px 8px" aria-label="Assigned salesperson">
            <option value="">Unassigned</option>${staff.filter((s) => s.active || s.id === c.assigned_staff_id).map((s) => html`<option value="${s.id}" ${s.id === c.assigned_staff_id ? 'selected' : ''}>${s.full_name}</option>`)}</select>
          ${c.sms_consent_status !== 'opted_out' ? html`<button class="btn alt sm" id="optout" title="Customer asked not to be texted">Do not text</button>` : ''}
        </div>
      </div>
      <div class="bubbles" id="bubbles">
        ${timeline.length ? timeline.map(({ m, r }) => r
          ? html`<div class="bubble sys">${r.action === 'opt_in' ? '✔' : '⛔'} ${r.channel === 'sms' ? 'Text' : 'Email'} ${r.action === 'opt_in' ? 'permission' : 'opt-out'} · ${methodLabel(r)} · ${dateTime(r.created_at)}</div>`
          : html`<div class="bubble ${m.direction === 'inbound' ? 'in' : 'out'} ${['failed', 'undelivered', 'bounced', 'complained'].includes(m.status) ? 'failed' : ''}">${m.channel === 'email' ? html`<strong>✉ ${m.subject || '(no subject)'}</strong>\n` : ''}${m.body || (m.num_media ? '[photo]' : '')}<span class="meta">${dateTime(m.created_at)} ${m.direction === 'outbound' ? STATUS_ICON[m.status] || m.status : ''}${m.channel === 'email' && m.direction === 'outbound' && m.opened_at ? ` · Email opened ${dateTime(m.opened_at)}${m.open_count > 1 ? ` (${m.open_count}×)` : ''}` : ''}${m.error_message ? ` · ${m.error_message}` : ''}</span></div>`)
          : html`<p class="sub">No messages yet.</p>`}
      </div>
      <form class="composer" id="compose">
        <div class="btn-row" style="margin-bottom:8px">
          <label class="check" style="margin:0"><input type="radio" name="channel" value="sms" ${c.phone ? 'checked' : 'disabled'}> Text</label>
          <label class="check" style="margin:0"><input type="radio" name="channel" value="email" ${!c.phone ? 'checked' : ''} ${c.email ? '' : 'disabled'}> Email</label>
        </div>
        <input name="subject" placeholder="Subject" class="hidden" id="subj" style="margin-bottom:6px">
        <textarea name="body" placeholder="Type a message…" aria-label="Message" required></textarea>
        ${needsAttest ? html`<label class="check small" id="attest-row"><input type="checkbox" name="attested"> ${c.full_name ? c.full_name.split(' ')[0] : 'The customer'} told me it's OK to text them</label>` : ''}
        <div class="btn-row" style="justify-content:space-between;margin-top:8px">
          <span class="small sub" id="seg"></span><button class="btn">Send</button></div>
      </form>`);

    const bubbles = $('#bubbles', box);
    bubbles.scrollTop = bubbles.scrollHeight;
    const form = $('#compose', box);
    const syncChannel = () => {
      const ch = form.channel.value;
      $('#subj', box).classList.toggle('hidden', ch !== 'email');
      const ar = $('#attest-row', box); if (ar) ar.classList.toggle('hidden', ch !== 'sms');
    };
    form.querySelectorAll('input[name=channel]').forEach((r) => r.addEventListener('change', syncChannel));
    syncChannel();
    form.body.addEventListener('input', () => {
      const n = form.body.value.length;
      $('#seg', box).textContent = form.channel.value === 'sms' && n ? `${n} characters · about ${n <= 160 ? 1 : Math.ceil(n / 153)} text segment${n > 160 ? 's' : ''}` : '';
    });
    $('#back', box).onclick = () => openThread(null);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button'); btn.disabled = true;
      try {
        const channel = form.channel.value;
        await api('/api/messages/send', {
          method: 'POST', auth: true,
          body: { channel, kind: 'conversation', customer_id: c.id, body: form.body.value, subject: form.subject.value,
                  consent: form.attested && form.attested.checked ? { attested: true, text: 'Salesperson confirmed the customer agreed to receive texts.' } : undefined },
        });
        toast(channel === 'sms' ? 'Text sent' : 'Email sent');
        await loadList();
        openThread(c.id);
      } catch (err) { toast(errMsg(err), 'bad'); btn.disabled = false; }
    });
    $('#assign', box).addEventListener('change', async (e) => {
      try { must(await sb.from('customers').update({ assigned_staff_id: e.target.value || null }).eq('id', c.id)); toast('Assigned'); }
      catch (err) { toast(errMsg(err), 'bad'); }
    });
    const opt = $('#optout', box);
    opt && opt.addEventListener('click', async () => {
      if (!confirm(`Stop all texts to ${c.full_name || c.phone}? Only the customer can undo this by texting START.`)) return;
      try {
        must(await sb.from('consent_records').insert({ dealership_id: D, customer_id: c.id, channel: 'sms', action: 'opt_out', method: 'staff_recorded',
          recorded_by: ctx.user.id, staff_id: ctx.me && ctx.me.id, notes: 'Customer asked not to be texted' }));
        openThread(c.id);
      } catch (err) { toast(errMsg(err), 'bad'); }
    });
  }

  function methodLabel(r) {
    return ({ web_form: 'checked the box on the website', verbal_attested: 'confirmed by staff', written: 'written consent', inbound_keyword: `texted ${r.keyword || 'a keyword'}`,
      reply_initiated: 'customer texted first', email_unsubscribe: 'clicked unsubscribe', email_complaint: 'marked as spam', staff_recorded: 'recorded by staff', import: 'imported' })[r.method] || r.method;
  }

  on(main, 'click', '.convo', (e, a) => { e.preventDefault(); openThread(a.dataset.c); });
  $('#flt', main).addEventListener('change', (e) => { filter = e.target.value; drawList(); });
  $('#new', main).addEventListener('click', () => newMessage());

  function newMessage() {
    mount($('#thread', main), html`<form class="composer" id="newform" style="border:0">
      <h2 class="section-title">New conversation</h2>
      <div class="grid3"><div><label for="nn">Name</label><input id="nn" name="name" required></div>
        <div><label for="np">Mobile</label><input id="np" name="phone" type="tel"></div>
        <div><label for="ne">Email</label><input id="ne" name="email" type="email"></div></div>
      <label for="nb">Message</label><textarea id="nb" name="body" required></textarea>
      <label class="check small"><input type="checkbox" name="attested"> The customer told me it's OK to text them (logged with your name and the time)</label>
      <div class="btn-row" style="margin-top:10px"><button class="btn" data-ch="sms">Send text</button><button class="btn alt" data-ch="email">Send email</button></div>
    </form>`);
    $('#ib', main).classList.add('has-thread');
    $('#newform', main).querySelectorAll('[data-ch]').forEach((b) => b.addEventListener('click', async (e) => {
      e.preventDefault();
      const f = $('#newform', main);
      const fd = Object.fromEntries(new FormData(f).entries());
      try {
        const r = await api('/api/messages/send', { method: 'POST', auth: true, body: {
          channel: b.dataset.ch, kind: 'conversation', customer: { name: fd.name, phone: fd.phone, email: fd.email }, body: fd.body,
          consent: fd.attested ? { attested: true, text: 'Salesperson confirmed the customer agreed to receive texts.' } : undefined } });
        toast('Sent');
        await loadList();
        openThread(r.customer.id);
      } catch (err) { toast(errMsg(err), 'bad'); }
    }));
  }

  try { await loadList(); } catch (e) { mount(main, html`<div class="notice bad">${errMsg(e)}</div>`); return; }
  openThread(current);
}
