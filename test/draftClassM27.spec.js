// Regression test for the Madden 27 draft-class format profile
// (lib/draftClassFile.js FORMATS / detectFormat / off).
//
// M27 keeps the same FBCHUNKS container and the same field ORDER as M26, but:
//   * the per-player binary record grew 200 -> 244 bytes, and
//   * the FirstName field grew 17 -> 21, shifting every later field by +4.
//
// Both were measured against real exports of each game, and the +4 shift was
// confirmed as the ONLY one under which age/height/weight/position are
// simultaneously plausible for all 389 players (100% vs ~1% for the runner-up)
// and every rating byte lands 0..99.
//
// The 244-byte record's extra space holds five u16 fields (record offsets
// 202/204/206/208/210) that M26 has no equivalent for -- populated for every
// player, position-correlated, almost certainly per-player ability/trait slots.
// The exporter never synthesizes them; they ride along from the template donor.
// The critical property tested here is that editing a player does NOT disturb
// them, because a zeroed ability block would be a silent in-game regression.
//
// Fixture-based: builds a synthetic file of each shape rather than depending on
// a real save, so this runs anywhere. Run: node test/draftClassM27.spec.js
'use strict';

const assert = require('assert');
const {
  parseDraftClassFile, serializeDraftClassFile,
  setPosition, setAge, setHeight, setWeight, setJersey, setRatings,
  setDraftRound, setDraftPick,
  getPosition, getAge, getHeight, getWeight, getJersey, getRatings,
  getDraftRound, getDraftPick,
} = require('../lib/draftClassFile');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

// --- fixture builder ---------------------------------------------------------
// Mirrors the real container: 0x46-byte header (schema tag + player count),
// then per player [JSON][zero padding][binary record].
function buildFile({ schemaTag, binLen, fieldShift, players }) {
  const header = Buffer.alloc(0x46);
  header.write('FBCHUNKS', 0, 'utf8');
  header.writeUInt16LE(1, 0x08);
  header.write(schemaTag, 0x22, 'utf8');          // null-padded inside the 36-byte block
  header.writeUInt32LE(players.length, 0x42);      // player count sits at block end - 4

  const parts = [header];
  for (const p of players) {
    const json = Buffer.from(JSON.stringify(p.visuals), 'utf8');
    const pad = Buffer.alloc(64, 0);               // any zero run; the parser scans it
    const bin = Buffer.alloc(binLen, 0);
    // names: FirstName field is 17 (M26) or 21 (M27) bytes wide
    const nameField = 17 + fieldShift;
    bin.write(p.first, 0, 'utf8');
    bin.write(p.last, nameField, 'utf8');
    // M26-coordinate fields, rebased by the shift
    bin[70 + fieldShift] = p.age;
    bin[71 + fieldShift] = p.height;
    bin[72 + fieldShift] = p.weight - 160;
    bin[74 + fieldShift] = p.positionValue;
    bin[76 + fieldShift] = p.jersey;
    bin[80 + fieldShift] = p.round;
    bin.writeUInt16LE(p.pick, 78 + fieldShift);
    bin[123 + fieldShift] = p.speed;               // SpeedRating
    bin[127 + fieldShift] = p.strength;            // StrengthRating
    // the M27-only ability block
    if (p.abilities) p.abilities.forEach((v, i) => bin.writeUInt16LE(v, 202 + i * 2));
    parts.push(json, pad, bin);
  }
  parts.push(Buffer.alloc(32, 0));                 // trailer
  return Buffer.concat(parts);
}

const visuals26 = { bodyType: 'Standard', genericHeadName: 'gen_5_B_N_03', skinTone: 5, loadouts: [] };
const visuals27 = { bodyType: 'Heavy', genericHeadName: 'gen_3_H_B_008', loadouts: [] };
const base = {
  first: 'Justin', last: 'Bailote', age: 22, height: 74, weight: 215,
  positionValue: 0, jersey: 7, round: 2, pick: 45, speed: 88, strength: 70,
};

