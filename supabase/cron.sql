-- Hourly HomeNet/vAuto feed sync, run by Supabase itself (pg_cron + pg_net).
-- 1. Replace REPLACE_WITH_CRON_SECRET with the same value you set as CRON_SECRET in Cloudflare.
-- 2. Run this once in the Supabase SQL editor. Add one schedule per dealership subdomain.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'vp-feed-sync-nsbchevy',
  '7 * * * *',  -- every hour at :07
  $$
  select net.http_post(
    url := 'https://nsbchevy.aiautoengine.com/api/inventory/sync',
    headers := jsonb_build_object(
      'Authorization', 'Bearer REPLACE_WITH_CRON_SECRET',
      'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- To check runs:   select * from cron.job_run_details order by start_time desc limit 10;
-- To stop:         select cron.unschedule('vp-feed-sync-nsbchevy');

-- Daily at 03:15 UTC: reconcile real Twilio prices, book monthly number/campaign fees,
-- and refresh 10DLC review status for dealerships waiting on approval.
select cron.schedule(
  'vp-daily-reconcile',
  '15 3 * * *',
  $$
  select net.http_post(
    url := 'https://nsbchevy.aiautoengine.com/api/platform/reconcile',
    headers := jsonb_build_object('Authorization', 'Bearer REPLACE_WITH_CRON_SECRET', 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
