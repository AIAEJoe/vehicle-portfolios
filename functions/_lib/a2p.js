// Twilio ISV onboarding for one dealership (architecture #1: one subaccount per dealership).
// Follows https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api
// Each step is idempotent: the SID it creates is saved before moving on, so the runner can be
// re-run after fixing data, and stops at review waits or when Twilio reports a problem.
import { sb, HttpError } from './util.js';
import { twilio, platformCreds, dealerTwilio, API, MESSAGING, TRUSTHUB } from './twilio.js';
import { encryptSecret } from './crypto.js';
import { normalizeUsPhone } from './notify.js';

export const SECONDARY_PROFILE_POLICY = 'RNdfbf3fae0e1107f8aded0e7cead80bf5';
export const A2P_TRUST_PRODUCT_POLICY = 'RNb0d4771c2c98518d916a3d4cd70a8f8b';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const STEPS = [
  'customer_profile', 'business_info', 'assign_business_info', 'authorized_rep', 'assign_authorized_rep',
  'address', 'address_document', 'assign_address_document', 'assign_primary_profile', 'evaluate_profile', 'submit_profile',
  'trust_product', 'messaging_profile_info', 'assign_messaging_profile_info', 'assign_customer_profile',
  'evaluate_trust_product', 'submit_trust_product', 'brand', 'wait_brand', 'campaign', 'wait_campaign', 'done',
];

export const STEP_LABELS = {
  customer_profile: 'Create Secondary Customer Profile', business_info: 'Business information', assign_business_info: 'Attach business information',
  authorized_rep: 'Authorized representative', assign_authorized_rep: 'Attach representative', address: 'Business address',
  address_document: 'Address document', assign_address_document: 'Attach address', assign_primary_profile: 'Link to your Primary Profile',
  evaluate_profile: 'Check profile', submit_profile: 'Submit profile for review', trust_product: 'Create A2P messaging profile',
  messaging_profile_info: 'Company type', assign_messaging_profile_info: 'Attach company type', assign_customer_profile: 'Attach customer profile',
  evaluate_trust_product: 'Check A2P profile', submit_trust_product: 'Submit A2P profile', brand: 'Register brand (TCR)',
  wait_brand: 'Brand review', campaign: 'Register campaign', wait_campaign: 'Campaign review', done: 'Approved',
};

/** What a dealership must fill in before registration can start. */
export function missingFields(p) {
  const need = {
    legal_name: 'Legal business name', ein: 'EIN', website_url: 'Website', street: 'Street', city: 'City', region: 'State',
    postal_code: 'ZIP', rep_first_name: 'Rep first name', rep_last_name: 'Rep last name', rep_email: 'Rep email',
    rep_phone: 'Rep phone', rep_title: 'Rep title', campaign_description: 'Campaign description', message_flow: 'How customers opt in',
  };
  const out = Object.entries(need).filter(([k]) => !p[k] || !String(p[k]).trim()).map(([, v]) => v);
  if (!p.sample_messages || p.sample_messages.filter(Boolean).length < 2) out.push('Two sample messages');
  return out;
}

export function registrationDefaults(dealership, origin) {
  const name = dealership.name;
  return {
    campaign_description: `${name} sends one-to-one text messages to customers who asked about a vehicle: links to the vehicle's photos and details, test-drive confirmations, and replies to their questions from their salesperson.`,
    message_flow: `Customers opt in on ${name}'s vehicle pages (${origin}/v/...) by checking an unchecked SMS consent box on the test-drive form, which shows the consent language and links to ${origin}/sms-terms, or by texting the dealership's number first. Salespeople may also text customers who give verbal consent in person or on the phone; the salesperson records that consent in the dashboard before the first text, with date, time and wording.`,
    sample_messages: [
      `Hi Mike, it's Kyleigh at ${name}. Here are the photos, details and history for the 2018 Jeep Wrangler Sport S: ${origin}/v/2018-jeep-wrangler-sport-s?s=Ab3dEf7h Reply STOP to opt out.`,
      `Hi Mike, your test drive of the 2018 Jeep Wrangler is confirmed for Saturday at 10am. See you at ${name}! Reply STOP to opt out.`,
    ],
    help_message: `${name}: for help call ${dealership.phone || 'the dealership'}. Msg & data rates may apply. Reply STOP to opt out.`,
  };
}

