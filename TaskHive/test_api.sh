#!/bin/bash
# Smoke tests for the TaskHive backend (expects server running on :3000)
# Covers: signup validation, duplicate email, generic login failure, httpOnly
# session cookie, session persistence after refresh, logout invalidation,
# rate limiting (429), protected routes without auth, and two-user data isolation.
B=http://localhost:3000/api
JAR=/tmp/taskhive_test_cookies.txt
rm -f $JAR
PASS=0; FAIL=0
chk() { # chk <desc> <expected> <actual>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "ok   $1";
  else FAIL=$((FAIL+1)); echo "FAIL $1 (expected=$2 got=$3)"; fi
}
STAMP=$(date +%s)
EA="iso-a-$STAMP@test.dev"
EB="iso-b-$STAMP@test.dev"
PW="sup3rsecret-pw"

echo "== unauthenticated mutation is rejected (expect 401) =="
chk "401 no-auth POST /tasks" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/tasks -H 'Content-Type: application/json' -d '{"name":"nope","project":"api-docs"}')"

echo "== unauthenticated GET of protected routes (expect 401) =="
chk "401 no-auth GET /bootstrap" 401 "$(curl -s -o /dev/null -w '%{http_code}' $B/bootstrap)"
chk "401 no-auth GET /tasks" 401 "$(curl -s -o /dev/null -w '%{http_code}' $B/tasks)"
chk "401 no-cookie /auth/me" 401 "$(curl -s -o /dev/null -w '%{http_code}' $B/auth/me)"

echo "== signup validation: short password (expect 400) =="
chk "400 short pw" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/auth/signup -d "{\"name\":\"Val Test\",\"email\":\"val-$STAMP@test.dev\",\"password\":\"short\"}")"
echo "== signup validation: bad email (expect 400) =="
chk "400 bad email" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/auth/signup -d "{\"name\":\"Val Test\",\"email\":\"not-an-email\",\"password\":\"$PW\"}")"

echo "== signup user A (expect 201 + httpOnly session cookie) =="
SIGNUP_HDR=$(curl -s -D - -o /tmp/signup_a.json -w '' -X POST $B/auth/signup -H 'Content-Type: application/json' -d "{\"name\":\"ISO User A\",\"email\":\"$EA\",\"password\":\"$PW\"}" -c $JAR)
chk "201 signup" 201 "$(echo "$SIGNUP_HDR" | awk '/HTTP\//{print $2}' | tail -1)"
if echo "$SIGNUP_HDR" | grep -iq 'set-cookie:.*httponly'; then PASS=$((PASS+1)); echo "ok   session cookie is httpOnly"; else FAIL=$((FAIL+1)); echo "FAIL session cookie not httpOnly"; fi
chk "signup returns user id" true "$(node -pe 'const j=require("/tmp/signup_a.json");!!j.user&&!!j.user.id' 2>/dev/null || echo false)"

echo "== duplicate email rejected with clear message (expect 409) =="
DUP=$(curl -s -X POST $B/auth/signup -H 'Content-Type: application/json' -d "{\"name\":\"ISO User A again\",\"email\":\"$EA\",\"password\":\"$PW\"}")
DUP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/auth/signup -H 'Content-Type: application/json' -d "{\"name\":\"Dup\",\"email\":\"$EA\",\"password\":\"$PW\"}")
chk "409 duplicate" 409 "$DUP_CODE"
if echo "$DUP" | grep -qi 'already registered'; then PASS=$((PASS+1)); echo "ok   duplicate message is clear"; else FAIL=$((FAIL+1)); echo "FAIL duplicate message unclear: $DUP"; fi

echo "== email stored lowercase =="
MIXED=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/auth/login -d "{\"email\":\"$(echo $EA | tr 'a-z' 'A-Z')\",\"password\":\"$PW\"}")
chk "200 login with uppercase email" 200 "$MIXED"

echo "== login with wrong password returns GENERIC error (expect 401) =="
BAD=$(curl -s -X POST $B/auth/login -d "{\"email\":\"$EA\",\"password\":\"wrong-password\"}")
BAD_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/auth/login -d "{\"email\":\"$EA\",\"password\":\"wrong-password\"}")
chk "401 wrong pw" 401 "$BAD_CODE"
if echo "$BAD" | grep -q '"Invalid email or password"'; then PASS=$((PASS+1)); echo "ok   generic login error message"; else FAIL=$((FAIL+1)); echo "FAIL login error not generic: $BAD"; fi

echo "== login as user A (demo password login kept below for legacy checks) =="
chk "200 login A" 200 "$(curl -s -c $JAR -o /dev/null -w '%{http_code}' -X POST $B/auth/login -d "{\"email\":\"$EA\",\"password\":\"$PW\"}")"