// --- M26 still parses exactly as before (control) ----------------------------
{
  const buf = buildFile({
    schemaTag: 'Madden-26-RL10-8802649', binLen: 200, fieldShift: 0,
    players: [{ ...base, visuals: visuals26 }],
  });
  const m = parseDraftClassFile(buf);
  check('M26 detected as m26', m.format.key, 'm26');
  check('M26 record length', m.format.binaryRecordLen, 200);
  check('M26 field shift', m.format.fieldShift, 0);
  check('M26 round-trips byte-identically', serializeDraftClassFile(m).equals(buf), true);
  const p = m.players[0];
  check('M26 decodes position', getPosition(p), 'QB');
  check('M26 decodes age/height/weight', [getAge(p), getHeight(p), getWeight(p)], [22, 74, 215]);
  check('M26 decodes ratings', getRatings(p).SpeedRating, 88);
}

// --- M27: wider record, +4 shift --------------------------------------------
const ABILITIES = [49, 1, 12, 45, 19];
{
  const buf = buildFile({
    schemaTag: 'Madden-27-RL1-9074430', binLen: 244, fieldShift: 4,
    players: [{ ...base, visuals: visuals27, abilities: ABILITIES }],
  });
  const m = parseDraftClassFile(buf);
  check('M27 detected as m27', m.format.key, 'm27');
  check('M27 record length', m.format.binaryRecordLen, 244);
  check('M27 field shift', m.format.fieldShift, 4);
  check('M27 round-trips byte-identically', serializeDraftClassFile(m).equals(buf), true);

  let p = m.players[0];
  check('M27 reads names past the wider FirstName field',
    [p.binary.firstName, p.binary.lastName], ['Justin', 'Bailote']);
  check('M27 decodes position through the +4 shift', getPosition(p), 'QB');
  check('M27 decodes age/height/weight', [getAge(p), getHeight(p), getWeight(p)], [22, 74, 215]);
  check('M27 decodes jersey/round/pick', [getJersey(p), getDraftRound(p), getDraftPick(p)], [7, 2, 45]);
  check('M27 decodes ratings', [getRatings(p).SpeedRating, getRatings(p).StrengthRating], [88, 70]);

  const readAbilities = (pl) => [0, 1, 2, 3, 4].map((i) => pl.binary.raw.readUInt16LE(202 + i * 2));
  check('M27 ability block present as parsed', readAbilities(p), ABILITIES);

  // THE POINT: every exporter-style edit must leave the ability block alone.
  p = setPosition(p, 'HB');
  p = setAge(p, 21);
  p = setHeight(p, 70);
  p = setWeight(p, 205);
  p = setJersey(p, 28);
  p = setDraftRound(p, 3);
  p = setDraftPick(p, 88);
  p = setRatings(p, { SpeedRating: 91, StrengthRating: 64, AwarenessRating: 60 });

  check('edits applied', [getPosition(p), getAge(p), getJersey(p), getDraftPick(p)], ['HB', 21, 28, 88]);
  check('edited ratings read back', [getRatings(p).SpeedRating, getRatings(p).AwarenessRating], [91, 60]);
  check('ability block survives every edit', readAbilities(p), ABILITIES);
  check('record length unchanged by edits', p.binary.raw.length, 244);

  // and survives a full serialize -> re-parse cycle
  m.players[0] = p;
  const out = serializeDraftClassFile(m);
  const again = parseDraftClassFile(out);
  check('ability block survives serialize/re-parse', readAbilities(again.players[0]), ABILITIES);
  check('edited player survives serialize/re-parse',
    [getPosition(again.players[0]), getRatings(again.players[0]).SpeedRating], ['HB', 91]);
}

// --- an M26 file must never be read with M27 offsets, and vice versa ---------
{
  const m26buf = buildFile({
    schemaTag: 'Madden-26-RL10-8802649', binLen: 200, fieldShift: 0,
    players: [{ ...base, visuals: visuals26 }],
  });
  const m27buf = buildFile({
    schemaTag: 'Madden-27-RL1-9074430', binLen: 244, fieldShift: 4,
    players: [{ ...base, visuals: visuals27, abilities: ABILITIES }],
  });
  check('the two shapes really do differ in size', m26buf.length === m27buf.length, false);
  check('each is detected independently',
    [parseDraftClassFile(m26buf).format.key, parseDraftClassFile(m27buf).format.key], ['m26', 'm27']);
}

console.log(`\n  Draft-class M27 format spec: ${passed} assertions passed.\n`);
