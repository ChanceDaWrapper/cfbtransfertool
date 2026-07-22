// Regression test for lib/draftClassExporter.js -- Phase 5d's full-class emit
// (FACES_AND_DRAFT_ROADMAP.md "PHASE 5 RESTRUCTURE"). Run with:
// node test/draftClassExporter.spec.js (or npm test).
//
// Uses a SYNTHETIC generated-class fixture shaped like calibratePlayers' real
// output (same field names: CFB_Position, Madden_*Rating, TraitDevelopment,
// PlayerType, etc.) so the suite runs anywhere, without a real CFB save. The
// exporter builds from the REAL bundled template (data/draftClassTemplate.bin.gz),
// so this also doubles as an integration check of the whole 5a-5d stack. A
// separate live run against a real CFB save (2535 departed players, 500
// generated, 402 written) is recorded in the roadmap: 0 field mismatches across
// name/position/age/H/W/archetype/dev-trait/round/pick/all 55 ratings, 100% face
// coverage in the render band, 0 warnings.

const assert = require('assert');
const { buildDraftClassFile, TEMPLATE_SLOT_COUNT, extractRatings } = require('../lib/draftClassExporter');
const {
  parseDraftClassFile, getPosition, getHeight, getWeight, getAge, getJersey,
  getArchetype, getDevTrait, getDraftRound, getDraftPick, getRatings, getCollegeIndex,
  getGenericHead, getSkinTone, getCharacterBuild, getFaceId, BODY_BUILD_INDEX, RATING_OFFSETS,
} = require('../lib/draftClassFile');
const { loadTemplateBuffer, loadTemplateModel } = require('../lib/draftClassTemplate');
const { collegeIndexForRef } = require('../lib/collegeIndex');
const { buildCollegeMatcher } = require('../lib/pipeline');

let passed = 0;
function check(label, got, want) {
  assert.strictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}
function ok(label, cond) { assert.ok(cond, label); passed++; }

const POSITIONS = ['QB', 'HB', 'WR', 'TE', 'LT', 'LG', 'C', 'RG', 'RT', 'LE', 'RE', 'DT', 'LOLB', 'MLB', 'ROLB', 'CB', 'FS', 'SS', 'K', 'P'];
const ARCHETYPES = ['QB_StrongArm', 'HB_ElusiveBack', 'WR_DeepThreat', 'DT_NoseTackle', 'CB_Zone'];
const DEV_TRAITS = ['Normal', 'College_Impact', 'College_Star', 'College_Elite'];
const SCHOOLS = ['Alabama', 'Clemson', 'Ohio State', 'Georgia', 'Texas', 'Not A Real School'];

// Builds a synthetic class shaped like calibratePlayers' real output.
function makeSyntheticClass(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ratings = {};
    for (const name of Object.keys(RATING_OFFSETS)) ratings[`Madden_${name}`] = 40 + (i * 7 + name.length * 3) % 60;
    out.push({
      FirstName: `First${i}`, LastName: `Last${i}`,
      CFB_Position: POSITIONS[i % POSITIONS.length],
      PlayerType: ARCHETYPES[i % ARCHETYPES.length],
      Age: 20 + (i % 5),
      Jersey: i % 100,
      Height: 68 + (i % 15),
      Weight: 180 + (i % 150),
      TraitDevelopment: DEV_TRAITS[i % DEV_TRAITS.length],
      ProjectRound: i < 224 ? 1 + Math.floor(i / 32) : null, // ~224 drafted, rest undrafted
      DraftPick: i < 224 ? i + 1 : null,
      SkinTone: 1 + (i % 7),
      CharacterBodyType: ['Standard', 'Thin', 'Muscular', 'Heavy', 'Freshman'][i % 5],
      FormerTeam: SCHOOLS[i % SCHOOLS.length],
      DraftRank: i + 1,
      ...ratings,
    });
  }
  return out;
}

// 1. Only an empty/missing class is refused -- everything else exports,
// filling as many of the 402 slots as it can (2026-07-22 decision, supersedes
// the earlier "must be exactly 402 or throw" rule).
{
  assert.throws(() => buildDraftClassFile([]), /empty/, 'an empty class should throw');
  passed++;
  assert.throws(() => buildDraftClassFile(null), /empty/, 'a non-array class should throw');
  passed++;
}

