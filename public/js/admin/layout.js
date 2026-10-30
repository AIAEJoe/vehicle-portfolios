// Admin shell: auth gate, dealership membership, top navigation.
import { sb, html, mount, must, loadDealership, loadingView, errMsg, config } from '../core.js';
import { navigate } from '../router.js';

let ctxCache = null;

export async function adminContext() {
  const { data } = await sb.auth.getSession();
  const session = data.session;
  if (!session) return null;
  if (ctxCache && ctxCache.user.id === session.user.id) return ctxCache;
  const dealership = await loadDealership();
  const member = must(await sb.from('dealership_members').select('role')
    .eq('dealership_id', dealership.id).eq('user_id', session.user.id).maybeSingle());
  const staff = must(await sb.from('staff').select('*').eq('dealership_id', dealership.id).eq('user_id', session.user.id).maybeSingle());
  const op = must(await sb.from('platform_admins').select('user_id').eq('user_id', session.user.id).maybeSingle());
  const role = member ? member.role : op ? 'support' : null;
  ctxCache = { user: session.user, dealership, role, isAdmin: ['owner', 'admin', 'support'].includes(role), isPhotographer: role === 'photographer', isPlatform: !!op, me: staff };
  return ctxCache;
}

export function resetAdminContext() { ctxCache = null; }

/**
 * Renders the admin chrome and returns { ctx, main } or null if redirected.
 */
export async function adminPage(el, active, { adminOnly = false, photographer = false } = {}) {
  mount(el, loadingView());
  let ctx;
  try {
    ctx = await adminContext();
  } catch (e) {
    mount(el, html`<div class="auth-wrap"><div class="card"><p>${errMsg(e)}</p></div></div>`);
    return null;
  }
  if (!ctx) {
    // Keep the #hash: when an emailed link fails, Supabase puts the reason there (error_description=…), and the
    // sign-in page shows it instead of a blank form.
    const hash = /error/.test(location.hash) ? location.hash : '';
    navigate(`/admin/login?next=${encodeURIComponent(location.pathname + location.search)}${hash}`, { replace: true });
    return null;
  }
  if (!ctx.role) {
    mount(el, html`<div class="auth-wrap"><div class="card">
      <h1>No access yet</h1>
      <p>You're signed in as <strong>${ctx.user.email}</strong>, but this account hasn't been added to
      <strong>${ctx.dealership.name}</strong>. Ask an admin to invite you from the Staff page.</p>
      <button class="btn alt" id="so">Sign out</button></div></div>`);
    el.querySelector('#so').onclick = signOut;
    return null;
  }
  // Photographers have one page: vehicle photos.
  if (ctx.isPhotographer && active !== 'shoot' && active !== 'account' && !photographer) {
    navigate('/admin/shoot', { replace: true });
    return null;
  }
  document.title = `Dashboard | ${ctx.dealership.name}`;
  const link = (href, label, key) => html`<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`;
  mount(el, html`<header class="admin-top no-print"><div class="in">
      <a class="brand" href="/admin">Vehicle Portfolios <small>${config.dealer}</small></a>
      <nav>${ctx.isPhotographer ? link('/admin/shoot', 'Photos', 'shoot') : html`
        ${link('/admin/vehicles', 'Vehicles', 'vehicles')}
        ${ctx.isAdmin ? link('/admin/shoot', 'Photos', 'shoot') : ''}
        <a href="/admin/inbox" class="${active === 'inbox' ? 'on' : ''}">Inbox<span id="unread-badge"></span></a>
        ${link('/admin/leads', 'Leads', 'leads')}
        ${link('/admin/staff', 'Staff', 'staff')}
        ${ctx.isAdmin ? link('/admin/usage', 'Usage', 'usage') : ''}
        ${ctx.isAdmin ? link('/admin/settings', 'Settings', 'settings') : ''}
        ${ctx.isPlatform ? link('/platform', 'Platform', 'platform') : ''}`}
      </nav>
      <a class="me" href="/admin/account" title="${ctx.user.email}">Account</a>
    </div></header>
    <main class="admin-main" id="admin-main"></main>`);
  const main = el.querySelector('#admin-main');
  if (!ctx.isPhotographer) sb.from('customers').select('unread_count').eq('dealership_id', ctx.dealership.id).gt('unread_count', 0).then(({ data }) => {
    const n = (data || []).reduce((a, c) => a + c.unread_count, 0);
    const b = el.querySelector('#unread-badge');
    if (b && n) b.outerHTML = `<span class="nav-badge">${n}</span>`;
  });
  if (adminOnly && !ctx.isAdmin) {
    mount(main, html`<div class="card">Only dealership admins can open this page.</div>`);
    return null;
  }
  return { ctx, main };
}

export async function signOut() {
  await sb.auth.signOut();
  resetAdminContext();
  navigate('/admin/login', { replace: true });
}

export const STATUS_LABEL = { draft: 'Draft', published: 'Live', sold: 'Sold', archived: 'Archived' };
