#!/usr/bin/env bash
# Restore a Supabase dump (from sync_from_supabase.sh) into fleet-postgres as
# a fresh database, then prove it matches the source row for row.
#
#   ./restore_to_fleet.sh <tag> <target_db> <public_base_url>
#
# 1. creates <target_db> owned by store_marieshair (refuses to touch a
#    database that already exists)
# 2. restores public/auth/storage with every object owned by store_marieshair
#    (no superuser-owned SECURITY DEFINER functions)
# 3. per-store RLS roles marieshair_anon / marieshair_authenticated with the
#    grants Supabase gave anon / authenticated; policies re-pointed to them
# 4. per-table count + md5 checksum compared with the source (taken from
#    Supabase in the same run), BEFORE any data is changed
# 5. rewrites Supabase Storage URLs to <public_base_url>/storage/v1/...
#    (triggers off, so updated_at values are untouched)
set -euo pipefail

TAG="$1"; DB="$2"; BASE="${3%/}"
OWNER=store_marieshair
ANON=marieshair_anon
AUTHN=marieshair_authenticated
DUMP=/root/maries-migration/dumps/maries_${TAG}.dump
OLD_URL=https://ejrnaowydwklwtfvwisq.supabase.co/storage/v1/
NEW_URL="$BASE/storage/v1/"
cd /root/maries-migration
[ -f "$DUMP" ] || { echo "missing $DUMP"; exit 1; }
[[ "$DB" =~ ^store_marieshair[a-z0-9_]*$ ]] || { echo "bad db name"; exit 1; }

PSQL() { docker exec -i fleet-postgres psql -U postgres -v ON_ERROR_STOP=1 -X -q "$@"; }

if [ "$(PSQL -Atc "select count(*) from pg_database where datname='$DB'")" != 0 ]; then
  echo "database $DB already exists; refusing to overwrite"; exit 1
fi

echo "== create $DB"
PSQL <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$ANON') THEN CREATE ROLE $ANON NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$AUTHN') THEN CREATE ROLE $AUTHN NOLOGIN NOINHERIT; END IF;
END \$\$;
GRANT $ANON, $AUTHN TO $OWNER;
CREATE DATABASE $DB OWNER $OWNER;
REVOKE ALL ON DATABASE $DB FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE $DB TO $OWNER;
SQL
PSQL -d "$DB" <<SQL
ALTER SCHEMA public OWNER TO $OWNER;
CREATE SCHEMA extensions AUTHORIZATION $OWNER;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO PUBLIC;
SQL
PSQL -c "ALTER DATABASE $DB SET search_path = public, extensions"
PSQL -c "ALTER DATABASE $DB SET timezone = 'UTC'"

echo "== restore"
# The dump is pg_dump 17 (Supabase runs 17); fleet-postgres is 16, so render
# it to SQL with pg_restore 17 and replay it through psql 16.
set +e
docker run --rm -v "$(dirname "$DUMP"):/dumps:ro" postgres:17 \
  pg_restore --no-owner --no-privileges --role="$OWNER" -f - "/dumps/$(basename "$DUMP")" \
  | docker exec -i fleet-postgres psql -U postgres -d "$DB" -X -q > /root/maries-migration/restore_${TAG}_${DB}.log 2>&1
rc=$?
set -e
echo "restore exit $rc; messages:"
grep -E "error|ERROR" /root/maries-migration/restore_${TAG}_${DB}.log | sort | uniq -c | head -40 || true

echo "== ownership, roles and grants"
PSQL -d "$DB" <<SQL
-- Anything the restore left owned by postgres moves to the app role.
DO \$\$ DECLARE r record; BEGIN
  FOR r IN SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname IN ('public','auth','storage') AND c.relkind IN ('r','p','v','m','S','f')
             AND pg_get_userbyid(c.relowner) <> '$OWNER' LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO $OWNER',
      CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      r.nspname, r.relname);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname IN ('public','auth','storage') AND pg_get_userbyid(p.proowner) <> '$OWNER' LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO $OWNER', r.sig);
  END LOOP;
END \$\$;
ALTER SCHEMA auth OWNER TO $OWNER;
ALTER SCHEMA storage OWNER TO $OWNER;

-- Policies written for Supabase's shared roles now name this store's roles.
DO \$\$ DECLARE p record; new_roles text[]; BEGIN
  FOR p IN SELECT schemaname, tablename, policyname, pol.roles FROM pg_policies pol
           WHERE schemaname IN ('public','storage') AND (roles && ARRAY['anon','authenticated','service_role']::name[]) LOOP
    new_roles := ARRAY(SELECT CASE r WHEN 'anon' THEN '$ANON' WHEN 'authenticated' THEN '$AUTHN' ELSE r END
                   FROM unnest(p.roles::text[]) r WHERE r <> 'service_role');
    IF array_length(new_roles,1) IS NULL THEN
      -- service_role-only policy: the owner bypasses RLS anyway; keep it inert.
      EXECUTE format('ALTER POLICY %I ON %I.%I TO $OWNER', p.policyname, p.schemaname, p.tablename);
    ELSE
      EXECUTE format('ALTER POLICY %I ON %I.%I TO %s', p.policyname, p.schemaname, p.tablename,
                     (SELECT string_agg(quote_ident(x), ', ') FROM unnest(new_roles) x));
    END IF;
  END LOOP;
END \$\$;