echo "== last_login updated after login =="
LL=$(sqlite3 "${TASKHIVE_DATA_DIR:-$(cd "$(dirname "$0")" && pwd)/data}/taskhive.db" "SELECT last_login FROM users WHERE email='$EA';" 2>/dev/null)
if [ -n "$LL" ]; then PASS=$((PASS+1)); echo "ok   last_login set ($LL)"; else FAIL=$((FAIL+1)); echo "FAIL last_login empty (or sqlite3 CLI unavailable — skip)"; fi

echo "== session reflects user =="
SESS_EMAIL=$(curl -s -b $JAR $B/session | node -pe 'JSON.parse(require("fs").readFileSync(0)).user.email')
chk "session has user A" "$EA" "$SESS_EMAIL"

echo "== /auth/me restores the session (simulates page refresh) =="
chk "200 auth/me with cookie" 200 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' $B/auth/me)"
ME_EMAIL=$(curl -s -b $JAR $B/auth/me | node -pe 'JSON.parse(require("fs").readFileSync(0)).user.email')
chk "auth/me returns same user" "$EA" "$ME_EMAIL"

echo "== bootstrap payload keys =="
chk "bootstrap keys" "user,workspace,people,projects,tasks,inbox,discussions,messages,channels,savedIds,readFlags,ui" \
  "$(curl -s -b $JAR $B/bootstrap | node -pe 'Object.keys(JSON.parse(require("fs").readFileSync(0))).join(",")')"

echo "== new signup gets an EMPTY workspace (sampleData:false) =="
JAR_S=/tmp/th_jar_sample.txt
curl -s -c $JAR_S -o /dev/null -X POST $B/auth/signup -d "{\"name\":\"No Sample\",\"email\":\"nosample-$STAMP@test.dev\",\"password\":\"$PW\",\"sampleData\":false}"
chk "empty tasks after signup" 0 "$(curl -s -b $JAR_S $B/bootstrap | node -pe 'JSON.parse(require("fs").readFileSync(0)).tasks.length')"
chk "empty projects after signup" 0 "$(curl -s -b $JAR_S $B/bootstrap | node -pe 'JSON.parse(require("fs").readFileSync(0)).projects.length')"

echo "== create task as user A =="
chk "201 create" 201 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X POST $B/tasks -H 'Content-Type: application/json' -d '{"name":"Backend smoke test task","urgency":"Critical"}')"
TID=$(curl -s -b $JAR "$B/tasks?q=backend%20smoke" | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); const l=d.items||d; l.length?l[0].id:"none"')
echo "task id: $TID"

echo "== DATA ISOLATION: user B cannot see/patch/delete user A's task =="
JAR_B=/tmp/th_jar_b.txt
curl -s -c $JAR_B -o /dev/null -X POST $B/auth/signup -d "{\"name\":\"ISO User B\",\"email\":\"$EB\",\"password\":\"$PW\"}"
chk "B does not see A task in list" "" "$(curl -s -b $JAR_B "$B/tasks?limit=500" | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); ((d.items||d).find(t=>t.id==="'"$TID"'")||{}).id||""')"
chk "404 B GET A task" 404 "$(curl -s -b $JAR_B -o /dev/null -w '%{http_code}' $B/tasks/$TID)"
chk "404 B PATCH A task" 404 "$(curl -s -b $JAR_B -o /dev/null -w '%{http_code}' -X PATCH $B/tasks/$TID -d '{"progress":"Completed"}')"
chk "404 B DELETE A task" 404 "$(curl -s -b $JAR_B -o /dev/null -w '%{http_code}' -X DELETE $B/tasks/$TID)"
chk "A task still exists after B attempts" 200 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' $B/tasks/$TID)"

echo "== patch task ($TID) =="
chk "200 patch" 200 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X PATCH $B/tasks/$TID -d '{"progress":"Completed"}')"

echo "== invalid urgency (expect 400) =="
chk "400 bad enum" 400 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X PATCH $B/tasks/$TID -d '{"urgency":"Bogus"}')"

echo "== create a project as user A (for filter/import tests) =="
PROJ=$(curl -s -b $JAR -X POST $B/projects -d '{"name":"API Docs"}')
PID=$(echo "$PROJ" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
echo "project id: $PID"

echo "== title length capped at 200 chars =="
LONG=$(node -e 'console.log("x".repeat(500))')
chk "201 long name" 201 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X POST $B/tasks -d "{\"name\":\"$LONG\",\"project\":\"$PID\"}")"
LID=$(curl -s -b $JAR "$B/tasks?limit=100" | node -pe 'const t=JSON.parse(require("fs").readFileSync(0)).items.find(t=>t.name.length===200); t?t.id:"none"')
if [ "$LID" != "none" ]; then chk "name sliced to 200" 200 "$(curl -s -b $JAR $B/tasks/$LID | node -pe 'JSON.parse(require("fs").readFileSync(0)).name.length')"; curl -s -b $JAR -X DELETE $B/tasks/$LID > /dev/null; else FAIL=$((FAIL+1)); echo "FAIL long-name task not found"; fi

echo "== empty name rejected (expect 400) =="
chk "400 empty name" 400 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X POST $B/tasks -d '{"name":"   "}')"

