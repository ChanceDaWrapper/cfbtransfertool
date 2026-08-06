// THE decisive test for Madden->CFB: can this library re-serialize a CFB27
// save at all? Every write in this repo so far targets Madden; CFB opens
// through a schema OVERRIDE (data/schemas/CFB27_809_0.gz, major 809) because
// the auto-detected schema is insufficient -- whether that override survives
// a save-and-reload round trip has never been tested.
//
// WRITES to a NEW path only (CAREER-ROUNDTRIP-DYNASTY... er, CFB uses a
// dynasty folder name, not a single file -- see below). Never touches the
// source dynasty. This is a NO-OP write: open, touch nothing (or touch one
// harmless field), save-as, then read the output back and diff against the
// source to confirm nothing silently corrupted.

const fs = require('fs');
const path = require('path');
const { openCfb, safe } = require('../research/_saves');
const { biggestTableByName } = require('../lib/saveIO');

const SRC = require('../research/_saves').CFB_PATH;
const OUT = SRC + '-ROUNDTRIP-TEST';

(async () => {
  console.log(`Source: ${SRC}`);
  console.log(`Output: ${OUT}\n`);

  console.log('=== 1. open with schema override ===');
  const f = await openCfb();
  console.log('  opened OK');

  console.log('\n=== 2. read a coach BEFORE any write ===');
  const t = biggestTableByName(f, 'Coach');
  await t.readRecords();
  const before = [];
  for (const r of t.records) {
    if (r.isEmpty || !safe(r, 'Name')) continue;
    before.push({ row: r.index, name: safe(r, 'Name'), level: safe(r, 'Level'), team: safe(r, 'TeamIndex'), head: safe(r, 'GenericHeadAssetName') });
    if (before.length >= 5) break;
  }
  console.log('  sample:', before.map((c) => `${c.name}(L${c.level})`).join(', '));

  console.log('\n=== 3. save-as, with NO field writes (pure no-op) ===');
  const t0 = Date.now();
  try {
    await f.save(OUT);
    console.log(`  save() completed in ${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`  save() THREW: ${e.message}`);
    console.log('\nRESULT: FAILED -- the library cannot write a CFB save at all under this schema override.');
    process.exit(1);
  }

  console.log('\n=== 4. does the output exist and look like a real save? ===');
  const outExists = fs.existsSync(OUT);
  console.log('  output path exists:', outExists);
  if (outExists) {
    const stat = fs.statSync(OUT);
    console.log('  is directory:', stat.isDirectory());
    if (stat.isDirectory()) {
      const files = fs.readdirSync(OUT);
      console.log('  contains', files.length, 'file(s):', files.slice(0, 10).join(', '));
    } else {
      console.log('  size:', stat.size, 'bytes');
    }
  }

  console.log('\n=== 5. re-open the OUTPUT and read the same coaches back ===');
  const FranchiseFile = require('madden-franchise');
  const CFB_SCHEMA_GZ = path.join(__dirname, '..', 'data', 'schemas', 'CFB27_809_0.gz');
  let f2;
  try {
    f2 = await FranchiseFile.create(OUT, {
      schemaOverride: { major: 809, minor: 0, gameYear: 27, path: CFB_SCHEMA_GZ },
      gameYearOverride: 27,
    });
    await new Promise((res, rej) => { if (f2.isLoaded) res(); else { f2.on('ready', res); f2.on('error', rej); } });
    console.log('  reopened OK');
  } catch (e) {
    console.log(`  reopen FAILED: ${e.message}`);
    console.log('\nRESULT: FAILED -- wrote something, but the library (or presumably the game) cannot read it back.');
    process.exit(1);
  }

  const t2 = biggestTableByName(f2, 'Coach');
  await t2.readRecords();
  let mismatches = 0;
  for (const c of before) {
    const r2 = t2.records[c.row];
    const after = { name: safe(r2, 'Name'), level: safe(r2, 'Level'), team: safe(r2, 'TeamIndex'), head: safe(r2, 'GenericHeadAssetName') };
    const ok = after.name === c.name && after.level === c.level && after.team === c.team && after.head === c.head;
    console.log(`  ${ok ? 'OK  ' : 'DIFF'} row ${c.row} ${c.name}: `, ok ? '' : JSON.stringify({ before: c, after }));
    if (!ok) mismatches++;
  }

  console.log('\n=== 6. full-table sanity: same populated-row count? ===');
  const countPopulated = (tbl) => tbl.records.filter((r) => !r.isEmpty && safe(r, 'Name')).length;
  const beforeCount = countPopulated(t);
  const afterCount = countPopulated(t2);
  console.log(`  before: ${beforeCount} coaches | after: ${afterCount} coaches | match: ${beforeCount === afterCount}`);

  console.log(`\n${'='.repeat(60)}`);
  if (mismatches === 0 && beforeCount === afterCount) {
    console.log('RESULT: PASS -- CFB saves can be written and read back losslessly.');
    console.log('Madden->CFB is a build job, not a research question.');
  } else {
    console.log(`RESULT: FAIL -- ${mismatches} field mismatches, coach count ${beforeCount}->${afterCount}.`);
  }
  console.log(`\nOutput left at: ${OUT}`);
  console.log('(Not auto-deleted -- load it in CFB27 to confirm the GAME itself accepts it, not just this library.)');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
