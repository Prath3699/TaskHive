#!/bin/bash
# Smoke tests for the Issue Tracker backend (expects server running on :3000)
# Phase 2+4: auth required for mutations, scrypt passwords, SQLite mirror,
# soft deletes + pagination.
B=http://localhost:3000/api
JAR=/tmp/taskhive_test_cookies.txt
rm -f $JAR
PASS=0; FAIL=0
chk() { # chk <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "ok   $1";
  else FAIL=$((FAIL+1)); echo "FAIL $1 (expected=$2 got=$3)"; fi
}

echo "== unauthenticated mutation is rejected (expect 401) =="
chk "401 no-auth POST /tasks" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/tasks -H 'Content-Type: application/json' -d '{"name":"nope","project":"api-docs"}')"

echo "== login with wrong password (expect 401) =="
chk "401 bad password" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/login -d '{"email":"parth@catlas.inc","password":"wrong"}')"

echo "== login (scrypt-hashed demo password) =="
chk "200 login" 200 "$(curl -s -c $JAR -o /dev/null -w '%{http_code}' -X POST $B/login -d '{"email":"parth@catlas.inc","password":"password"}')"

echo "== session reflects user =="
chk "session has user" p1 "$(curl -s -b $JAR $B/session | node -pe 'JSON.parse(require("fs").readFileSync(0)).user.id')"

echo "== bootstrap (per-user prefs) =="
chk "bootstrap keys" "user,people,projects,tasks,inbox,discussions,messages,savedIds,readFlags,ui" \
  "$(curl -s -b $JAR $B/bootstrap | node -pe 'Object.keys(JSON.parse(require("fs").readFileSync(0))).join(",")')"

echo "== create task (authed) =="
chk "201 create" 201 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X POST $B/tasks -H 'Content-Type: application/json' -d '{"name":"Backend smoke test task","urgency":"Critical","project":"api-docs"}')"
TID=$(curl -s -b $JAR "$B/tasks?q=backend%20smoke" | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); (d.items||d)[0].id')
echo "task id: $TID"

echo "== patch task ($TID) =="
chk "200 patch" 200 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X PATCH $B/tasks/$TID -d '{"progress":"Completed"}')"

echo "== invalid urgency (expect 400) =="
chk "400 bad enum" 400 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X PATCH $B/tasks/$TID -d '{"urgency":"Bogus"}')"

echo "== title length capped at 200 chars =="
LONG=$(node -e 'console.log("x".repeat(500))')
chk "201 long name" 201 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X POST $B/tasks -d "{\"name\":\"$LONG\",\"project\":\"api-docs\"}")"
LID=$(curl -s -b $JAR "$B/tasks?limit=100" | node -pe 'const t=JSON.parse(require("fs").readFileSync(0)).items.find(t=>t.name.length===200); t?t.id:"none"')
if [ "$LID" != "none" ]; then chk "name sliced to 200" 200 "$(curl -s -b $JAR $B/tasks/$LID | node -pe 'JSON.parse(require("fs").readFileSync(0)).name.length')"; curl -s -b $JAR -X DELETE $B/tasks/$LID > /dev/null; else FAIL=$((FAIL+1)); echo "FAIL long-name task not found"; fi

echo "== empty name rejected (expect 400) =="
chk "400 empty name" 400 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X POST $B/tasks -d '{"name":"   "}')"

echo "== filter project=api-docs =="
curl -s -b $JAR "$B/tasks?project=api-docs" | node -pe 'JSON.parse(require("fs").readFileSync(0)).map(t=>t.id).join(",")'

echo "== pagination: limit/offset returns page object =="
chk "page size" 2 "$(curl -s -b $JAR "$B/tasks?limit=2&offset=0" | node -pe 'JSON.parse(require("fs").readFileSync(0)).items.length')"
chk "total is number" true "$(curl -s -b $JAR "$B/tasks?limit=2&offset=0" | node -pe 'typeof JSON.parse(require("fs").readFileSync(0)).total==="number"')"
ID0=$(curl -s -b $JAR "$B/tasks?limit=1&offset=0" | node -pe 'JSON.parse(require("fs").readFileSync(0)).items[0].id')
ID1=$(curl -s -b $JAR "$B/tasks?limit=1&offset=1" | node -pe 'JSON.parse(require("fs").readFileSync(0)).items[0].id')
if [ -n "$ID0" ] && [ -n "$ID1" ] && [ "$ID0" != "$ID1" ]; then PASS=$((PASS+1)); echo "ok   offset shifts window"; else FAIL=$((FAIL+1)); echo "FAIL offset shifts window ($ID0 vs $ID1)"; fi

echo "== delete == (soft delete)"
curl -s -b $JAR -X DELETE $B/tasks/$TID; echo
echo "== deleted task gone from list =="
chk "not in list" "" "$(curl -s -b $JAR "$B/tasks?limit=500" | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); ((d.items||d).find(t=>t.id==="'$TID'")||{}).id||""')"

echo "== prefs (per-user) =="
chk "200 prefs" 200 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X PATCH $B/prefs -d '{"savedIds":["TSK-8"],"readFlags":{"inbox-1":true}}')"

