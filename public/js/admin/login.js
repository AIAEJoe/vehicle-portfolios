import { sb, html, mount, $, errMsg, loadDealership, esc } from '../core.js';
import { navigate } from '../router.js';
import { resetAdminContext } from './layout.js';

export default async function login(el) {
  const next = new URLSearchParams(location.search).get('next') || '/admin/vehicles';
  // An emailed link that was already used, expired, or was opened by an email scanner lands here with the reason
  // in the URL (Supabase puts it in the #hash, or ?error= with newer links).
  const hashParams = new URLSearchParams(location.hash.slice(1));
  const q = new URLSearchParams(location.search);
  const linkError = hashParams.get('error_description') || q.get('error_description') || hashParams.get('error') || q.get('error');
  const linkExpired = linkError && /expired|invalid|otp|access_denied/i.test(linkError + (hashParams.get('error_code') || q.get('error_code') || ''));
  const { data } = await sb.auth.getSession();
  if (data.session) { navigate(next, { replace: true }); return; }
  let d = null;
  try { d = await loadDealership(); } catch { /* still allow sign-in */ }
  document.title = 'Sign in | Vehicle Portfolios';

  mount(el, html`<div class="auth-wrap">
    ${d && d.logo_url ? html`<p style="text-align:center"><img src="${d.logo_url}" alt="${d.name}" style="height:56px"></p>` : ''}
    <div class="card">
      <h1 style="margin-top:0;font-size:22px">Staff sign in</h1>
      ${linkError ? html`<div class="notice warn" id="link-error"><strong>${linkExpired ? 'That email link has expired or was already used.' : 'That email link didn\'t work.'}</strong>
        Links work once, so an email app that checks links can use it up. Enter your email below and tap <b>Email me a sign-in link</b>, then open the new email on this device. You'll be asked to set a password.</div>` : ''}
      <form id="pw">
        <label for="email">Email</label><input id="email" type="email" autocomplete="username" required>
        <label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required>
        <div class="hint">New here, or forgot your password? Enter your email and tap <b>Email me a sign-in link</b> below. You can set a password after.</div>
        <div id="msg"></div>
        <button class="btn block" style="margin-top:14px">Sign in</button>
      </form>
      <p style="text-align:center;margin:14px 0 0"><button class="btn ${linkError ? '' : 'ghost'} sm" id="magic">Email me a sign-in link${linkError ? '' : ' instead'}</button></p>
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
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: `${location.origin}/admin/account?welcome=1` } });
    msg.innerHTML = error ? `<div class="notice bad">${esc(/rate limit/i.test(errMsg(error)) ? 'Too many emails were sent in the last hour. Try again later, or ask your manager to send you a sign-in link from the Staff page.'
      : /signups not allowed|not found|user/i.test(errMsg(error)) ? 'That email doesn\'t have a login here yet. Ask your manager to invite you from the Staff page.' : errMsg(error))}</div>`
      : '<div class="notice ok">Check your email for a sign-in link and open it on this device. It works once.</div>';
  });
}