async function save(env, dealershipId, patch, logEntry) {
  if (logEntry) {
    const [cur] = await sb(env, `/rest/v1/messaging_profiles?dealership_id=eq.${dealershipId}&select=a2p_log`);
    const log = [...((cur && cur.a2p_log) || []), { at: new Date().toISOString(), ...logEntry }].slice(-60);
    patch = { ...patch, a2p_log: log };
  }
  const [row] = await sb(env, `/rest/v1/messaging_profiles?dealership_id=eq.${dealershipId}`, { method: 'PATCH', prefer: 'return=representation', body: patch });
  return row;
}

async function charge(env, dealershipId, kind, ref, description, cost) {
  const month = new Date().toISOString().slice(0, 7) + '-01';
  await sb(env, '/rest/v1/usage_charges?on_conflict=dealership_id,month,kind,ref', {
    method: 'POST', prefer: 'resolution=ignore-duplicates',
    body: { dealership_id: dealershipId, month, kind, ref, description, provider_cost: cost },
  });
}

/** Creates the dealership's subaccount + Messaging Service (webhooks pointing at this app). */
export async function provision(env, { dealership, profile, webhookBase }) {
  const parent = platformCreds(env);
  if (!parent) throw new HttpError(500, 'Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (your parent/ISV account) first.');
  let sub = profile.twilio_subaccount_sid;
  if (!sub) {
    const acct = await twilio(parent, 'POST', `${API}/Accounts.json`, { FriendlyName: `VP - ${dealership.name} (${dealership.slug})` });
    sub = acct.sid;
    await sb(env, '/rest/v1/provider_credentials', {
      method: 'POST', prefer: 'resolution=merge-duplicates',
      body: { dealership_id: dealership.id, provider: 'twilio', account_sid: acct.sid, secret_encrypted: await encryptSecret(env, acct.auth_token) },
    });
    profile = await save(env, dealership.id, { twilio_subaccount_sid: sub, a2p_status: 'in_progress' }, { step: 'subaccount', ok: true, sid: sub });
  }
  const creds = await subCreds(env, dealership.id);
  if (!profile.twilio_messaging_service_sid) {
    const svc = await twilio(creds, 'POST', `${MESSAGING}/Services`, {
      FriendlyName: `${dealership.name} - Vehicle Portfolios`,
      InboundRequestUrl: `${webhookBase}/api/twilio/inbound`, InboundMethod: 'POST',
      StatusCallback: `${webhookBase}/api/twilio/status`,
      UseInboundWebhookOnNumber: false,
    });
    profile = await save(env, dealership.id, { twilio_messaging_service_sid: svc.sid }, { step: 'messaging_service', ok: true, sid: svc.sid });
  }
  return profile;
}

export async function subCreds(env, dealershipId) {
  const { creds } = await dealerTwilio(env, dealershipId);
  if (!creds) throw new HttpError(400, 'Create the Twilio subaccount first');
  return creds;
}

/** Runs registration steps until a review wait, an error, or the end. */
export async function runSteps(env, { dealership, profile, webhookBase, origin, maxSteps = 25, pause = sleep }) {
  if (!profile.twilio_subaccount_sid || !profile.twilio_messaging_service_sid) profile = await provision(env, { dealership, profile, webhookBase });
  const missing = missingFields(profile);
  if (missing.length) throw new HttpError(400, `Fill in: ${missing.join(', ')}`);
  const creds = await subCreds(env, dealership.id);
  const ran = [];

  for (let i = 0; i < maxSteps; i++) {
    const step = profile.a2p_step === 'not_started' ? STEPS[0] : profile.a2p_step;
    if (step === 'done') break;
    let result;
    try {
      result = await runStep(env, { step, creds, dealership, profile, origin, pause });
    } catch (err) {
      profile = await save(env, dealership.id, { a2p_status: 'action_needed', a2p_last_error: `${STEP_LABELS[step]}: ${err.message}` },
        { step, ok: false, error: err.message, code: err.code || null });
      ran.push({ step, ok: false, error: err.message });
      break;
    }
    const next = result.wait ? step : STEPS[STEPS.indexOf(step) + 1];
    profile = await save(env, dealership.id, { ...result.patch, a2p_step: next, a2p_last_error: result.error || null },
      { step, ok: !result.error, ...(result.log || {}) });
    ran.push({ step, ok: !result.error, wait: !!result.wait });
    if (result.wait || result.error) break;
  }
  return { profile, ran };
}