// 1b. A class smaller than 402 exports successfully: the top-N slots are the
// real generated players, and the REMAINING slots are left completely
// untouched -- byte-identical to the bundled template's own original
// prospects, not blanked or duplicated.
{
  const N = 300;
  const small = makeSyntheticClass(N);
  const buf = buildDraftClassFile(small);
  check('a <402 class still produces a template-length file', buf.length, loadTemplateBuffer().length);
  const model = parseDraftClassFile(buf);
  check('output still parses as 402 players', model.players.length, TEMPLATE_SLOT_COUNT);

  const sorted = small.slice().sort((a, b) => a.DraftRank - b.DraftRank);
  check('slot 0 is the top-ranked real player', model.players[0].binary.firstName, sorted[0].FirstName);
  check(`slot ${N - 1} is the last real player`, model.players[N - 1].binary.firstName, sorted[N - 1].FirstName);

  const original = loadTemplateModel();
  let leftoverMismatches = 0;
  for (let i = N; i < TEMPLATE_SLOT_COUNT; i++) {
    if (model.players[i].binary.firstName !== original.players[i].binary.firstName) leftoverMismatches++;
    if (model.players[i].binary.lastName !== original.players[i].binary.lastName) leftoverMismatches++;
    if (Buffer.compare(model.players[i].binary.raw, original.players[i].binary.raw) !== 0) leftoverMismatches++;
  }
  check(`unfilled slots (${N}-401) are byte-identical to the original template`, leftoverMismatches, 0);
}

// 1c. Going below 224 (the drafted-picks boundary) still succeeds -- there is
// no hard floor, only the WARNING draftClassExporter.js logs.
{
  const tiny = makeSyntheticClass(50);
  const logs = [];
  const buf = buildDraftClassFile(tiny, { log: (m) => logs.push(m) });
  check('a class below 224 still produces a template-length file', buf.length, loadTemplateBuffer().length);
  const model = parseDraftClassFile(buf);
  check('slot 0 is still the top-ranked real player', model.players[0].binary.firstName, 'First0');
  ok('a warning about drafted rounds is logged', logs.some((m) => /WARNING/.test(m) && /drafted/i.test(m)));
}

// 2. Exactly 402 succeeds, and a larger class truncates to the top 402 by DraftRank.
{
  const exact = makeSyntheticClass(TEMPLATE_SLOT_COUNT);
  const buf = buildDraftClassFile(exact);
  check('output is the same length as the bundled template', buf.length, loadTemplateBuffer().length);

  const larger = makeSyntheticClass(500);
  const bufLarger = buildDraftClassFile(larger);
  check('a larger class still produces a template-length file', bufLarger.length, loadTemplateBuffer().length);
  const model = parseDraftClassFile(bufLarger);
  check('output always has exactly 402 players', model.players.length, TEMPLATE_SLOT_COUNT);
  // the top-402-by-rank players (0-401) should be present; rank 402+ (402..499) should not
  check('player ranked 1 (best) is included', model.players.some((p) => p.binary.firstName === 'First0'), true);
  check('player ranked 500 (worst, cut) is excluded', model.players.some((p) => p.binary.firstName === 'First499'), false);
}

// 3. Parse-back: every field matches the source class, for every one of the 402 slots.
{
  const cls = makeSyntheticClass(402);
  const buf = buildDraftClassFile(cls);
  const model = parseDraftClassFile(buf);
  const sorted = cls.slice().sort((a, b) => a.DraftRank - b.DraftRank);

  let mismatches = 0;
  for (let i = 0; i < TEMPLATE_SLOT_COUNT; i++) {
    const src = sorted[i];
    const p = model.players[i];
    if (p.binary.firstName !== src.FirstName) mismatches++;
    if (p.binary.lastName !== src.LastName) mismatches++;
    if (getPosition(p) !== src.CFB_Position) mismatches++;
    if (getArchetype(p).name !== src.PlayerType) mismatches++;
    if (getAge(p) !== src.Age) mismatches++;
    if (getJersey(p) !== src.Jersey) mismatches++;
    if (getHeight(p) !== src.Height) mismatches++;
    if (getWeight(p) !== src.Weight) mismatches++;
    if (getDevTrait(p).name !== src.TraitDevelopment) mismatches++;
    if (getDraftRound(p) !== (src.ProjectRound ?? 63)) mismatches++;
    if (getDraftPick(p) !== (src.DraftPick ?? 0)) mismatches++;
    const ratings = getRatings(p);
    for (const name of Object.keys(RATING_OFFSETS)) {
      if (ratings[name] !== src[`Madden_${name}`]) mismatches++;
    }
  }
  check('every field on every one of the 402 players matches the source (parse-back test)', mismatches, 0);

  // 0 duplicate identities (unique synthetic names by construction)
  const seen = new Set();
  let dupes = 0;
  for (const p of model.players) {
    const key = `${p.binary.firstName}|${p.binary.lastName}`;
    if (seen.has(key)) dupes++;
    seen.add(key);
  }
  check('0 duplicate identities', dupes, 0);
}

