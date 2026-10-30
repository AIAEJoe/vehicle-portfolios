// Printable FTC Buyers Guide: /v/<slug>/buyers-guide?lang=en|es
// Same data and renderer as the vehicle page, so the window guide and the website always match.
import { sb, html, mount, must, loadDealership, loadingView, errMsg, $ } from '../core.js';
import { renderBuyersGuide, needsBuyersGuide } from '../buyers-guide.js';

export default async function buyersGuidePrint(el, { slug }) {
  mount(el, loadingView());
  const lang = new URLSearchParams(location.search).get('lang') === 'es' ? 'es' : 'en';
  let d, v;
  try {
    d = await loadDealership();
    v = must(await sb.from('vehicles').select('*').eq('dealership_id', d.id).eq('slug', slug).maybeSingle());
    if (!v) throw new Error('This vehicle is not available.');
    if (!needsBuyersGuide(v)) throw new Error('A Buyers Guide is only required for used vehicles.');
  } catch (e) {
    mount(el, html`<div class="auth-wrap"><div class="card"><p>${errMsg(e)}</p></div></div>`);
    return;
  }
  document.title = `${lang === 'es' ? 'Guía del Comprador' : 'Buyers Guide'} · ${[v.year, v.make, v.model].filter(Boolean).join(' ')}${v.stock_number ? ` · ${v.stock_number}` : ''}`;
  const { front, back } = renderBuyersGuide(v, d, lang);
  mount(el, html`<div class="bg-print-page">
    <div class="no-print bg-tabs" style="max-width:8in;margin:0 auto 12px">
      <button class="btn" id="print">${lang === 'es' ? 'Imprimir' : 'Print'}</button>
      <a class="btn alt" href="?lang=${lang === 'es' ? 'en' : 'es'}">${lang === 'es' ? 'English' : 'Español'}</a>
      <span class="small sub">${lang === 'es' ? 'Página 1: frente. Página 2: dorso. Papel carta (8½" × 11"), escala 100%.' : 'Page 1 is the front, page 2 is the back. Letter (8½" × 11") paper, scale 100%.'}</span>
    </div>
    ${front}${back}
  </div>`);
  $('#print', el).addEventListener('click', () => window.print());
}
