// READ-ONLY doc check: does COACH_CAROUSEL_ROADMAP.md section 2 account for
// every field in the Coach union?
const fs = require('fs');
const path = require('path');
const r = require(path.join(__dirname, 'out', 'coach-schema.json'));

const all = new Set([...r.shared, ...r.cfbOnly, ...r.maddenOnly]);
const doc = fs.readFileSync(path.join(__dirname, '..', 'COACH_CAROUSEL_ROADMAP.md'), 'utf8');
const s = doc.indexOf('## 2. Complete field-mapping table');
const e = doc.indexOf('## 3. Sub-system specs');
if (s < 0 || e < 0) throw new Error('section markers not found');
const sec = doc.slice(s, e);

const tick = /`([A-Za-z_][A-Za-z0-9_]*)`/g;
const mentioned = new Set();
let m;
while ((m = tick.exec(sec))) mentioned.add(m[1]);

const missing = [...all].filter((f) => !mentioned.has(f));
const unknown = [...mentioned].filter((f) => !all.has(f));

console.log(`Coach union fields: ${all.size}  (shared ${r.shared.length}, cfbOnly ${r.cfbOnly.length}, maddenOnly ${r.maddenOnly.length})`);
console.log(`\nMISSING from field table (${missing.length}):`);
console.log(missing.length ? '  ' + missing.join('\n  ') : '  (none)');
console.log(`\nBackticked names in §2 that are NOT Coach fields (enum members, other tables, etc.) (${unknown.length}):`);
console.log('  ' + unknown.join(', '));
process.exit(missing.length ? 1 : 0);
