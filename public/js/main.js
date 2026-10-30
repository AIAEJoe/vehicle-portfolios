import { route, start } from './router.js';
import { configured, mount, html } from './core.js';

if (!configured) {
  mount(document.getElementById('app'), html`<div class="auth-wrap"><div class="card">
    <h1>Almost there</h1>
    <p>This site isn't connected to Supabase yet. Add <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code>
    to the Cloudflare Pages environment variables, then redeploy.</p></div></div>`);
} else {
  route('/', () => import('./pages/home.js'));
  route('/v/:slug', () => import('./pages/portfolio.js'));
  route('/v/:slug/buyers-guide', () => import('./pages/buyers-guide-print.js'));
  route('/admin', () => import('./admin/vehicles.js'));
  route('/admin/login', () => import('./admin/login.js'));
  route('/admin/account', () => import('./admin/account.js'));
  route('/admin/vehicles', () => import('./admin/vehicles.js'));
  route('/admin/vehicles/new', () => import('./admin/vehicle-new.js'));
  route('/admin/vehicles/:id', () => import('./admin/vehicle-edit.js'));
  route('/admin/vehicles/:id/print', () => import('./admin/print.js'));
  route('/admin/vehicles/:id/sticker', () => import('./admin/sticker-print.js'));
  route('/admin/vehicles/:id/factory-sheet', () => import('./admin/factory-sheet.js'));
  route('/admin/leads', () => import('./admin/leads.js'));
  route('/admin/staff', () => import('./admin/staff.js'));
  route('/admin/settings', () => import('./admin/settings.js'));
  route('/admin/settings/messaging', () => import('./admin/settings-messaging.js'));
  route('/admin/inbox', () => import('./admin/inbox.js'));
  route('/admin/usage', () => import('./admin/usage.js'));
  route('/platform', () => import('./platform/overview.js'));
  route('/platform/settings', () => import('./platform/settings.js'));
  route('/platform/dealerships/new', () => import('./platform/dealership-new.js'));
  route('/platform/dealerships/:id', () => import('./platform/dealership.js'));
  route('/sms-terms', () => import('./pages/sms-terms.js'));
  start();
}