-- What Supabase granted anon/authenticated in public; RLS narrows it per row.
GRANT USAGE ON SCHEMA public, extensions TO $ANON, $AUTHN;
GRANT USAGE ON SCHEMA auth TO $ANON, $AUTHN;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.jwt(), auth.email() TO $ANON, $AUTHN;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO $ANON, $AUTHN;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO $ANON, $AUTHN;
ALTER DEFAULT PRIVILEGES FOR ROLE $OWNER IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $ANON, $AUTHN;
ALTER DEFAULT PRIVILEGES FOR ROLE $OWNER IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO $ANON, $AUTHN;

-- Functions: nothing callable by default. The browser may call only what
-- the policies and the one browser RPC need. Trigger functions fire without
-- an EXECUTE check, so they need no grant.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE $OWNER IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin_or_staff() TO $ANON, $AUTHN;
GRANT EXECUTE ON FUNCTION public.upsert_customer_from_order(text, text, text, text, text, uuid, jsonb) TO $ANON, $AUTHN;
SQL

echo "== security hardening"
docker exec -i fleet-postgres psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -X -q -c "SET ROLE $OWNER" -f - < /root/maries-migration/02_security_hardening.sql

echo "== safety checks"
PSQL -d "$DB" -At <<SQL
SELECT 'superuser-owned objects: ' || count(*) FROM (
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','auth','storage') AND pg_get_userbyid(c.relowner)='postgres'
  UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','auth','storage') AND pg_get_userbyid(p.proowner)='postgres') x;
SELECT 'public tables WITHOUT row level security: ' || coalesce(string_agg(relname, ', '), 'none')
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND relkind='r' AND NOT relrowsecurity;
SELECT 'policies still naming shared roles: ' || count(*) FROM pg_policies WHERE roles && ARRAY['anon','authenticated','service_role']::name[];
SQL

echo "== parity: count + checksum per table (before any rewrite)"
CHECK_SQL="select string_agg(format('select %L as t, count(*) as n, md5(coalesce(string_agg(x::text, %L order by x::text), %L)) as h from %I.%I x', schemaname||'.'||tablename, chr(30), '', schemaname, tablename), ' union all ') || ' order by 1;' from pg_tables where schemaname in ('public','auth','storage')"
docker exec -i -e PGTZ=UTC fleet-postgres psql -U postgres -d "$DB" -AtX -c "$CHECK_SQL" \
  | docker exec -i -e PGTZ=UTC fleet-postgres psql -U postgres -d "$DB" -AtX -F $'\t' -f - > "checks_${TAG}_target.tsv"
docker run --rm -i --env-file supa.env -e PGPASSWORD="$(cat .supabase-db-pw)" -e PGTZ=UTC postgres:17 psql -AtX -c "$CHECK_SQL" \
  | docker run --rm -i --env-file supa.env -e PGPASSWORD="$(cat .supabase-db-pw)" -e PGTZ=UTC postgres:17 psql -AtX -F $'\t' -f - > "checks_${TAG}_source.tsv"
echo "tables: source $(wc -l < checks_${TAG}_source.tsv), target $(wc -l < checks_${TAG}_target.tsv)"
if diff <(cut -f1,2,3 "checks_${TAG}_source.tsv" | LC_ALL=C sort) <(cut -f1,2,3 "checks_${TAG}_target.tsv" | LC_ALL=C sort) > "checks_${TAG}.diff"; then
  echo "PARITY OK: every table identical (rows + checksum)"
else
  echo "PARITY DIFFERENCES (source < > target):"; cat "checks_${TAG}.diff"
fi

echo "== rewrite storage URLs -> $NEW_URL"
PSQL -d "$DB" <<SQL
SET session_replication_role = replica;
DO \$\$ DECLARE c record; n bigint; total bigint := 0; BEGIN
  FOR c IN SELECT table_name, column_name, data_type FROM information_schema.columns
           WHERE table_schema='public' AND data_type IN ('text','character varying','jsonb','json','ARRAY') LOOP
    IF c.data_type IN ('jsonb','json') THEN
      EXECUTE format('UPDATE public.%I SET %I = replace(%I::text, %L, %L)::%s WHERE %I::text LIKE %L',
        c.table_name, c.column_name, c.column_name, '$OLD_URL', '$NEW_URL', c.data_type, c.column_name, '%$OLD_URL%');
    ELSIF c.data_type = 'ARRAY' THEN
      EXECUTE format('UPDATE public.%I SET %I = string_to_array(replace(array_to_string(%I, chr(31)), %L, %L), chr(31)) WHERE array_to_string(%I, chr(31)) LIKE %L',
        c.table_name, c.column_name, c.column_name, '$OLD_URL', '$NEW_URL', c.column_name, '%$OLD_URL%');
    ELSE
      EXECUTE format('UPDATE public.%I SET %I = replace(%I, %L, %L) WHERE %I LIKE %L',
        c.table_name, c.column_name, c.column_name, '$OLD_URL', '$NEW_URL', c.column_name, '%$OLD_URL%');
    END IF;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE NOTICE 'rewrote %.%: % rows', c.table_name, c.column_name, n; total := total + n; END IF;
  END LOOP;
  RAISE NOTICE 'total rows rewritten: %', total;
END \$\$;
SQL
echo "remaining supabase.co references:"
PSQL -d "$DB" -At <<SQL
DO \$\$ DECLARE c record; n bigint; BEGIN
  FOR c IN SELECT table_name, column_name FROM information_schema.columns
           WHERE table_schema='public' AND data_type IN ('text','character varying','jsonb','json','ARRAY') LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I::text LIKE %L', c.table_name, c.column_name, '%supabase.co%') INTO n;
    IF n > 0 THEN RAISE NOTICE '  %.%: %', c.table_name, c.column_name, n; END IF;
  END LOOP;
END \$\$;
SQL
PSQL -d "$DB" -c "ANALYZE"
echo "RESTORE DONE $DB"
