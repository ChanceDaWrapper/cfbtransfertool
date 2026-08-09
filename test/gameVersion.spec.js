// gameVersion.js -- resolving WHICH game and WHICH build a save came from,
// once, so every later decision refers to one answer.
//
// This is detection, not a user-facing switch: a save states its own year in
// the header and its own title update in the container, so asking the user to
// pick would only add a way to be wrong. What was missing was making the
// answer explicit and visible -- "which Madden was this?" was the first
// question every bug report needed and nothing surfaced it.

const assert = require('assert');
const {
  detectMaddenVersion, detectCfbVersion, describePairing, buildTag, releaseNumber,
} = require('../lib/carousel/gameVersion');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

// A stand-in save: the build stamp lives as plain text in the first bytes of
// the container, right after the FBCHUNKS magic.
function fakeSave({ tag = null, gameYear = null, coachAttrs = [] } = {}) {
  const head = Buffer.alloc(256, 0);
  if (tag) Buffer.from(`FBCHUNKS${tag}`, 'latin1').copy(head, 0);
  return {
    gameYear,
    packedFileContents: head,
    schemaList: { getSchema: (n) => (n === 'Coach' ? { attributes: coachAttrs } : null) },
  };
}
const TALENT = (name) => ({ name, type: 'Talent[]' });
const PLAIN = (name) => ({ name, type: 'int' });

// ---------------------------------------------------------------------
// The build stamp. Real values, taken from actual saves.
// ---------------------------------------------------------------------
{
  check('reads a Madden stamp', buildTag(fakeSave({ tag: 'Madden-26-RL12-9029966' })), 'Madden-26-RL12-9029966');
  check('reads a College stamp', buildTag(fakeSave({ tag: 'College-27-RL3-9080944' })), 'College-27-RL3-9080944');
  check('an unstamped save yields null', buildTag(fakeSave({})), null);
  check('a save with no buffer yields null', buildTag({}), null);
  check('a null file yields null', buildTag(null), null);

  check('release number off a Madden stamp', releaseNumber('Madden-26-RL12-9029966'), 12);
  check('release number off a College stamp', releaseNumber('College-27-RL3-9080944'), 3);
  check('a missing stamp has no release', releaseNumber(null), null);
  check('a malformed stamp has no release', releaseNumber('not-a-tag'), null);
}

// ---------------------------------------------------------------------
// Madden. The one shape difference the carousel branches on is where coach
// talent categories live: on the Coach record (26) or behind a holder (27).
// ---------------------------------------------------------------------
{
  const m26 = detectMaddenVersion(fakeSave({
    tag: 'Madden-26-RL12-9029966', gameYear: 26,
    coachAttrs: [TALENT('PlaysheetTalents'), TALENT('GamedayTalents'), PLAIN('Level')],
  }));
  check('M26 year', m26.year, 26);
  check('M26 release', m26.release, 12);
  check('M26 label names the build', m26.label, 'Madden 26 (RL12)');
  check('M26 keeps talents on the Coach record', m26.coachTalentsOnCoachRecord, true);

  const m27 = detectMaddenVersion(fakeSave({
    tag: 'Madden-27-RL1-9074430', gameYear: 27,
    coachAttrs: [{ name: 'StaffTalents', type: 'AbstractTalentList' }, PLAIN('Level')],
  }));
  check('M27 year', m27.year, 27);
  check('M27 label', m27.label, 'Madden 27 (RL1)');
  check('M27 does NOT keep talents on the Coach record', m27.coachTalentsOnCoachRecord, false);
}

// ---------------------------------------------------------------------
// CFB. The Coach table's width is what a title update actually changed
// (137 -> 138 at RL3) and what saveIO picks a schema on, so reporting it
// makes a version-mismatch refusal self-explanatory.
// ---------------------------------------------------------------------
{
  const rl1 = detectCfbVersion(fakeSave({
    tag: 'College-27-RL1-9039126', gameYear: 27, coachAttrs: new Array(137).fill(0).map((_, i) => PLAIN(`F${i}`)),
  }));
  check('CFB RL1 label', rl1.label, 'College Football 27 (RL1)');
  check('CFB RL1 coach width', rl1.coachFields, 137);

  const rl3 = detectCfbVersion(fakeSave({
    tag: 'College-27-RL3-9080944', gameYear: 27, coachAttrs: new Array(138).fill(0).map((_, i) => PLAIN(`F${i}`)),
  }));
  check('CFB RL3 label', rl3.label, 'College Football 27 (RL3)');
  check('CFB RL3 coach width', rl3.coachFields, 138);
}

// ---------------------------------------------------------------------
// Degenerate saves must degrade to a readable label, never throw -- this
// runs on whatever file the user picked, before anything has validated it.
// ---------------------------------------------------------------------
{
  const bare = detectMaddenVersion(fakeSave({}));
  check('an unidentifiable Madden save still labels', bare.label, 'Madden ?');
  check('with no release', bare.release, null);
  check('and an unknown talent shape', bare.coachTalentsOnCoachRecord, false);

  const noSchema = detectCfbVersion({ gameYear: 27, packedFileContents: Buffer.alloc(4, 0), schemaList: null });
  check('a CFB save with no schema list still labels', noSchema.label, 'College Football 27');
  check('and reports no coach width', noSchema.coachFields, null);
}

// ---------------------------------------------------------------------
// The pairing line -- the one a user reads before anything is written.
// ---------------------------------------------------------------------
{
  const cfb = detectCfbVersion(fakeSave({ tag: 'College-27-RL3-9080944', gameYear: 27 }));
  const mad = detectMaddenVersion(fakeSave({ tag: 'Madden-26-RL12-9029966', gameYear: 26 }));
  check('names both builds', describePairing(cfb, mad),
    'College Football 27 (RL3)  <->  Madden 26 (RL12)');
  check('tolerates a missing side', describePairing(null, mad),
    'unknown CFB save  <->  Madden 26 (RL12)');
}

console.log(`\n  Game version spec: ${passed} assertions passed.`);
