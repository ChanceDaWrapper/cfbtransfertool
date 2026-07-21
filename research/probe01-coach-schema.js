// READ-ONLY. Dumps the Coach table SCHEMA from both games and diffs it.
// Output: research/out/coach-schema.json + a console summary.
const fs = require('fs');
const path = require('path');
const { openCfb, openMadden } = require('./_saves');

const OUT = path.join(__dirname, 'out');

function attrDump(schema) {
  const out = {};
  for (const a of schema.attributes) {
    out[a.name] = {
      type: a.type,
      minValue: a.minValue,
      maxValue: a.maxValue,
      maxLength: a.maxLength,
      default: a.default,
      final: a.final,
      enum: a.enum ? a.enum.name : null,
      enumMembers: a.enum ? a.enum.members.map((m) => `${m.index}:${m.name}=${m.value}`) : null,
    };
  }
  return out;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cfb = await openCfb();
  const mad = await openMadden();

  const cSchema = cfb.schemaList.getSchema('Coach');
  const mSchema = mad.schemaList.getSchema('Coach');
  console.log('CFB schema meta:', JSON.stringify(cfb.schemaList.meta));
  console.log('MAD schema meta:', JSON.stringify(mad.schemaList.meta));
  console.log('CFB Coach attrs:', cSchema.attributes.length, ' MAD Coach attrs:', mSchema.attributes.length);

  const c = attrDump(cSchema);
  const m = attrDump(mSchema);
  const cNames = Object.keys(c), mNames = Object.keys(m);
  const shared = cNames.filter((n) => m[n]);
  const cfbOnly = cNames.filter((n) => !m[n]);
  const madOnly = mNames.filter((n) => !c[n]);

  // type mismatches among shared
  const typeDiff = shared.filter((n) => c[n].type !== m[n].type)
    .map((n) => ({ field: n, cfb: c[n].type, mad: m[n].type }));

  // enum diffs among shared enum-typed fields
  const enumDiff = [];
  for (const n of shared) {
    if (!c[n].enumMembers && !m[n].enumMembers) continue;
    const ca = c[n].enumMembers || [], ma = m[n].enumMembers || [];
    const same = ca.length === ma.length && ca.every((v, i) => v === ma[i]);
    if (!same) enumDiff.push({ field: n, cfbEnum: c[n].enum, madEnum: m[n].enum, cfb: ca, mad: ma });
  }

  const report = {
    cfbSchemaMeta: cfb.schemaList.meta, madSchemaMeta: mad.schemaList.meta,
    counts: { cfb: cNames.length, madden: mNames.length, shared: shared.length, cfbOnly: cfbOnly.length, maddenOnly: madOnly.length },
    shared, cfbOnly, maddenOnly: madOnly, typeDiff, enumDiff,
    cfbAttrs: c, maddenAttrs: m,
  };
  fs.writeFileSync(path.join(OUT, 'coach-schema.json'), JSON.stringify(report, null, 2));

  console.log('\n=== COUNTS ===', JSON.stringify(report.counts));
  console.log('\n=== SHARED (' + shared.length + ') ===\n' + shared.join(', '));
  console.log('\n=== CFB-ONLY (' + cfbOnly.length + ') ===\n' + cfbOnly.join(', '));
  console.log('\n=== MADDEN-ONLY (' + madOnly.length + ') ===\n' + madOnly.join(', '));
  console.log('\n=== TYPE MISMATCH (' + typeDiff.length + ') ===');
  for (const d of typeDiff) console.log(`  ${d.field}: cfb=${d.cfb} mad=${d.mad}`);
  console.log('\n=== SHARED FIELDS WITH DIFFERING ENUMS (' + enumDiff.length + ') ===');
  for (const d of enumDiff) console.log(`  ${d.field} (cfbEnum=${d.cfbEnum}, madEnum=${d.madEnum}) cfbN=${d.cfb.length} madN=${d.mad.length}`);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
