#!/usr/bin/env bash
# Pull a fresh copy of the live Supabase project onto big-vps.
#
#   1. pg_dump (v17) of the public, auth and storage schemas
#   2. mirror every Storage object to STORAGE_DIR/<bucket>/<name> with a
#      .meta.json content-type sidecar (skips files already mirrored at the
#      same size, so a second run only fetches what changed)
#
# Runs on big-vps from /root/maries-migration, which holds supa.env and
# .supabase-db-pw (chmod 600). Usage: ./sync_from_supabase.sh <tag>
set -euo pipefail

cd /root/maries-migration
TAG="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"
DUMP_DIR=/root/maries-migration/dumps
STORAGE_DIR=/data/coolify/marieshair/storage
PROJECT_URL=https://ejrnaowydwklwtfvwisq.supabase.co
mkdir -p "$DUMP_DIR" "$STORAGE_DIR"

PG() { docker run --rm -i --env-file supa.env -e PGPASSWORD="$(cat .supabase-db-pw)" -v "$DUMP_DIR:/dumps" postgres:17 "$@"; }

echo "== dumping database ($TAG)"
PG pg_dump -Fc --no-owner --no-privileges -n public -n auth -n storage -f "/dumps/maries_${TAG}.dump"
# Exact row counts at dump time, for the parity check after restore.
PG psql -At -F $'\t' -c "
  select format('select %L, count(*) from %I.%I;', schemaname||'.'||tablename, schemaname, tablename)
  from pg_tables where schemaname in ('public','auth','storage') order by 1" \
  | PG psql -At -F $'\t' > "$DUMP_DIR/maries_${TAG}.counts"
ls -la "$DUMP_DIR/maries_${TAG}.dump"
wc -l "$DUMP_DIR/maries_${TAG}.counts"

echo "== mirroring storage"
PG psql -At -F $'\t' -c "
  select bucket_id, name, coalesce(metadata->>'mimetype','application/octet-stream'), coalesce(metadata->>'size','-1')
  from storage.objects where name not like '%.emptyFolderPlaceholder' order by 1,2" > "$DUMP_DIR/objects_${TAG}.tsv"
wc -l < "$DUMP_DIR/objects_${TAG}.tsv"

fetch_one() {
  local bucket="$1" name="$2" mime="$3" size="$4"
  local dest="$STORAGE_DIR/$bucket/$name"
  if [ -f "$dest" ] && [ "$size" != "-1" ] && [ "$(stat -c %s "$dest")" = "$size" ]; then return 0; fi
  mkdir -p "$(dirname "$dest")"
  local enc
  enc=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$name")
  if curl -fsS --retry 6 --retry-delay 5 --retry-all-errors -o "$dest.part" "$PROJECT_URL/storage/v1/object/public/$bucket/$enc"; then
    mv "$dest.part" "$dest"
    printf '{"contentType":"%s"}' "$mime" > "$dest.meta.json"
  else
    echo "FAILED $bucket/$name" >&2
    rm -f "$dest.part"
    return 1
  fi
}
export -f fetch_one
export STORAGE_DIR PROJECT_URL
fails=0
while IFS=$'\t' read -r b n m s; do printf '%s\0%s\0%s\0%s\0' "$b" "$n" "$m" "$s"; done < "$DUMP_DIR/objects_${TAG}.tsv" \
  | xargs -0 -n4 -P 4 bash -c 'fetch_one "$@"' _ || fails=1
chown -R 1001:1001 "$STORAGE_DIR"
echo "storage files: $(find "$STORAGE_DIR" -type f ! -name '*.meta.json' | wc -l)  size: $(du -sh "$STORAGE_DIR" | cut -f1)"
[ "$fails" = 0 ] && echo "SYNC OK $TAG" || { echo "SYNC HAD FAILURES $TAG"; exit 1; }
