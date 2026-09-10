#!/usr/bin/env bash
set -euo pipefail

# The API owns migration writes. This helper only freezes and proves the
# stopped-ledger census around migrations 101 through 103 and 106.
readonly MARKER_101='101_repair_filled_phantom_orders.sql'
readonly MARKER_102='102_maker_capture_reprice_intents.sql'
readonly MARKER_103='103_bounce_ask_capture_reprice_intents.sql'
readonly MARKER_106='106_repair_trading_disabled_pending_orders.sql'
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

main() {
  [[ $# == 3 ]] || die 'usage: pre|post <target-sha> <snapshot-path>'
  local mode="$1" sha="$2" snapshot="$3"
  local db="${KRABS_ORDER_STATUS_LEDGER_PATH:-/var/lib/docker/volumes/krabs-data/_data/ledger-live-lite.db}"
  [[ "$mode" == pre || "$mode" == post ]] || die 'mode must be pre or post'
  [[ "$sha" =~ ^[0-9a-f]{40}$ && -f "$db" ]] || die 'target SHA or ledger is invalid'
  python3 - "$mode" "$db" "$snapshot" "$sha" "$MARKER_101" "$MARKER_102" "$MARKER_103" "$MARKER_106" <<'PY'
import datetime,hashlib,json,os,sqlite3,sys
mode,db,snapshot,sha,marker101,marker102,marker103,marker106=sys.argv[1:]
table102='maker_capture_reprice_intents'
table103='bounce_ask_capture_reprice_intents'

expected_columns102=[
    [0,'intent_id','TEXT',0,None,1],
    [1,'predecessor_order_id','TEXT',1,None,0],
    [2,'lifecycle_signal_id','TEXT',1,None,0],
    [3,'root_order_id','TEXT',1,None,0],
    [4,'token_id','TEXT',1,None,0],
    [5,'condition_id','TEXT',1,None,0],
    [6,'replacement_index','INTEGER',1,None,0],
    [7,'status','TEXT',1,None,0],
    [8,'candidate_price','REAL',0,None,0],
    [9,'replacement_size','REAL',0,None,0],
    [10,'child_order_id','TEXT',0,None,0],
    [11,'failure','TEXT',0,None,0],
    [12,'proof_json','TEXT',1,None,0],
    [13,'created_at','TEXT',1,None,0],
    [14,'updated_at','TEXT',1,None,0],
]
expected_checks102=sorted([
    "replacement_indexbetween1and5",
    "statusin('cancel_pending','ready','submitted','completed','failed')",
    "json_valid(proof_json)",
])
expected_indexes102=[
    {'name':None,'unique':True,'origin':'pk','partial':False,'keys':[['intent_id',0,'BINARY']],'sql':None},
    {'name':None,'unique':True,'origin':'u','partial':False,'keys':[['predecessor_order_id',0,'BINARY']],'sql':None},
    {'name':None,'unique':True,'origin':'u','partial':False,'keys':[['lifecycle_signal_id',0,'BINARY']],'sql':None},
    {'name':None,'unique':True,'origin':'u','partial':False,'keys':[['child_order_id',0,'BINARY']],'sql':None},
    {'name':'idx_maker_capture_reprice_intents_status','unique':False,'origin':'c','partial':False,'keys':[['status',0,'BINARY']],'sql':'createindexidx_maker_capture_reprice_intents_statusonmaker_capture_reprice_intents(status)'},
    {'name':'idx_maker_capture_reprice_intents_root','unique':False,'origin':'c','partial':False,'keys':[['root_order_id',0,'BINARY'],['replacement_index',0,'BINARY']],'sql':'createindexidx_maker_capture_reprice_intents_rootonmaker_capture_reprice_intents(root_order_id,replacement_index)'},
]
expected_index108={'name':'idx_maker_capture_reprice_intents_token','unique':False,'origin':'c','partial':False,'keys':[['token_id',0,'BINARY']],'sql':'createindexidx_maker_capture_reprice_intents_tokenonmaker_capture_reprice_intents(token_id)'}
expected_columns103=[
    [0,'intent_id','TEXT',0,None,1],
    [1,'predecessor_order_id','TEXT',1,None,0],
    [2,'lifecycle_signal_id','TEXT',1,None,0],
    [3,'root_order_id','TEXT',1,None,0],
    [4,'position_id','TEXT',1,None,0],
    [5,'token_id','TEXT',1,None,0],
    [6,'condition_id','TEXT',1,None,0],
    [7,'replacement_index','INTEGER',1,None,0],
    [8,'status','TEXT',1,None,0],
    [9,'candidate_price','REAL',0,None,0],
    [10,'replacement_size','REAL',0,None,0],
    [11,'child_order_id','TEXT',0,None,0],
    [12,'failure','TEXT',0,None,0],
    [13,'proof_json','TEXT',1,None,0],
    [14,'created_at','TEXT',1,None,0],
    [15,'updated_at','TEXT',1,None,0],
]
expected_checks103=sorted([
    "replacement_indexbetween1and5",
    "statusin('cancel_pending','ready','submitted','completed','failed','dust')",
    "json_valid(proof_json)",
])
expected_indexes103=[
    {'name':None,'unique':True,'origin':'pk','partial':False,'keys':[['intent_id',0,'BINARY']],'sql':None},
    {'name':None,'unique':True,'origin':'u','partial':False,'keys':[['predecessor_order_id',0,'BINARY']],'sql':None},
    {'name':None,'unique':True,'origin':'u','partial':False,'keys':[['lifecycle_signal_id',0,'BINARY']],'sql':None},
    {'name':None,'unique':True,'origin':'u','partial':False,'keys':[['child_order_id',0,'BINARY']],'sql':None},
    {'name':'idx_bounce_ask_capture_reprice_intents_status','unique':False,'origin':'c','partial':False,'keys':[['status',0,'BINARY']],'sql':'createindexidx_bounce_ask_capture_reprice_intents_statusonbounce_ask_capture_reprice_intents(status)'},
    {'name':'idx_bounce_ask_capture_reprice_intents_root','unique':False,'origin':'c','partial':False,'keys':[['root_order_id',0,'BINARY'],['replacement_index',0,'BINARY']],'sql':'createindexidx_bounce_ask_capture_reprice_intents_rootonbounce_ask_capture_reprice_intents(root_order_id,replacement_index)'},
    {'name':'idx_bounce_ask_capture_one_nonterminal_per_position','unique':True,'origin':'c','partial':True,'keys':[['position_id',0,'BINARY']],'sql':"createuniqueindexidx_bounce_ask_capture_one_nonterminal_per_positiononbounce_ask_capture_reprice_intents(position_id)wherestatusin('cancel_pending','ready','submitted')"},
]

def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'))

def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()

def normalize_check(value):
    out=[]; quoted=False; index=0
    while index<len(value):
        char=value[index]
        if char=="'":
            out.append(char)
            if quoted and index+1<len(value) and value[index+1]=="'":
                out.append("'"); index+=2; continue
            quoted=not quoted
        elif not quoted and char.isspace():
            index+=1; continue
        else:
            out.append(char if quoted else char.lower())
        index+=1
    if quoted: raise SystemExit('intent migration CHECK constraint is malformed')
    return ''.join(out)

def extract_checks(create_sql):
    checks=[]; lowered=create_sql.lower(); start=0
    while True:
        found=lowered.find('check',start)
        if found<0: break
        before=lowered[found-1] if found else ' '
        after=lowered[found+5] if found+5<len(lowered) else ' '
        if (before.isalnum() or before=='_') or (after.isalnum() or after=='_'):
            start=found+5; continue
        opening=create_sql.find('(',found+5)
        if opening<0: raise SystemExit('intent migration CHECK constraint is malformed')
        depth=1; quoted=False; index=opening+1
        while index<len(create_sql) and depth:
            char=create_sql[index]
            if char=="'":
                if quoted and index+1<len(create_sql) and create_sql[index+1]=="'":
                    index+=2; continue
                quoted=not quoted
            elif not quoted:
                if char=='(': depth+=1
                elif char==')': depth-=1
            index+=1
        if depth or quoted: raise SystemExit('intent migration CHECK constraint is malformed')
        checks.append(normalize_check(create_sql[opening+1:index-1])); start=index
    return sorted(checks)

def index_shape(connection,table):
    indexes=[]
    for _,name,unique,origin,partial in connection.execute(f"PRAGMA index_list('{table}')"):
        escaped=name.replace("'","''")
        keys=[]
        for _,_,column,descending,collation,key in connection.execute(f"PRAGMA index_xinfo('{escaped}')"):
            if key: keys.append([column,descending,collation])
        index_sql=None
        if origin=='c':
            found=connection.execute("SELECT sql FROM sqlite_master WHERE type='index' AND name=?",(name,)).fetchall()
            if len(found)!=1 or not isinstance(found[0][0],str): raise SystemExit('named index identity is invalid')
            index_sql=normalize_check(found[0][0])
        indexes.append({'name':name if origin=='c' else None,'unique':bool(unique),'origin':origin,'partial':bool(partial),'keys':keys,'sql':index_sql})
    return sorted(indexes,key=canonical)

expected_shape102={'columns':expected_columns102,'checks':expected_checks102,'indexes':sorted(expected_indexes102,key=canonical)}
expected_shape103={'columns':expected_columns103,'checks':expected_checks103,'indexes':sorted(expected_indexes103,key=canonical)}

def inspect_token_index(connection):
    count=connection.execute('SELECT count(*) FROM schema_migrations WHERE name=?',('108_maker_capture_intents_token_index.sql',)).fetchone()[0]
    if count not in (0,1): raise SystemExit('migration 108 marker is not unique')
    owners=connection.execute("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name=?",(expected_index108['name'],)).fetchall()
    indexes=[index for index in index_shape(connection,table102) if index['name']==expected_index108['name']]
    if owners!=([(table102,)] if count else []) or indexes!=([expected_index108] if count else []):
        raise SystemExit('migration 108 marker/index state is not canonical')
    return bool(count)

def inspect_intents(connection,table,expected_shape,label):
    expected_schema_hash=digest(expected_shape)
    found=connection.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchall()
    if not found: return False,[],expected_schema_hash
    if len(found)!=1 or not isinstance(found[0][0],str): raise SystemExit(f'{label} table identity is invalid')
    shape={
        'columns':[list(row) for row in connection.execute(f"PRAGMA table_info('{table}')")],
        'checks':extract_checks(found[0][0]),
        'indexes':index_shape(connection,table),
    }
    # Preserve v4 base-schema proofs after validating the sole approved index addition.
    if table==table102 and token_index_present: shape['indexes'].remove(expected_index108)
    if shape!=expected_shape or digest(shape)!=expected_schema_hash:
        raise SystemExit(f'{label} table shape is not canonical')
    rows=[list(row) for row in connection.execute(f'SELECT * FROM {table} ORDER BY intent_id')]
    return True,rows,expected_schema_hash

uri='file:'+os.path.abspath(db)+'?mode=ro'
con=sqlite3.connect(uri,uri=True)
con.execute('PRAGMA query_only=ON')
try:
    order_columns=[
        'order_id','status','cancel_reason','metadata_json','client_order_id','exchange_order_id',
        'fill_progress_shares','exchange_error_code','exchange_error_message',
        'exchange_error_payload','exchange_rejection_reason','updated_at',
    ]
    available_order_columns={row[1] for row in con.execute("PRAGMA table_info('orders')")}
    if not set(order_columns) <= available_order_columns: raise SystemExit('orders migration proof columns are missing')
    order_id_index=order_columns.index('order_id')
    rows=[list(row) for row in con.execute(f"SELECT {','.join(order_columns)} FROM orders ORDER BY order_id")]
    marker101_count=con.execute('SELECT count(*) FROM schema_migrations WHERE name=?',(marker101,)).fetchone()[0]
    marker102_count=con.execute('SELECT count(*) FROM schema_migrations WHERE name=?',(marker102,)).fetchone()[0]
    marker103_count=con.execute('SELECT count(*) FROM schema_migrations WHERE name=?',(marker103,)).fetchone()[0]
    marker106_count=con.execute('SELECT count(*) FROM schema_migrations WHERE name=?',(marker106,)).fetchone()[0]
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
    candidates106=[list(row) for row in con.execute("""
      WITH valid_evidence AS MATERIALIZED (
        SELECT id,payload,
               CASE WHEN json_valid(payload)
                    THEN json_extract(payload,'$.errorDetails.responseBody')
                    ELSE NULL END AS response_body
          FROM risk_events
         WHERE event_type='live_order_submit_unknown' AND json_valid(payload)
      ), candidates AS MATERIALIZED (
        SELECT o.order_id,
               (SELECT evidence.response_body
                  FROM valid_evidence AS evidence
                 WHERE json_extract(evidence.payload,'$.orderId')=o.order_id
                   AND json_extract(evidence.payload,'$.clientOrderId')=o.client_order_id
                   AND json_type(evidence.payload,'$.errorDetails.responseBody')='object'
                   AND json_type(evidence.payload,'$.errorDetails.responseBody.status')='integer'
                   AND json_extract(evidence.payload,'$.errorDetails.responseBody.status')=503
                   AND ((json_type(evidence.payload,'$.errorDetails.responseBody.error')='text'
                         AND lower(trim(json_extract(evidence.payload,'$.errorDetails.responseBody.error')))='trading is disabled')
                     OR (json_type(evidence.payload,'$.errorDetails.responseBody.message')='text'
                         AND lower(trim(json_extract(evidence.payload,'$.errorDetails.responseBody.message')))='trading is disabled'))
                 ORDER BY evidence.id DESC LIMIT 1) AS response_body
          FROM orders AS o
         WHERE o.status='pending' AND o.order_id=o.exchange_order_id
           AND o.exchange_order_id IS NOT NULL AND o.exchange_order_id<>''
           AND NOT EXISTS (SELECT 1 FROM fills AS f WHERE f.order_id=o.order_id)
      )
      SELECT o.order_id,
             json_object('responseBody',json(c.response_body)) AS expected_error_payload,
             CASE WHEN json_valid(o.metadata_json)
                  THEN json_remove(o.metadata_json,'$.makerCaptureLineageV1','$.bounceAskCaptureLineageV1')
                  ELSE o.metadata_json END AS expected_metadata
        FROM candidates AS c JOIN orders AS o ON o.order_id=c.order_id
       WHERE c.response_body IS NOT NULL
       ORDER BY o.order_id""")]
    token_index_present=inspect_token_index(con)
    table102_present,rows102,schema102_hash=inspect_intents(con,table102,expected_shape102,'migration 102')
    table103_present,rows103,schema103_hash=inspect_intents(con,table103,expected_shape103,'migration 103')
except sqlite3.Error as error:
    raise SystemExit('ledger census failed: '+str(error))
finally:
    con.close()
if marker101_count not in (0,1): raise SystemExit('migration 101 marker is not unique')
if marker102_count not in (0,1): raise SystemExit('migration 102 marker is not unique')
if marker103_count not in (0,1): raise SystemExit('migration 103 marker is not unique')
if marker106_count not in (0,1): raise SystemExit('migration 106 marker is not unique')
if invalid_identity: raise SystemExit('phantom repair identity is not exact')
if marker102_count and not table102_present: raise SystemExit('migration 102 marker/table state is invalid')
if not marker102_count and rows102: raise SystemExit('unmarked migration 102 table is not empty')
if marker103_count and not table103_present: raise SystemExit('migration 103 marker/table state is invalid')
if not marker103_count and rows103: raise SystemExit('unmarked migration 103 table is not empty')
if mode=='pre':
    if marker101_count and candidates: raise SystemExit('applied migration retains repair candidates')
    if marker106_count and candidates106: raise SystemExit('applied migration 106 retains repair candidates')
    migration101={'markerWasPresent':bool(marker101_count),'rows':rows,'candidates':candidates}
    migration101['rowsHash']=digest(rows)
    migration101['candidateHash']=digest(candidates)
    migration101['candidateCount']=len(candidates)
    migration102={'markerWasPresent':bool(marker102_count),'tableWasPresent':table102_present,'rows':rows102}
    migration102['rowsHash']=digest(rows102)
    migration102['rowCount']=len(rows102)
    migration102['schemaHash']=schema102_hash
    migration102['tokenIndexWasPresent']=token_index_present
    migration103={'markerWasPresent':bool(marker103_count),'tableWasPresent':table103_present,'rows':rows103}
    migration103['rowsHash']=digest(rows103)
    migration103['rowCount']=len(rows103)
    migration103['schemaHash']=schema103_hash
    migration106={'markerWasPresent':bool(marker106_count),'candidates':candidates106}
    migration106['candidateHash']=digest(candidates106)
    migration106['candidateCount']=len(candidates106)
    payload={'schemaVersion':4,'targetSha':sha,'orderColumns':order_columns,'migration101':migration101,'migration102':migration102,'migration103':migration103,'migration106':migration106}
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
    if payload.get('schemaVersion')!=4 or payload.get('targetSha')!=sha: raise SystemExit('migration snapshot binding is invalid')
    if payload.get('orderColumns')!=order_columns: raise SystemExit('orders schema changed during migration gate')
    before101=payload['migration101']; before102=payload['migration102']; before103=payload['migration103']; before106=payload['migration106']
    if before102.get('tokenIndexWasPresent',False) and not token_index_present:
        raise SystemExit('migration 108 index was removed during migration gate')
    if marker101_count!=1: raise SystemExit('migration 101 marker was not applied exactly once')
    if marker102_count!=1 or not table102_present: raise SystemExit('migration 102 was not applied exactly once')
    if marker103_count!=1 or not table103_present: raise SystemExit('migration 103 was not applied exactly once')
    if marker106_count!=1: raise SystemExit('migration 106 marker was not applied exactly once')
    before={row[order_id_index]:row for row in before101['rows']}; after={row[order_id_index]:row for row in rows}
    if set(before)!=set(after): raise SystemExit('order population changed during migration gate')
    candidate_ids={row[0] for row in before101['candidates']}
    candidates106_by_id={row[0]:row[1:] for row in before106['candidates']}
    if candidate_ids & set(candidates106_by_id): raise SystemExit('migration repair candidate sets overlap')
    indexes={name:order_columns.index(name) for name in order_columns}
    allowed106={indexes[name] for name in (
        'status','fill_progress_shares','exchange_error_code','exchange_error_message',
        'exchange_error_payload','exchange_rejection_reason','metadata_json','updated_at',
    )}
    for order_id,before_row in before.items():
        after_row=after[order_id]
        if order_id in candidate_ids:
            if after_row[indexes['status']]!='filled': raise SystemExit('candidate repair/audit proof failed')
            if any(before_row[i]!=after_row[i] for i in range(len(before_row)) if i!=indexes['status']):
                raise SystemExit('candidate repair/audit proof failed')
        elif order_id in candidates106_by_id:
            expected_payload,expected_metadata=candidates106_by_id[order_id]
            expected={
                'status':'rejected','fill_progress_shares':0,'exchange_error_code':'UNKNOWN',
                'exchange_error_message':'trading is disabled','exchange_error_payload':expected_payload,
                'exchange_rejection_reason':'rejection_unknown','metadata_json':expected_metadata,
            }
            if any(after_row[indexes[name]]!=value for name,value in expected.items()):
                raise SystemExit('migration 106 candidate canonical repair proof failed')
            updated_at=after_row[indexes['updated_at']]
            try:
                parsed_updated_at=datetime.datetime.strptime(updated_at,'%Y-%m-%dT%H:%M:%S.%fZ')
                previous_updated_at=datetime.datetime.strptime(before_row[indexes['updated_at']],'%Y-%m-%dT%H:%M:%S.%fZ')
            except (TypeError,ValueError):
                raise SystemExit('migration 106 candidate updated_at proof failed')
            if not previous_updated_at<parsed_updated_at<=datetime.datetime.utcnow()+datetime.timedelta(seconds=1):
                raise SystemExit('migration 106 candidate updated_at proof failed')
            if any(before_row[i]!=after_row[i] for i in range(len(before_row)) if i not in allowed106):
                raise SystemExit('migration 106 candidate changed an unrelated order column')
        elif after_row!=before_row:
            raise SystemExit('noncandidate order changed during migration gate')
    if before101['markerWasPresent'] and candidate_ids: raise SystemExit('applied-marker snapshot is not a no-op')
    if len(rows102)!=before102['rowCount'] or digest(rows102)!=before102['rowsHash'] or rows102!=before102['rows']:
        raise SystemExit('migration 102 intent rows changed during migration gate')
    if not before102['markerWasPresent'] and rows102: raise SystemExit('first migration 102 apply did not remain empty')
    if schema102_hash!=before102['schemaHash']: raise SystemExit('migration 102 schema proof changed')
    if len(rows103)!=before103['rowCount'] or digest(rows103)!=before103['rowsHash'] or rows103!=before103['rows']:
        raise SystemExit('migration 103 intent rows changed during migration gate')
    if not before103['markerWasPresent'] and rows103: raise SystemExit('first migration 103 apply did not remain empty')
    if schema103_hash!=before103['schemaHash']: raise SystemExit('migration 103 schema proof changed')
    if before106['markerWasPresent'] and candidates106_by_id: raise SystemExit('applied migration 106 snapshot is not a no-op')
else:
    raise SystemExit('mode must be pre or post')
migration101=payload['migration101']; migration102=payload['migration102']; migration103=payload['migration103']; migration106=payload['migration106']
print(json.dumps({
    'migration101':{key:migration101[key] for key in ('candidateCount','candidateHash','rowsHash','markerWasPresent')},
    'migration102':{key:migration102[key] for key in ('markerWasPresent','tableWasPresent','rowCount','rowsHash','schemaHash')},
    'migration103':{key:migration103[key] for key in ('markerWasPresent','tableWasPresent','rowCount','rowsHash','schemaHash')},
    'migration106':{key:migration106[key] for key in ('candidateCount','candidateHash','markerWasPresent')},
},separators=(',',':')))
PY
}
main "$@"