echo "== channel msg =="
CODE=$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X POST $B/channels/engineering -d '{"text":"hello from backend test"}')
if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then PASS=$((PASS+1)); echo "ok   channel post ($CODE)"; else FAIL=$((FAIL+1)); echo "FAIL channel post ($CODE)"; fi
echo "== channel get =="
curl -s -b $JAR $B/channels/engineering | tail -c 120; echo

echo "== board reorder =="
curl -s -b $JAR -X PATCH $B/board -d '{"order":["TSK-101","TSK-100","TSK-22"]}'; echo
echo "== bad reorder id (expect 400) =="
chk "400 bad order" 400 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X PATCH $B/board -d '{"order":["NOPE"]}')"

echo "== unknown endpoint (expect 404) =="
chk "404 unknown" 404 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' $B/nope)"

echo "== static index (expect 200 html) =="
chk "200 index" 200 "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/index.html)"

echo "== path traversal (expect non-200) =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "http://localhost:3000/../etc/passwd")
if [ "$CODE" != "200" ]; then PASS=$((PASS+1)); echo "ok   traversal blocked ($CODE)"; else FAIL=$((FAIL+1)); echo "FAIL traversal allowed"; fi

echo "== export snapshot (expect 200 + attachment header + valid JSON) =="
EXP_HDR=$(curl -s -b $JAR -D - -o /tmp/export.json "$B/export" | tr -d '\r')
EXP_CODE=$(echo "$EXP_HDR" | awk '/HTTP\//{print $2}')
chk "200 export" 200 "$EXP_CODE"
if echo "$EXP_HDR" | grep -qi 'content-disposition: attachment; filename="taskhive-backup-'; then
  PASS=$((PASS+1)); echo "ok   export attachment header"; else FAIL=$((FAIL+1)); echo "FAIL export attachment header missing"; fi
if node -e "const j=require('/tmp/export.json'); process.exit(j.db && Array.isArray(j.db.tasks) && j.exportedAt ? 0 : 1)" 2>/dev/null; then
  PASS=$((PASS+1)); echo "ok   export body is valid snapshot JSON"; else FAIL=$((FAIL+1)); echo "FAIL export body invalid"; fi

echo "== purge without auth (expect 401) =="
chk "401 purge unauth" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/purge)"

echo "== purge with auth (expect 200 ok:true) =="
PURGE=$(curl -s -b $JAR -X POST $B/purge | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.exit(j.ok&&typeof j.purged==='number'?0:1)})" 2>/dev/null; echo $?)
if [ "$PURGE" = "0" ]; then PASS=$((PASS+1)); echo "ok   purge response shape"; else FAIL=$((FAIL+1)); echo "FAIL purge response shape"; fi

echo "== export snapshot (expect tasks[] + people[]) =="
EXP=/tmp/th_export.json
curl -s -b $JAR $B/export -o $EXP
chk "export has tasks+people" 0 "$(node -e "const j=require('$EXP');process.exit(Array.isArray(j.db.tasks)&&Array.isArray(j.db.people)?0:1)" 2>/dev/null; echo $?)"

echo "== import without auth (expect 401) =="
chk "401 import unauth" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/import -H 'Content-Type: application/json' -d @- < $EXP)"

echo "== import invalid body (expect 400) =="
chk "400 import bad body" 400 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X POST $B/import -H 'Content-Type: application/json' -d '{"nope":true}')"

echo "== import as non-admin (expect 403) =="
JAR2=/tmp/th_jar2.txt
curl -s -c $JAR2 -o /dev/null -X POST $B/login -d '{"email":"david@catlas.inc","password":"password"}'
chk "403 import non-admin" 403 "$(curl -s -b $JAR2 -o /dev/null -w '%{http_code}' -X POST $B/import -H 'Content-Type: application/json' -d @- < $EXP)"

echo "== import snapshot as admin (expect 200, data restored) =="
IMP=$(curl -s -b $JAR -X POST $B/import -H 'Content-Type: application/json' -d @- < $EXP | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.exit(j.ok&&j.tasks>0?0:1)})" 2>/dev/null; echo $?)
if [ "$IMP" = "0" ]; then PASS=$((PASS+1)); echo "ok   import restores snapshot"; else FAIL=$((FAIL+1)); echo "FAIL import restores snapshot"; fi
chk "bootstrap works after import" 200 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' $B/bootstrap)"

echo "== logout clears cookie =="
chk "200 logout" 200 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X POST $B/logout)"
chk "401 after logout" 401 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X POST $B/tasks -d '{"name":"after logout"}')"

echo "== persistence check: storage files exist =="
DATA_DIR="${TASKHIVE_DATA_DIR:-$(cd "$(dirname "$0")" && pwd)/data}"
if ls "$DATA_DIR/taskhive.db" >/dev/null 2>&1 || ls "$DATA_DIR/db.json" >/dev/null 2>&1; then
  PASS=$((PASS+1)); echo "ok   storage files present"; else FAIL=$((FAIL+1)); echo "FAIL no storage"; fi

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
