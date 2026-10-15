import { html, telHref } from '../core.js';

export function siteHeader(d) {
  return html`<header class="site-header">
    <a class="logo" href="/">${d.logo_url ? html`<img src="${d.logo_url}" alt="${d.name}">` : d.name}</a>
    ${d.phone ? html`<a class="phone" href="${telHref(d.phone)}">${d.phone}</a>` : ''}
  </header>`;
}

export function siteFooter(d) {
  const addr = [d.address_line, [d.city, d.state].filter(Boolean).join(', '), d.zip].filter(Boolean).join(' ');
  const mapUrl = addr ? `https://maps.google.com/?q=${encodeURIComponent(d.name + ' ' + addr)}` : null;
  return html`<footer class="site-footer">
    <strong>${d.name}</strong>${addr ? html` · <a href="${mapUrl}" target="_blank" rel="noopener">${addr}</a>` : ''}
    ${d.phone ? html` · <a href="${telHref(d.phone)}">${d.phone}</a>` : ''}
    ${d.hours ? html`<br>${d.hours}` : ''}
    <br><span class="small">Vehicle Portfolios</span>
  </footer>`;
}
