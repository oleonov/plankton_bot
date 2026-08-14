#!/usr/bin/env bash
set -euo pipefail

# The API owns migration writes. This helper only freezes and proves the
# stopped-ledger census around migration 101.
readonly MARKER='101_repair_filled_phantom_orders.sql'
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

main() {
  [[ $# == 3 ]] || die 'usage: pre|post <target-sha> <snapshot-path>'
  local mode="$1" sha="$2" snapshot="$3"
  local db="${KRABS_ORDER_STATUS_LEDGER_PATH:-/var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db}"
  [[ "$mode" == pre || "$mode" == post ]] || die 'mode must be pre or post'
  [[ "$sha" =~ ^[0-9a-f]{40}$ && -f "$db" ]] || die 'target SHA or ledger is invalid'
  python3 - "$mode" "$db" "$snapshot" "$sha" "$MARKER" <<'PY'
import hashlib,json,os,sqlite3,sys
mode,db,snapshot,sha,marker=sys.argv[1:]
uri='file:'+os.path.abspath(db)+'?mode=ro'
con=sqlite3.connect(uri,uri=True)
con.execute('PRAGMA query_only=ON')
try:
    rows=[list(row) for row in con.execute('SELECT order_id,status,cancel_reason,metadata_json FROM orders ORDER BY order_id')]
    marker_count=con.execute('SELECT count(*) FROM schema_migrations WHERE name=?',(marker,)).fetchone()[0]
    invalid_identity=con.execute("""
      SELECT count(*) FROM orders
       WHERE status='cancelled' AND cancel_reason='phantom_missing_on_exchange'
         AND (exchange_order_id IS NULL OR exchange_order_id='' OR order_id<>exchange_order_id)""").fetchone()[0]
    candidates=[list(row) for row in con.execute("""
      SELECT o.order_id,o.cancel_reason,o.metadata_json FROM orders AS o
       WHERE o.status='cancelled' AND o.cancel_reason='phantom_missing_on_exchange'
         AND o.order_id=o.exchange_order_id AND o.exchange_order_id IS NOT NULL
         AND o.exchange_order_id<>'' AND o.size>0
         AND coalesce((SELECT sum(CASE
                                    WHEN f.side='buy' AND f.liquidity_role='taker'
                                     AND f.size_usdc>0 AND f.price>0 THEN f.size_usdc/f.price
                                    ELSE f.size
                                  END)
                        FROM fills AS f WHERE f.order_id=o.order_id),0)>=o.size*0.995
       ORDER BY o.order_id""")]
except sqlite3.Error as error:
    raise SystemExit('ledger census failed: '+str(error))
finally:
    con.close()
if marker_count not in (0,1): raise SystemExit('migration marker is not unique')
if invalid_identity: raise SystemExit('phantom repair identity is not exact')
if mode=='pre':
    if marker_count and candidates: raise SystemExit('applied migration retains repair candidates')
    payload={'schemaVersion':1,'targetSha':sha,'markerWasPresent':bool(marker_count),'rows':rows,'candidates':candidates}
    payload['rowsHash']=hashlib.sha256(json.dumps(rows,separators=(',',':')).encode()).hexdigest()
    payload['candidateHash']=hashlib.sha256(json.dumps(candidates,separators=(',',':')).encode()).hexdigest()
    payload['candidateCount']=len(candidates)
    if os.path.exists(snapshot):
        if json.load(open(snapshot)) != payload: raise SystemExit('same-SHA migration snapshot differs')
    else:
        os.makedirs(os.path.dirname(snapshot),mode=0o700,exist_ok=True)
        tmp=snapshot+'.tmp.'+str(os.getpid())
        with open(tmp,'w') as out: json.dump(payload,out,sort_keys=True,separators=(',',':'))
        os.chmod(tmp,0o600); os.replace(tmp,snapshot)
elif mode=='post':
    try: payload=json.load(open(snapshot))
    except Exception as error: raise SystemExit('migration snapshot is unavailable: '+str(error))
    if payload.get('schemaVersion')!=1 or payload.get('targetSha')!=sha: raise SystemExit('migration snapshot binding is invalid')
    if marker_count!=1: raise SystemExit('migration 101 marker was not applied exactly once')
    before={row[0]:row[1:] for row in payload['rows']}; after={row[0]:row[1:] for row in rows}
    if set(before)!=set(after): raise SystemExit('order population changed during migration gate')
    candidate_ids={row[0] for row in payload['candidates']}
    for order_id,before_row in before.items():
        status,reason,metadata=after[order_id]
        if order_id in candidate_ids:
            if status!='filled' or (reason,metadata)!=tuple(before_row[1:]): raise SystemExit('candidate repair/audit proof failed')
        elif (status,reason,metadata)!=tuple(before_row):
            raise SystemExit('noncandidate order changed during migration gate')
    if payload['markerWasPresent'] and candidate_ids: raise SystemExit('applied-marker snapshot is not a no-op')
else:
    raise SystemExit('mode must be pre or post')
print(json.dumps({'candidateCount':len(payload['candidates']),'candidateHash':payload['candidateHash'],'rowsHash':payload['rowsHash'],'markerWasPresent':payload['markerWasPresent']},separators=(',',':')))
PY
}
main "$@"
