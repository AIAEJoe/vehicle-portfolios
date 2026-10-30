import { sb, html, mount, $, errMsg, toast, esc } from '../core.js';
import { adminPage, signOut } from './layout.js';

export default async function account(el) {
  const page = await adminPage(el, 'account');
  if (!page) return;
  const { ctx, main } = page;
  const fresh = /type=(invite|magiclink|recovery)/.test(location.hash) || new URLSearchParams(location.search).has('welcome');
  if (location.hash || location.search) history.replaceState({}, '', '/admin/account'); // don't leave tokens in the address bar
  mount(main, html`<div class="page-head"><h1>Your account</h1></div>
    <div class="card" style="max-width:520px">
      <p>Signed in as <strong>${ctx.user.email}</strong> · ${ctx.role} at ${ctx.dealership.name}</p>
      ${fresh ? html`<div class="notice ok">Welcome! Set a password below so you can sign in any time.</div>` : ''}
      <form id="pw">
        <label for="p1">New password</label><input id="p1" type="password" minlength="8" autocomplete="new-password" required>
        <label for="p2">Confirm password</label><input id="p2" type="password" minlength="8" autocomplete="new-password" required>
        <div id="msg"></div>
        <button class="btn" style="margin-top:12px">Save password</button>
      </form>
    </div>
    <div class="card" style="max-width:520px">
      ${ctx.me ? html`<p>Your salesperson profile: <strong>${ctx.me.full_name}</strong>. Customers see this on portfolios you share.</p>` :
        html`<p class="sub">Your login isn't linked to a salesperson profile yet. An admin can link it on the Staff page.</p>`}
      <button class="btn alt" id="so">Sign out</button>
    </div>`);
  $('#so', main).onclick = signOut;
  $('#pw', main).addEventListener('submit', async (e) => {
    e.preventDefault();
    const p1 = $('#p1', main).value, p2 = $('#p2', main).value;
    const msg = $('#msg', main);
    if (p1.length < 8) { msg.innerHTML = '<div class="notice bad">Use at least 8 characters.</div>'; return; }
    if (p1 !== p2) { msg.innerHTML = '<div class="notice bad">The passwords don\'t match.</div>'; return; }
    const { error } = await sb.auth.updateUser({ password: p1 });
    if (error) { msg.innerHTML = `<div class="notice bad">${esc(errMsg(error))}</div>`; return; }
    e.target.reset();
    msg.innerHTML = '';
    toast('Password saved');
  });
}
