import { html, mount } from '../core.js';
import { adminPage } from './layout.js';
import { renderMessagingSettings } from './messaging-settings.js';

export default async function settingsMessaging(el) {
  const page = await adminPage(el, 'settings', { adminOnly: true });
  if (!page) return;
  const { ctx, main } = page;
  mount(main, html`<div class="page-head"><h1>Settings</h1></div>
    <div class="tabs"><a class="btn ghost" href="/admin/settings" style="border-radius:0">General</a><button class="on">Texting &amp; email</button></div>
    <div id="ms"></div>`);
  await renderMessagingSettings(main.querySelector('#ms'), { dealership: ctx.dealership });
}
