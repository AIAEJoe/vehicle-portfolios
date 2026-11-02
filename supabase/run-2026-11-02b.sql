-- Fix: printing a window sticker for a car without a QR link failed with
-- "function gen_random_bytes(integer) does not exist". vp_qr_share runs with search_path = public, but Supabase keeps
-- pgcrypto in the "extensions" schema, so vp_short_code couldn't find gen_random_bytes. Pin its search path.
create or replace function public.vp_short_code(n int default 8) returns text
language plpgsql volatile set search_path = public, extensions, pg_catalog as $$
declare
  chars constant text := 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  out text := '';
  b bytea := gen_random_bytes(n);
begin
  for i in 0..n-1 loop
    out := out || substr(chars, 1 + (get_byte(b, i) % length(chars)), 1);
  end loop;
  return out;
end $$;