// 4. Appearance coherence: every player gets a render-band (visible) portrait,
//    and the portrait skin, the JSON skinTone, and the 3D head digit all agree
//    with the requested SkinTone -- so no light-portrait-on-dark-body mismatch.
{
  const cls = makeSyntheticClass(402);
  const buf = buildDraftClassFile(cls);
  const model = parseDraftClassFile(buf);
  const sorted = cls.slice().sort((a, b) => a.DraftRank - b.DraftRank);

  const allRendered = model.players.every((p) => { const f = getFaceId(p); return f >= 3347 && f <= 4287; });
  check('every player has a render-band (visible) portrait', allRendered, true);

  let skinMismatch = 0, headMismatch = 0;
  for (let i = 0; i < TEMPLATE_SLOT_COUNT; i++) {
    const src = sorted[i];
    const p = model.players[i];
    // synthetic SkinTone is 1..7, all fully covered by the catalog, so the
    // assigned tone equals the requested tone exactly.
    if (getSkinTone(p) !== src.SkinTone) skinMismatch++;
    const digit = Number((getGenericHead(p).match(/^gen_(\d+)_/) || [])[1]);
    if (digit !== src.SkinTone) headMismatch++;
  }
  check('every player skinTone label matches its SkinTone', skinMismatch, 0);
  check('every player 3D head skin digit matches its SkinTone', headMismatch, 0);
}

// 4b. Build: offset 141 (the visible frame) matches the source CharacterBodyType.
{
  const cls = makeSyntheticClass(402);
  const buf = buildDraftClassFile(cls);
  const model = parseDraftClassFile(buf);
  const sorted = cls.slice().sort((a, b) => a.DraftRank - b.DraftRank);
  let buildMismatch = 0;
  for (let i = 0; i < TEMPLATE_SLOT_COUNT; i++) {
    if (getCharacterBuild(model.players[i]) !== BODY_BUILD_INDEX[sorted[i].CharacterBodyType]) buildMismatch++;
  }
  check('every player build byte (offset 141) matches CharacterBodyType', buildMismatch, 0);
}

// 5. Determinism: the same class produces byte-identical output on repeated calls.
{
  const cls = makeSyntheticClass(402);
  const buf1 = buildDraftClassFile(cls);
  const buf2 = buildDraftClassFile(cls);
  check('buildDraftClassFile is deterministic', Buffer.compare(buf1, buf2), 0);
}

// 6. extractRatings: strips the "Madden_" prefix, drops unknown keys, clamps to 0-99.
{
  const r = extractRatings({ Madden_SpeedRating: 95, Madden_StrengthRating: 150, Madden_NotARealRating: 10, OtherField: 5 });
  check('extractRatings strips prefix', r.SpeedRating, 95);
  check('extractRatings clamps out-of-range high', r.StrengthRating, 99);
  check('extractRatings drops unknown rating keys', 'NotARealRating' in r, false);
  check('extractRatings ignores non-Madden_ fields', 'OtherField' in r, false);
}

// 7. College index (offset 66): drafted players resolve to their real
//    school's baked index; a school outside the catalog ("Not A Real School")
//    is left untouched rather than throwing.
{
  const cls = makeSyntheticClass(402);
  const buf = buildDraftClassFile(cls);
  const model = parseDraftClassFile(buf);
  const sorted = cls.slice().sort((a, b) => a.DraftRank - b.DraftRank);
  const matchCollege = buildCollegeMatcher();

  let checked = 0, matched = 0;
  for (let i = 0; i < TEMPLATE_SLOT_COUNT; i++) {
    const src = sorted[i];
    if (src.FormerTeam === 'Not A Real School') continue;
    const ref = matchCollege(src.FormerTeam);
    const expected = collegeIndexForRef(ref);
    if (expected == null) continue; // school matched but outside the baked catalog
    checked++;
    if (getCollegeIndex(model.players[i]) === expected) matched++;
  }
  check('every resolvable school gets its baked college index', matched, checked);
  check('at least some players were actually checked', checked > 0, true);
}

console.log(`\n  Draft-class exporter spec: ${passed} assertions passed.`);
