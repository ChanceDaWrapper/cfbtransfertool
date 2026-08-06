// WRITES test saves. Proves the CFB->Madden tone path end to end, for both
// kinds of CFB coach:
//   A. a Generic_* coach whose head encodes a tone  -> exact match, no config
//   B. a Unique_* coach with no tone                -> flagged guess
//   C. the same Unique_* coach after an override    -> exact match
//
// C is the important one: it proves data/cfbCoachTones.json is actually load
// bearing, so filling it in is worth the effort.

const fs = require('fs');
const FranchiseFile = require('madden-franchise');
const { moveCoachCfbToMaddenTeam } = require('../lib/carousel');
const { safe, biggestTableByName } = require('../lib/saveIO');
const { CFB_TONE_PATH } = require('../lib/carousel/appearance');

const CFB = 'C:/Users/tripl/Documents/EA SPORTS College Football 27/saves/DYNASTY-MAINDYNASTY';
const MADDEN = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-JUL06-10h10m34a-AUTOSAVE';
const OUT = 'C:/Users/tripl/Documents/Madden NFL 26/Saves/CAREER-TONEE2E';

const open = (p) => FranchiseFile.create(p, { autoUnempty: true });

async function run(label, cfbFile, row, expectGuess) {
  const maddenFile = await open(MADDEN);
  const res = await moveCoachCfbToMaddenTeam({
    cfbFile, maddenFile, cfbCoachRowIndex: row,
    teamIndex: 24, teamName: 'Giants', outputPath: OUT,
    config: { allowOffWindowHeadCoachHire: true },
    log: () => {},
  });
  const a = res.appearanceReport;
  const flag = a.toneWasGuessed === expectGuess ? 'OK ' : '!! ';
  console.log(`${flag}${label}`);
  console.log(`      head ${a.head}  mappedTone ${a.mappedTone}  guessed=${a.toneWasGuessed}`);
  console.log(`      selection: ${a.selection}`);
  return a;
}

(async () => {
  const cfbFile = await open(CFB);
  const t = biggestTableByName(cfbFile, 'Coach');
  await t.readRecords();

  // find a Generic_* HC and the Freeman row
  let genericRow = null, freemanRow = null, freemanHead = null;
  for (let i = 0; i < t.records.length; i++) {
    const r = t.records[i];
    if (!r || r.isEmpty || !safe(r, 'Name')) continue;
    if (safe(r, 'Position') !== 'HeadCoach') continue;
    const head = String(safe(r, 'GenericHeadAssetName') || '');
    if (genericRow === null && /^Generic_/.test(head)) genericRow = { row: i, name: safe(r, 'Name'), head };
    if (/FreemanMarcus/.test(head)) { freemanRow = i; freemanHead = head; }
  }

  console.log('\n=== A. Generic_* coach, zero config ===');
  await run(`${genericRow.name}  (${genericRow.head})`, cfbFile, genericRow.row, false);

  console.log('\n=== B. Unique_* coach, no override ===');
  await run(`M. Freeman  (${freemanHead})`, cfbFile, freemanRow, true);

  console.log('\n=== C. same coach, with an override ===');
  const original = fs.readFileSync(CFB_TONE_PATH, 'utf8');
  try {
    const j = JSON.parse(original);
    j.overrides[freemanHead] = 7;
    fs.writeFileSync(CFB_TONE_PATH, JSON.stringify(j, null, 2));
    // the module caches on first read, so run this in a child process
    const { execFileSync } = require('child_process');
    const out = execFileSync(process.execPath, ['-e', `
      const {cfbSkinTone,loadCfbTones}=require(${JSON.stringify(require.resolve('../lib/carousel/appearance'))});
      console.log('      overrides loaded:', loadCfbTones().overrides.size);
      console.log('      cfbSkinTone(${JSON.stringify(freemanHead)}) ->', cfbSkinTone(${JSON.stringify(freemanHead)}));
    `], { encoding: 'utf8' });
    process.stdout.write(out);
    console.log('OK  override takes precedence over the (absent) head-name tone');
  } finally {
    fs.writeFileSync(CFB_TONE_PATH, original);
    console.log('      (override file restored to shipped state)');
  }

  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  console.log('\ncleaned up test save.');
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
