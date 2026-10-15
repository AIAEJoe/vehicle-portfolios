// Salespeople (shown on portfolios) and dashboard logins.
import { sb, html, mount, must, api, $, on, errMsg, toast, initials } from '../core.js';
import { adminPage, resetAdminContext } from './layout.js';
import { resizeImage, uploadFile } from './media.js';

export default async function staffPage(el) {
  const page = await adminPage(el, 'staff');
  if (!page) return;
  const { ctx, main } = page;
  const D = ctx.dealership.id;
  let people = [];
  let members = [];
  let editing = null; // staff row or {} for new

  async function load() {
    people = must(await sb.from('staff').select('*').eq('dealership_id', D).order('active', { ascending: false }).order('full_name'));
    members = ctx.isAdmin ? must(await sb.rpc('vp_members', { p_dealership_id: D })) : [];
    draw();
  }

  function draw() {
    const canEdit = (p) => ctx.isAdmin || (ctx.me && p.id === ctx.me.id);
    const memberEmail = (uid) => (members.find((m) => m.user_id === uid) || {}).email;
    mount(main, html`<div class="page-head"><h1>Staff</h1>${ctx.isAdmin ? html`<button class="btn" id="add">+ Add salesperson</button>` : ''}</div>
      ${editing ? form(editing) : ''}
      <div class="card"><h2>Salespeople</h2>
        ${people.length ? people.map((p) => html`<div class="share-item" style="align-items:center">
          <div class="person" style="margin:0">
            ${p.photo_url ? html`<img src="${p.photo_url}" alt="" style="width:52px;height:52px">` : html`<div class="avatar" style="width:52px;height:52px;font-size:18px">${initials(p.full_name)}</div>`}
            <div><strong>${p.full_name}</strong> ${p.active ? '' : html`<span class="pill">inactive</span>`}<br>
              <span class="small sub">${[p.title, p.phone, p.email].filter(Boolean).join(' · ')}</span><br>
              <span class="small sub">${p.user_id ? `Dashboard login: ${memberEmail(p.user_id) || 'yes'}` : 'No dashboard login'} · Alerts: ${[p.notify_sms && 'text', p.notify_email && 'email'].filter(Boolean).join(' + ') || 'off'}</span></div>
          </div>
          ${canEdit(p) ? html`<button class="btn alt sm" data-edit="${p.id}">Edit</button>` : ''}
        </div>`) : html`<p class="sub">No salespeople yet.</p>`}
      </div>
      ${ctx.isAdmin ? html`<div class="card"><h2>Dashboard logins</h2>
        ${members.map((m) => html`<div class="share-item"><span>${m.email} <span class="pill">${m.role}</span>
          ${people.find((p) => p.user_id === m.user_id) ? '' : html`<span class="small sub"> · not linked to a salesperson</span>`}</span>
          ${m.user_id !== ctx.user.id && m.role !== 'owner' ? html`<span class="btn-row">
            <select data-role="${m.user_id}" style="width:auto;min-height:34px;padding:4px 8px" aria-label="Role"><option value="sales" ${m.role === 'sales' ? 'selected' : ''}>Sales</option><option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Admin</option></select>
            <button class="btn danger sm" data-remove="${m.user_id}">Remove</button></span>` : ''}</div>`)}
        <form id="invite" style="margin-top:14px"><h3 style="font-size:16px;margin-bottom:0">Invite someone</h3>
          <div class="grid3"><div><label for="ie">Email</label><input id="ie" name="email" type="email" required></div>
          <div><label for="ir">Role</label><select id="ir" name="role"><option value="sales">Sales (vehicles, sharing, leads)</option><option value="admin">Admin (everything)</option></select></div>
          <div><label for="is">Link to salesperson</label><select id="is" name="staff_id"><option value="">None</option>${people.filter((p) => !p.user_id).map((p) => html`<option value="${p.id}">${p.full_name}</option>`)}</select></div></div>
          <button class="btn" style="margin-top:12px">Send invite</button>
          <p class="hint">They'll get an email to set a password. Turn off public sign-ups in Supabase so only invited people can join.</p>
        </form></div>` : ''}`);
  }

  function form(p) {
    return html`<form class="card" id="staff-form"><h2>${p.id ? `Edit ${p.full_name}` : 'New salesperson'}</h2>
      <div class="grid2 stack-sm">
        <div><label for="sn">Full name</label><input id="sn" name="full_name" value="${p.full_name || ''}" required></div>
        <div><label for="stt">Title</label><input id="stt" name="title" value="${p.title ?? 'Sales Consultant'}"></div>
        <div><label for="sp">Mobile phone</label><input id="sp" name="phone" type="tel" value="${p.phone || ''}"><div class="hint">Customers call/text this number, and open alerts are texted here.</div></div>
        <div><label for="se">Email</label><input id="se" name="email" type="email" value="${p.email || ''}"></div>
      </div>
      <label for="sph">Photo</label><input id="sph" name="photo" type="file" accept="image/*">
      ${p.photo_url ? html`<p><img src="${p.photo_url}" alt="" style="width:72px;height:72px;border-radius:50%;object-fit:cover"></p>` : ''}
      <label class="check"><input type="checkbox" name="notify_sms" ${p.notify_sms !== false ? 'checked' : ''}> Text me when a customer opens my link or requests a test drive</label>
      <label class="check"><input type="checkbox" name="notify_email" ${p.notify_email !== false ? 'checked' : ''}> Email me too</label>
      ${ctx.isAdmin ? html`<label class="check"><input type="checkbox" name="active" ${p.active !== false ? 'checked' : ''}> Active (shown on portfolios)</label>` : ''}
      <div class="btn-row" style="margin-top:14px"><button class="btn">Save</button><button type="button" class="btn ghost" id="cancel">Cancel</button>
      ${p.id && ctx.isAdmin ? html`<button type="button" class="btn danger" id="delstaff" style="margin-left:auto">Delete</button>` : ''}</div>
    </form>`;
  }

  on(main, 'click', '#add', () => { editing = {}; draw(); window.scrollTo(0, 0); });
  on(main, 'click', '[data-edit]', (e, b) => { editing = people.find((p) => p.id === b.dataset.edit); draw(); window.scrollTo(0, 0); });
  on(main, 'click', '#cancel', () => { editing = null; draw(); });
  on(main, 'click', '#delstaff', async () => {
    if (!confirm(`Delete ${editing.full_name}? Their vehicles and links will show no salesperson. (Tip: unticking "Active" hides them instead.)`)) return;
    try { must(await sb.from('staff').delete().eq('id', editing.id)); editing = null; await load(); }
    catch (err) { toast(errMsg(err), 'bad'); }
  });
  on(main, 'submit', '#staff-form', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const row = {
        full_name: String(fd.get('full_name')).trim(), title: String(fd.get('title') || '').trim() || null,
        phone: String(fd.get('phone') || '').trim() || null, email: String(fd.get('email') || '').trim() || null,
        notify_sms: fd.get('notify_sms') === 'on', notify_email: fd.get('notify_email') === 'on',
      };
      if (ctx.isAdmin) row.active = fd.get('active') === 'on';
      const photo = fd.get('photo');
      if (photo && photo.size) row.photo_url = (await uploadFile(D, 'staff', await resizeImage(photo, 600, 0.88))).url;
      if (editing.id) must(await sb.from('staff').update(row).eq('id', editing.id));
      else must(await sb.from('staff').insert({ ...row, dealership_id: D }));
      toast('Saved');
      editing = null;
      resetAdminContext();
      await load();
    } catch (err) { toast(errMsg(err), 'bad'); btn.disabled = false; }
  });
  on(main, 'submit', '#invite', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const r = await api('/api/invite', { method: 'POST', auth: true, body: fd });
      toast(r.invited ? `Invite sent to ${fd.email}` : `${fd.email} already had an account and now has access`);
      await load();
    } catch (err) { toast(errMsg(err), 'bad'); }
    finally { btn.disabled = false; }
  });
  on(main, 'change', '[data-role]', async (e, sel) => {
    try { must(await sb.from('dealership_members').update({ role: sel.value }).eq('dealership_id', D).eq('user_id', sel.dataset.role)); toast('Role updated'); }
    catch (err) { toast(errMsg(err), 'bad'); }
  });
  on(main, 'click', '[data-remove]', async (e, b) => {
    const m = members.find((x) => x.user_id === b.dataset.remove);
    if (!confirm(`Remove dashboard access for ${m.email}?`)) return;
    try {
      must(await sb.from('dealership_members').delete().eq('dealership_id', D).eq('user_id', m.user_id));
      await load();
    } catch (err) { toast(errMsg(err), 'bad'); }
  });

  try { await load(); } catch (e) { mount(main, html`<div class="notice bad">${errMsg(e)}</div>`); }
}