async function runStep(env, { step, creds, dealership, profile: p, origin, pause }) {
  const th = (method, path, params, headers) => twilio(creds, method, `${TRUSTHUB}${path}`, params, headers);
  const email = env.PLATFORM_COMPLIANCE_EMAIL || 'compliance@aiautoengine.com';
  switch (step) {
    case 'customer_profile': {
      const r = await th('POST', '/CustomerProfiles', { PolicySid: SECONDARY_PROFILE_POLICY, FriendlyName: `${p.legal_name} (${dealership.slug})`, Email: email });
      return { patch: { a2p_customer_profile_sid: r.sid, a2p_status: 'in_progress' }, log: { sid: r.sid } };
    }
    case 'business_info': {
      const r = await th('POST', '/EndUsers', {
        FriendlyName: `${p.legal_name} business info`, Type: 'customer_profile_business_information',
        Attributes: {
          business_name: p.legal_name, business_identity: 'direct_customer', business_industry: p.business_industry || 'AUTOMOTIVE',
          business_registration_identifier: 'EIN', business_registration_number: String(p.ein).replace(/[^0-9]/g, ''),
          business_type: p.business_type || 'Corporation', business_regions_of_operation: 'USA_AND_CANADA', website_url: p.website_url,
          social_media_profile_urls: '',
        },
      });
      return { patch: { a2p_business_enduser_sid: r.sid }, log: { sid: r.sid } };
    }
    case 'assign_business_info':
      await th('POST', `/CustomerProfiles/${p.a2p_customer_profile_sid}/EntityAssignments`, { ObjectSid: p.a2p_business_enduser_sid });
      return { patch: {} };
    case 'authorized_rep': {
      const r = await th('POST', '/EndUsers', {
        FriendlyName: `${p.rep_first_name} ${p.rep_last_name}`, Type: 'authorized_representative_1',
        Attributes: { first_name: p.rep_first_name, last_name: p.rep_last_name, email: p.rep_email, phone_number: normalizeUsPhone(p.rep_phone) || p.rep_phone,
          business_title: p.rep_title, job_position: p.rep_job_position || 'GM' },
      });
      return { patch: { a2p_rep_enduser_sid: r.sid }, log: { sid: r.sid } };
    }
    case 'assign_authorized_rep':
      await th('POST', `/CustomerProfiles/${p.a2p_customer_profile_sid}/EntityAssignments`, { ObjectSid: p.a2p_rep_enduser_sid });
      return { patch: {} };
    case 'address': {
      const r = await twilio(creds, 'POST', `${API}/Accounts/${creds.sid}/Addresses.json`, {
        CustomerName: p.legal_name, Street: p.street, City: p.city, Region: p.region, PostalCode: p.postal_code, IsoCountry: 'US',
      });
      return { patch: { twilio_address_sid: r.sid }, log: { sid: r.sid } };
    }
    case 'address_document': {
      const r = await th('POST', '/SupportingDocuments', { FriendlyName: `${p.legal_name} address`, Type: 'customer_profile_address', Attributes: { address_sids: p.twilio_address_sid } });
      return { patch: { a2p_address_document_sid: r.sid }, log: { sid: r.sid } };
    }
    case 'assign_address_document':
      await th('POST', `/CustomerProfiles/${p.a2p_customer_profile_sid}/EntityAssignments`, { ObjectSid: p.a2p_address_document_sid });
      return { patch: {} };
    case 'assign_primary_profile':
      if (!env.TWILIO_PRIMARY_CUSTOMER_PROFILE_SID) throw new HttpError(500, 'Set TWILIO_PRIMARY_CUSTOMER_PROFILE_SID (your approved Primary Customer Profile, BU…)');
      await th('POST', `/CustomerProfiles/${p.a2p_customer_profile_sid}/EntityAssignments`, { ObjectSid: env.TWILIO_PRIMARY_CUSTOMER_PROFILE_SID });
      return { patch: {} };
    case 'evaluate_profile': {
      const r = await th('POST', `/CustomerProfiles/${p.a2p_customer_profile_sid}/Evaluations`, { PolicySid: SECONDARY_PROFILE_POLICY });
      if (r.status !== 'compliant') throw new HttpError(422, `Twilio says the profile is incomplete: ${evaluationProblems(r)}`);
      return { patch: {} };
    }
    case 'submit_profile':
      await th('POST', `/CustomerProfiles/${p.a2p_customer_profile_sid}`, { Status: 'pending-review' });
      return { patch: {} };
    case 'trust_product': {
      const r = await th('POST', '/TrustProducts', { PolicySid: A2P_TRUST_PRODUCT_POLICY, FriendlyName: `${p.legal_name} A2P`, Email: email });
      return { patch: { a2p_trust_product_sid: r.sid }, log: { sid: r.sid } };
    }
    case 'messaging_profile_info': {
      const attrs = { company_type: p.company_type || 'private' };
      if (attrs.company_type === 'public') Object.assign(attrs, { stock_exchange: p.stock_exchange, stock_ticker: p.stock_ticker, brand_contact_email: p.rep_email });
      const r = await th('POST', '/EndUsers', { FriendlyName: `${p.legal_name} messaging profile`, Type: 'us_a2p_messaging_profile_information', Attributes: attrs });
      return { patch: { a2p_trust_enduser_sid: r.sid }, log: { sid: r.sid } };
    }
    case 'assign_messaging_profile_info':
      await th('POST', `/TrustProducts/${p.a2p_trust_product_sid}/EntityAssignments`, { ObjectSid: p.a2p_trust_enduser_sid });
      return { patch: {} };
    case 'assign_customer_profile':
      await th('POST', `/TrustProducts/${p.a2p_trust_product_sid}/EntityAssignments`, { ObjectSid: p.a2p_customer_profile_sid });
      return { patch: {} };
    case 'evaluate_trust_product': {
      const r = await th('POST', `/TrustProducts/${p.a2p_trust_product_sid}/Evaluations`, { PolicySid: A2P_TRUST_PRODUCT_POLICY });
      if (r.status !== 'compliant') throw new HttpError(422, `Twilio says the A2P profile is incomplete: ${evaluationProblems(r)}`);
      return { patch: {} };
    }
    case 'submit_trust_product':
      await th('POST', `/TrustProducts/${p.a2p_trust_product_sid}`, { Status: 'pending-review' });
      return { patch: {} };
    case 'brand': {
      await pause(1100); // Twilio asks for at most one brand/campaign request per second
      const r = await twilio(creds, 'POST', `${MESSAGING}/a2p/BrandRegistrations`, {
        CustomerProfileBundleSid: p.a2p_customer_profile_sid, A2PProfileBundleSid: p.a2p_trust_product_sid,
      });
      const r2 = await sb(env, '/rest/v1/platform_settings?id=eq.1&select=brand_registration_fee');
      await charge(env, dealership.id, 'brand_registration', r.sid, '10DLC Standard brand registration (one-time)', (r2[0] && r2[0].brand_registration_fee) || 46);
      return { patch: { a2p_brand_sid: r.sid, a2p_brand_status: r.status, a2p_status: 'brand_pending' }, log: { sid: r.sid, status: r.status } };
    }
    case 'wait_brand': {
      const r = await twilio(creds, 'GET', `${MESSAGING}/a2p/BrandRegistrations/${p.a2p_brand_sid}`);
      if (r.status === 'APPROVED') return { patch: { a2p_brand_status: r.status, a2p_status: 'brand_approved', a2p_last_checked_at: new Date().toISOString() }, log: { status: r.status } };
      if (r.status === 'FAILED' || r.status === 'SUSPENDED') {
        return { wait: true, error: `Brand ${r.status}: ${r.failure_reason || 'see Twilio Console'}`, patch: { a2p_brand_status: r.status, a2p_status: 'action_needed' }, log: { status: r.status } };
      }
      return { wait: true, patch: { a2p_brand_status: r.status, a2p_last_checked_at: new Date().toISOString() }, log: { status: r.status } };
    }
    case 'campaign': {
      await pause(1100);
      const r = await twilio(creds, 'POST', `${MESSAGING}/Services/${p.twilio_messaging_service_sid}/Compliance/Usa2p`, {
        BrandRegistrationSid: p.a2p_brand_sid,
        Description: p.campaign_description,
        MessageFlow: p.message_flow,
        MessageSamples: p.sample_messages.filter(Boolean).slice(0, 5),
        UsAppToPersonUsecase: p.campaign_usecase || 'MIXED',
        HasEmbeddedLinks: true,
        HasEmbeddedPhone: true,
        HelpMessage: p.help_message || undefined,
        PrivacyPolicyUrl: `${origin}/sms-terms#privacy`,
        TermsAndConditionsUrl: `${origin}/sms-terms`,
      }, { 'X-Twilio-Api-Version': 'v1.2' });
      const r2 = await sb(env, '/rest/v1/platform_settings?id=eq.1&select=campaign_vetting_fee');
      await charge(env, dealership.id, 'campaign_vetting', r.sid, '10DLC campaign vetting (one-time)', (r2[0] && r2[0].campaign_vetting_fee) || 15);
      return { patch: { a2p_campaign_sid: r.sid, a2p_campaign_status: r.campaign_status, a2p_status: 'campaign_pending' }, log: { sid: r.sid, status: r.campaign_status } };
    }
    case 'wait_campaign': {
      const r = await twilio(creds, 'GET', `${MESSAGING}/Services/${p.twilio_messaging_service_sid}/Compliance/Usa2p/${p.a2p_campaign_sid}`);
      const st = r.campaign_status;
      if (st === 'VERIFIED') {
        return { patch: { a2p_campaign_status: st, a2p_status: 'approved', sms_enabled: !!p.twilio_phone_number, a2p_last_checked_at: new Date().toISOString() }, log: { status: st } };
      }
      if (st === 'FAILED' || st === 'SUSPENDED') {
        const why = (r.errors || []).map((e) => e.description || e.error_code).join('; ');
        return { wait: true, error: `Campaign ${st}${why ? ': ' + why : ''}`, patch: { a2p_campaign_status: st, a2p_status: 'action_needed' }, log: { status: st } };
      }
      return { wait: true, patch: { a2p_campaign_status: st, a2p_last_checked_at: new Date().toISOString() }, log: { status: st } };
    }
    default:
      return { patch: {} };
  }
}