echo "== filter by project =="
curl -s -b $JAR "$B/tasks?project=$PID" | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); (d.items||d).map(t=>t.id).join(",")'

echo "== pagination: limit/offset returns page object =="
chk "page size" 2 "$(curl -s -b $JAR "$B/tasks?limit=2&offset=0" | node -pe 'JSON.parse(require("fs").readFileSync(0)).items.length')"
chk "total is number" true "$(curl -s -b $JAR "$B/tasks?limit=2&offset=0" | node -pe 'typeof JSON.parse(require("fs").readFileSync(0)).total==="number"')"
ID0=$(curl -s -b $JAR "$B/tasks?limit=1&offset=0" | node -pe 'JSON.parse(require("fs").readFileSync(0)).items[0].id')
ID1=$(curl -s -b $JAR "$B/tasks?limit=1&offset=1" | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); d.items[1]?d.items[1].id:d.items[0].id')
if [ -n "$ID0" ] && [ -n "$ID1" ] && [ "$ID0" != "$ID1" ]; then PASS=$((PASS+1)); echo "ok   offset shifts window"; else FAIL=$((FAIL+1)); echo "FAIL offset shifts window ($ID0 vs $ID1)"; fi

echo "== delete (soft delete) =="
curl -s -b $JAR -X DELETE $B/tasks/$TID; echo
echo "== deleted task gone from list =="
chk "not in list" "" "$(curl -s -b $JAR "$B/tasks?limit=500" | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); ((d.items||d).find(t=>t.id==="'$TID'")||{}).id||""')"

echo "== prefs (per-user) =="
chk "200 prefs" 200 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X PATCH $B/prefs -d '{"savedIds":["TSK-8"],"readFlags":{"inbox-1":true}}')"

echo "== channel post/get (own workspace) =="
CODE=$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X POST $B/channels/general -d '{"text":"hello from backend test"}')
if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then PASS=$((PASS+1)); echo "ok   channel post ($CODE)"; else FAIL=$((FAIL+1)); echo "FAIL channel post ($CODE)"; fi
curl -s -b $JAR $B/channels/general | tail -c 120; echo

echo "== board reorder of own tasks =="
ORDER=$(curl -s -b $JAR "$B/tasks?limit=50" | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); JSON.stringify({order:(d.items||d).slice().reverse().map(t=>t.id)})')
CODE=$(curl -s -b $JAR -o /dev/null -w '%{http_code}' -X PATCH $B/board -H 'Content-Type: application/json' -d "$ORDER")
if [ "$CODE" = "200" ] || [ "$CODE" = "204" ]; then PASS=$((PASS+1)); echo "ok   board reorder ($CODE)"; else FAIL=$((FAIL+1)); echo "FAIL board reorder ($CODE)"; fi
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

echo "== import isolation: B importing does not touch A's data =="
BEFORE=$(curl -s -b $JAR "$B/tasks?limit=500" | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); (d.items||d).length')
curl -s -b $JAR_B -X POST $B/import -H 'Content-Type: application/json' -d @- < $EXP > /dev/null
AFTER=$(curl -s -b $JAR "$B/tasks?limit=500" | node -pe 'const d=JSON.parse(require("fs").readFileSync(0)); (d.items||d).length')
chk "A task count unchanged by B import" "$BEFORE" "$AFTER"

echo "== import snapshot as admin (expect 200, data restored) =="
IMP=$(curl -s -b $JAR -X POST $B/import -H 'Content-Type: application/json' -d @- < $EXP | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.exit(j.ok&&j.tasks>0?0:1)})" 2>/dev/null; echo $?)
if [ "$IMP" = "0" ]; then PASS=$((PASS+1)); echo "ok   import restores snapshot"; else FAIL=$((FAIL+1)); echo "FAIL import restores snapshot"; fi
chk "bootstrap works after import" 200 "$(curl -s -b $JAR -o /dev/null -w '%{http_code}' $B/bootstrap)"

echo "== RATE LIMIT: hammer login with bad passwords -> expect 429 + Retry-After =="
RL_HIT=""
for i in $(seq 1 14); do
  C=$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/auth/login -d '{"email":"rl@test.dev","password":"nope-nope-nope"}')
  if [ "$C" = "429" ]; then RL_HIT=$i; break; fi
done
if [ -n "$RL_HIT" ]; then PASS=$((PASS+1)); echo "ok   login rate limited at attempt $RL_HIT (429)"; else FAIL=$((FAIL+1)); echo "FAIL no 429 from login rate limiter after 14 attempts"; fi
RA_HDR=$(curl -s -D - -o /dev/null -X POST $B/auth/login -d '{"email":"rl@test.dev","password":"nope-nope-nope"}' | tr -d '\r' | grep -i '^retry-after:')
if [ -n "$RA_HDR" ]; then PASS=$((PASS+1)); echo "ok   429 includes Retry-After ($RA_HDR)"; else FAIL=$((FAIL+1)); echo "FAIL 429 missing Retry-After header"; fi

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
