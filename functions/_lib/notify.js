// Phone/email helpers. All sending goes through _lib/messaging.js so every message is
// tied to a dealership, consent-checked, logged and costed.

export function normalizeUsPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (String(raw || '').trim().startsWith('+') && digits.length >= 8) return '+' + digits;
  return null;
}

export function splitEmails(s) {
  return String(s || '')
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
}

