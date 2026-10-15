// Platform console shell (operators only): every dealership, billing, onboarding, costs.
import { sb, html, mount, must, loadingView, errMsg } from '../core.js';
import { navigate } from '../router.js';

export async function platformPage(el, active) {
  mount(el, loadingView());
  const { data } = await sb.auth.getSession();
  if (!data.session) { navigate(`/admin/login?next=${encodeURIComponent(location.pathname)}`, { replace: true }); return null; }
  let op;
  try { op = must(await sb.from('platform_admins').select('user_id').eq('user_id', data.session.user.id).maybeSingle()); }
  catch (e) { mount(el, html`<div class="auth-wrap"><div class="card">${errMsg(e)}</div></div>`); return null; }
  if (!op) {
    mount(el, html`<div class="auth-wrap"><div class="card"><h1>Platform operators only</h1><p>Your account isn't a platform operator.</p><a class="btn alt" href="/admin">Go to the dealer dashboard</a></div></div>`);
    return null;
  }
  document.title = 'Platform | Vehicle Portfolios';
  const link = (href, label, key) => html`<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`;
  mount(el, html`<header class="admin-top" style="background:#0b1f44"><div class="in">
      <a class="brand" href="/platform">Vehicle Portfolios <small>platform</small></a>
      <nav>${link('/platform', 'Dealerships', 'overview')}${link('/platform/settings', 'Rates & plans', 'settings')}</nav>
      <a class="me" href="/admin">Dealer dashboard</a></div></header>
    <main class="admin-main" id="pmain"></main>`);
  return { user: data.session.user, main: el.querySelector('#pmain') };
}

export const usd = (n, d = 2) => (n === null || n === undefined ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
