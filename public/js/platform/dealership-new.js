import { html, mount, api, $, errMsg, toast } from '../core.js';
import { platformPage } from './layout.js';
import { navigate } from '../router.js';

export default async function dealershipNew(el) {
  const page = await platformPage(el, 'overview');
  if (!page) return;
  const { main } = page;
  mount(main, html`<div class="page-head"><h1>New dealership</h1><a class="btn ghost" href="/platform">Cancel</a></div>
    <form class="card" id="f">
      <div class="grid2 stack-sm">
        <div><label for="n">Dealership name</label><input id="n" name="name" required></div>
        <div><label for="s">Subdomain</label><div class="copy-field"><input id="s" name="slug" required placeholder="otherdealer"><span class="small sub" style="align-self:center">.aiautoengine.com</span></div></div>
        <div><label for="p">Main phone</label><input id="p" name="phone" type="tel"></div>
        <div><label for="w">Website</label><input id="w" name="website" type="url"></div>
        <div><label for="a">Street</label><input id="a" name="address_line"></div>
        <div><label for="c">City</label><input id="c" name="city"></div>
        <div><label for="st">State</label><input id="st" name="state" maxlength="2"></div>
        <div><label for="z">ZIP</label><input id="z" name="zip"></div>
        <div><label for="o">Owner's email (gets an invite)</label><input id="o" name="owner_email" type="email"></div>
      </div>
      <p class="hint">The dealership starts on the default plan from Rates &amp; plans. Add <code>slug.aiautoengine.com</code> as a custom domain on the Cloudflare Pages project.</p>
      <button class="btn" style="margin-top:10px">Create dealership</button>
    </form>`);
  $('#n', main).addEventListener('input', (e) => { const s = $('#s', main); if (!s.dataset.touched) s.value = e.target.value.toLowerCase().replace(/chevrolet/g, 'chevy').replace(/[^a-z0-9]+/g, '').slice(0, 30); });
  $('#s', main).addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
  $('#f', main).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/api/platform/dealerships', { method: 'POST', auth: true, body: Object.fromEntries(new FormData(e.target).entries()) });
      toast(`Created ${r.dealership.name}${r.invited ? ` · invite: ${r.invited}` : ''}`);
      navigate(`/platform/dealerships/${r.dealership.id}`);
    } catch (err) { toast(errMsg(err), 'bad'); }
  });
}