function evaluationProblems(r) {
  const out = [];
  for (const res of r.results || []) {
    for (const f of res.fields || []) if (!f.passed) out.push(`${res.friendly_name || res.object_type}: ${f.friendly_name || f.object_field}${f.failure_reason ? ' (' + f.failure_reason + ')' : ''}`);
  }
  return out.join('; ') || 'see Twilio Console → Trust Hub';
}

/** Buys a local SMS number in the dealership's subaccount and attaches it to its Messaging Service. */
export async function buyNumber(env, { dealership, profile, areaCode }) {
  const creds = await subCreds(env, dealership.id);
  if (profile.twilio_phone_number) throw new HttpError(400, `This dealership already has ${profile.twilio_phone_number}`);
  if (!profile.twilio_messaging_service_sid) throw new HttpError(400, 'Create the Messaging Service first');
  const avail = await twilio(creds, 'GET', `${API}/Accounts/${creds.sid}/AvailablePhoneNumbers/US/Local.json`,
    { AreaCode: areaCode || '', SmsEnabled: 'true', PageSize: '1' });
  const pick = avail.available_phone_numbers && avail.available_phone_numbers[0];
  if (!pick) throw new HttpError(404, `No SMS numbers available in area code ${areaCode}. Try a nearby one.`);
  const num = await twilio(creds, 'POST', `${API}/Accounts/${creds.sid}/IncomingPhoneNumbers.json`, { PhoneNumber: pick.phone_number, FriendlyName: dealership.name });
  await twilio(creds, 'POST', `${MESSAGING}/Services/${profile.twilio_messaging_service_sid}/PhoneNumbers`, { PhoneNumberSid: num.sid });
  const r2 = await sb(env, '/rest/v1/platform_settings?id=eq.1&select=phone_number_monthly');
  await charge(env, dealership.id, 'phone_number', num.sid, `Phone number ${num.phone_number}`, (r2[0] && r2[0].phone_number_monthly) || 1.15);
  return save(env, dealership.id, {
    twilio_phone_number: num.phone_number, twilio_phone_sid: num.sid,
    sms_enabled: profile.a2p_campaign_status === 'VERIFIED',
  }, { step: 'phone_number', ok: true, sid: num.sid, number: num.phone_number });
}
