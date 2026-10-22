const fs = require('fs');
const lines = fs.readFileSync('/workspace/TaskHive/server.js', 'utf8').split('\n');
const s = lines.findIndex(l => l.includes('async function authHandler'));
lines.splice(s + 1, 0, "console.error('[A] in authHandler routeKey=' + JSON.stringify(routeKey) + ' method=' + method + ' sqlite=' + !!sqlite);");
const f = lines.findIndex((l, i) => i > s && l.includes("return send(res, 404, { error: 'unknown auth endpoint' });"));
lines.splice(f, 0, "console.error('[A] FALLING THROUGH to 404');");
fs.writeFileSync('/tmp/dbg2.js', lines.join('\n'));
console.log('wrote /tmp/dbg2.js, authHandler at line', s + 1);
