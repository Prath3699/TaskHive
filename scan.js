const fs = require('fs');
const s = fs.readFileSync('/workspace/TaskHive/server.js', 'utf8');
const i = s.indexOf('async function authHandler');
const j = s.indexOf('async function handleApi');
const block = s.slice(i, j);

// Extract the signup branch condition and test comparisons directly
const lines = block.split('\n');
lines.forEach((ln, idx) => {
  if (ln.includes("routeKey ===") || ln.includes("method ===")) {
    console.log(idx + ':', JSON.stringify(ln.trim().slice(0, 90)));
  }
});

// Now simulate: what is routeKey for /api/auth/signup?
const pathname = '/api/auth/signup';
const parts = pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
const routeKey = parts.join('/');
console.log('\nsimulated routeKey =', JSON.stringify(routeKey), 'parts =', JSON.stringify(parts));

// check char codes of the comparison target in signup line
const sigLine = lines.find(l => l.includes("'signup'"));
if (sigLine) {
  const m = sigLine.match(/=== *'([^']*)'/);
  if (m) {
    console.log('signup literal:', JSON.stringify(m[1]), [...m[1]].map(c => c.charCodeAt(0)));
  } else {
    console.log('signup line but regex did not match:', JSON.stringify(sigLine));
  }
}
