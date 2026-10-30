#!/bin/bash
# Spins up a throwaway Postgres 16, applies the migration + seed, runs RLS tests.
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PGBIN=/usr/lib/postgresql/16/bin
D=$(mktemp -d)
chown postgres "$D" 2>/dev/null || true
run() { if [ "$(id -u)" = 0 ]; then su postgres -c "$*"; else bash -c "$*"; fi; }
run "$PGBIN/initdb -D $D/data -A trust -U postgres >/dev/null"
run "$PGBIN/pg_ctl -D $D/data -o '-k $D -p 54329 -c listen_addresses=' -l $D/log start >/dev/null"
trap "run '$PGBIN/pg_ctl -D $D/data stop -m fast >/dev/null'; rm -rf $D" EXIT
P="psql -h $D -p 54329 -U postgres -v ON_ERROR_STOP=1 -q"
$P -c "create database vp"
$P -d vp -f "$ROOT/tests/sql/supabase_stub.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do $P -d vp -f "$f"; done
$P -d vp -f "$ROOT/supabase/seed.sql"
$P -d vp -f "$ROOT/supabase/seed.sql"   # idempotent
$P -d vp -f "$ROOT/tests/sql/rls_test.sql"
$P -d vp -f "$ROOT/tests/sql/messaging_test.sql"
$P -d vp -f "$ROOT/tests/sql/buyers_guide_test.sql"
$P -d vp -f "$ROOT/tests/sql/chomes_test.sql"
$P -d vp -f "$ROOT/tests/sql/window_sticker_test.sql"
$P -d vp -f "$ROOT/tests/sql/factory_data_test.sql"
$P -d vp -f "$ROOT/tests/sql/warranty_program_test.sql"
echo "SQL TESTS PASSED"
