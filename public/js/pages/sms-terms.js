// Public SMS program terms + privacy for the dealership (linked from the consent box and the 10DLC campaign).
import { sb, html, mount, must, loadDealership, loadingView, errMsg, telHref } from '../core.js';
import { siteHeader, siteFooter } from './site.js';

export default async function smsTerms(el) {
  mount(el, loadingView());
  let d, info;
  try {
    d = await loadDealership();
    info = must(await sb.rpc('vp_public_sms_info', { p_slug: d.slug })) || {};
  } catch (e) { mount(el, html`<div class="loading">${errMsg(e)}</div>`); return; }
  document.title = `Text messaging terms | ${d.name}`;
  const num = info.phone || d.sms_phone || d.phone;
  mount(el, html`${siteHeader(d)}<main class="site-main">
    <section class="card"><h1 style="margin-top:0">Text messaging terms</h1>
      <p><strong>Program:</strong> ${d.name} customer texts, sent through Vehicle Portfolios.</p>
      <p><strong>What we text:</strong> links to vehicles you asked about, test-drive confirmations, and replies from your salesperson.</p>
      <p><strong>How you join:</strong> by checking the text-message box on one of our vehicle pages, by telling a salesperson it's OK to text you, or by texting us first${num ? html` at <a href="${telHref(num)}">${num}</a>` : ''}.</p>
      <p><strong>Message frequency</strong> varies with your conversation. <strong>Message and data rates may apply.</strong></p>
      <p><strong>To stop:</strong> reply <strong>STOP</strong> at any time. You'll get one confirmation text and no more messages. Reply <strong>START</strong> to rejoin.</p>
      <p><strong>For help:</strong> reply <strong>HELP</strong> or call ${d.phone ? html`<a href="${telHref(d.phone)}">${d.phone}</a>` : 'the dealership'}.</p>
      <p>Carriers are not liable for delayed or undelivered messages. Consent to receive texts is not a condition of any purchase.</p>
      <h2 id="consent">Consent wording</h2>
      <blockquote style="border-left:3px solid var(--accent);margin:0;padding:6px 12px">${info.consent_language}</blockquote>
    </section>
    <section class="card" id="privacy"><h2>Privacy</h2>
      <p>${d.name} uses your phone number, email and messages only to respond to your vehicle inquiry and to keep a record of your consent.
      <strong>We do not sell, rent or share your mobile number or text-messaging consent with third parties or affiliates for marketing purposes.</strong></p>
      <p>Your information is shared only with service providers that deliver our messages (such as our texting and email carriers) and our customer management system, and only to provide this service.</p>
      <p>We keep message history and consent records for as long as needed to serve you and meet legal requirements. To ask what we hold or to have it deleted, contact ${d.email ? html`<a href="mailto:${d.email}">${d.email}</a>` : d.name}${d.phone ? html` or call ${d.phone}` : ''}.</p>
    </section></main>${siteFooter(d)}`);
  if (location.hash) { const t = document.querySelector(location.hash); if (t) t.scrollIntoView(); }
}
