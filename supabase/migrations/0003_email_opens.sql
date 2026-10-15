-- Email open tracking (Resend "email.opened" events). Informational only: Apple Mail
-- privacy protection pre-loads images, so an "open" doesn't prove the customer read it.
alter table public.messages add column if not exists opened_at timestamptz;
alter table public.messages add column if not exists open_count int not null default 0;
