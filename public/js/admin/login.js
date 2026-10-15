import { sb, html, mount, $, errMsg, loadDealership, esc } from '../core.js';
import { navigate } from '../router.js';
import { resetAdminContext } from './layout.js';

export default async function login(el) {
  const next = new URLSearchParams(location.search).get('next') || '/admin/vehicles';
  const { data } = await sb.auth.getSession();
  if (data.session) { navigate(next, { replace: true }); return; }
  let d = null;
  try { d = await loadDealership(); } catch { /* still allow sign-in */ }
  document.title = 'Sign in | Vehicle Portfolios';

  mount(el, html`<div class="auth-wrap">
    ${d && d.logo_url ? html`<p style="text-align:center"><img src="${d.logo_url}" alt="${d.name}" style="height:56px"></p>` : ''}
    <div class="card">
      <h1 style="margin-top:0;font-size:22px">Staff sign in</h1>
      <form id="pw">
        <label for="email">Email</label><input id="email" type="email" autocomplete="username" required>
        <label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required>
        <div id="msg"></div>
        <button class="btn block" style="margin-top:14px">Sign in</button>
      </form>
      <p style="text-align:center;margin:14px 0 0"><button class="btn ghost sm" id="magic">Email me a sign-in link instead</button></p>
    </div></div>`);

  const msg = $('#msg', el);
  $('#pw', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: $('#email', el).value.trim(), password: $('#password', el).value });
    btn.disabled = false;
    if (error) { msg.innerHTML = `<div class="notice bad">${error.message === 'Invalid login credentials' ? 'That email and password don\'t match.' : esc(errMsg(error))}</div>`; return; }
    resetAdminContext();
    navigate(next, { replace: true });
  });
  $('#magic', el).addEventListener('click', async () => {
    const email = $('#email', el).value.trim();
    if (!email) { msg.innerHTML = '<div class="notice warn">Enter your email first.</div>'; $('#email', el).focus(); return; }
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: `${location.origin}/admin/account` } });
    msg.innerHTML = error ? `<div class="notice bad">${esc(errMsg(error))}</div>` : '<div class="notice ok">Check your email for a sign-in link.</div>';
  });
}
