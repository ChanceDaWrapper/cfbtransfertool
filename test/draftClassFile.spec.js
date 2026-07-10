// Dependency-free regression test for lib/draftClassFile.js -- Phase 5a's
// byte-perfect round-trip gate (see FACES_AND_DRAFT_ROADMAP.md, Phase 5).
// Run with: node test/draftClassFile.spec.js (or npm test).
//
// This builds a SYNTHETIC file matching the real format exactly (rather than
// depending on a real Madden export, which lives outside this repo), so the
// suite runs anywhere. The real-file gate (4/4 real CAREERDRAFT-* exports,
// spanning two different schema tags, round-tripping byte-for-byte) was run
// separately and is recorded as passed in the roadmap; this test locks the
// module's behavior in so a future change can't silently break that result.

const assert = require('assert');
const {
  BINARY_RECORD_LEN,
  parseDraftClassFile,
  serializeDraftClassFile,
  verifyRoundTrip,
  scanJsonObject,
  setJsonFieldSameLength,
  setBinaryName,
  setBinaryBytes,
  getFaceId,
  setFaceId,
  getPosition,
  setPosition,
  POSITION_OFFSET,
  POSITION_ENUM,
  getHeight,
  setHeight,
  getWeight,
  setWeight,
  HEIGHT_OFFSET,
  WEIGHT_OFFSET,
  getAge,
  setAge,
  getJersey,
  setJersey,
  getArchetype,
  setArchetype,
  getDevTrait,
  setDevTrait,
  getRatings,
  setRatings,
  RATING_OFFSETS,
  AGE_OFFSET,
  JERSEY_OFFSET,
  DEVTRAIT_OFFSET,
  make5bTestEdit,
} = require('../lib/draftClassFile');

let passed = 0;
function check(label, got, want) {
  assert.strictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}

// Builds a null-padded binary struct: firstName, then padding, then lastName,
// then padding, then a "<n>PLACEHOLDER" marker, then filler bytes, then an
// asset token near the end, all inside exactly BINARY_RECORD_LEN bytes --
// matching the real shape found in every sampled player record.
function makeBinaryRecord(firstName, lastName) {
  const buf = Buffer.alloc(BINARY_RECORD_LEN, 0);
  buf.write(firstName, 0, 'utf8');
  let p = firstName.length + 3; // arbitrary gap, real samples vary
  buf.write(lastName, p, 'utf8');
  p += lastName.length + 2;
  buf.write('1PLACEHOLDER', p, 'utf8');
  p += 'PLACEHOLDERx'.length + 20; // leave room for "filler" packed-rating bytes
  const assetToken = `${lastName}${firstName}_100_1`;
  const tokenOffset = BINARY_RECORD_LEN - assetToken.length - 10;
  buf.write(assetToken, tokenOffset, 'utf8');
  return buf;
}

function makePlayerSlot(visuals, firstName, lastName, gapLen) {
  const json = Buffer.from(JSON.stringify(visuals), 'utf8');
  const gap = Buffer.alloc(gapLen, 0);
  const binary = makeBinaryRecord(firstName, lastName);
  return Buffer.concat([json, gap, binary]);
}

function makeSyntheticFile(players, { trailerLen = 500, schemaTag = 'Madden-26-RL10-8802649' } = {}) {
  const header = Buffer.alloc(0x22 + 36, 0);
  header.write('FBCHUNKS', 0, 'utf8');
  header.writeUInt16LE(1, 0x08); // version
  header.writeUInt32LE(0x34, 0x0A); // fieldA (opaque)
  header.writeUInt32LE(0x1234, 0x0E); // fieldB (opaque)
  header.writeUInt32LE(0x1234 + 0x34, 0x12); // fieldC (opaque)
  header.writeUInt16LE(2026, 0x16); // year
  header.writeUInt16LE(4, 0x18);
  header.writeUInt16LE(23, 0x1A);
  header.writeUInt16LE(13, 0x1C);
  header.writeUInt16LE(8, 0x1E);
  header.writeUInt16LE(99, 0x20); // fieldD (opaque -- deliberately NOT a real length, per the 5a finding)
  header.write(schemaTag, 0x22, 'utf8');
  header.writeUInt32LE(players.length, 0x22 + 36 - 4);

  const slots = players.map((p, i) => makePlayerSlot(p.visuals, p.firstName, p.lastName, 40 + i * 7));
  const trailer = Buffer.alloc(trailerLen, 0);
  return Buffer.concat([header, ...slots, trailer]);
}

const samplePlayers = [
  { firstName: 'Michael', lastName: 'Fasusi', visuals: { bodyType: 'Heavy', genericHeadName: 'gen_6_B_G_03', skinTone: 6 } },
  { firstName: 'David', lastName: 'Sanders', visuals: { bodyType: 'Thin', genericHeadName: 'gen_2_M_N_22', skinTone: 2, loadouts: [{ slotType: 'CharacterBodyType' }] } },
  { firstName: 'Colton', lastName: 'Vasek', visuals: { bodyType: 'Muscular', genericHeadName: 'gen_1_B_N_011', skinTone: 1 } },
];

// 1. Round-trip gate: parse then re-serialize must reproduce the input exactly.
{
  const buf = makeSyntheticFile(samplePlayers);
  const { identical, model, originalLength, reemittedLength } = verifyRoundTrip(buf);
  check('round-trip: byte-identical', identical, true);
  check('round-trip: length preserved', reemittedLength, originalLength);
  check('round-trip: player count parsed', model.header.playerCount, 3);
  check('round-trip: schema tag parsed', model.header.schemaTag, 'Madden-26-RL10-8802649');
}

// 2. Per-player fields decode correctly (name pairing, JSON visuals).
{
  const buf = makeSyntheticFile(samplePlayers);
  const model = parseDraftClassFile(buf);
  check('player count', model.players.length, 3);
  for (let i = 0; i < samplePlayers.length; i++) {
    check(`player ${i} firstName`, model.players[i].binary.firstName, samplePlayers[i].firstName);
    check(`player ${i} lastName`, model.players[i].binary.lastName, samplePlayers[i].lastName);
    check(`player ${i} bodyType`, model.players[i].json.visuals.bodyType, samplePlayers[i].visuals.bodyType);
    check(`player ${i} skinTone`, model.players[i].json.visuals.skinTone, samplePlayers[i].visuals.skinTone);
    check(`player ${i} genericHeadName`, model.players[i].json.visuals.genericHeadName, samplePlayers[i].visuals.genericHeadName);
  }
}

// 3. A stray 0x7b (the '{' byte) inside a binary struct's packed-rating bytes
//    must NOT be mistaken for the next player's JSON start -- this is exactly
//    the false-positive that a naive indexOf('{') hit during investigation.
{
  const buf = makeSyntheticFile(samplePlayers);
  const model = parseDraftClassFile(buf);
  // Poke a literal '{' into the middle of player 0's binary struct (well past
  // its name fields) and confirm parsing is unaffected, because binary bytes
  // are consumed as a fixed-length raw slice, never scanned for JSON syntax.
  const rebuilt = serializeDraftClassFile(model);
  const p0BinaryStart = model.header.raw.length + model.players[0].json.raw.length + model.players[0].gap.raw.length;
  rebuilt[p0BinaryStart + 150] = 0x7b;
  const reparsed = parseDraftClassFile(rebuilt);
  check('stray brace in binary struct: player count unaffected', reparsed.players.length, 3);
  check('stray brace in binary struct: player 1 still parses', reparsed.players[1].binary.firstName, 'David');
}

// 4. Error paths: bad magic and a truncated file are rejected, not silently misparsed.
{
  const buf = makeSyntheticFile(samplePlayers);
  const badMagic = Buffer.from(buf);
  badMagic.write('XXXXXXXX', 0, 'utf8');
  assert.throws(() => parseDraftClassFile(badMagic), /FBCHUNKS/, 'bad magic should throw');
  passed++;

  const truncated = buf.slice(0, buf.length - 550); // cuts into the last player's binary struct, past the 500-byte trailer
  assert.throws(() => parseDraftClassFile(truncated), /Player \d+/, 'truncated file should throw mid-player, not silently succeed');
  passed++;
}

// 5. scanJsonObject respects escaped quotes/braces inside JSON strings.
{
  const tricky = Buffer.from('{"a":"has a \\" quote and a { brace inside"}TAIL', 'utf8');
  const end = scanJsonObject(tricky, 0);
  check('scanJsonObject: stops at true closing brace', tricky.slice(end).toString('utf8'), 'TAIL');
}

// 6. Phase 5b same-length JSON field edit: value changes, blob length doesn't.
{
  const buf = makeSyntheticFile(samplePlayers);
  const model = parseDraftClassFile(buf);
  const edited = setJsonFieldSameLength(model.players[0], 'bodyType', 'Light'); // 'Heavy' -> 'Light', both 5 chars
  check('setJsonFieldSameLength: value updated', edited.json.visuals.bodyType, 'Light');
  check('setJsonFieldSameLength: blob length unchanged', edited.json.raw.length, model.players[0].json.raw.length);
  check('setJsonFieldSameLength: other visuals fields untouched', edited.json.visuals.genericHeadName, model.players[0].json.visuals.genericHeadName);

  assert.throws(
    () => setJsonFieldSameLength(model.players[0], 'bodyType', 'Standard'),
    /not the same byte length/,
    'mismatched-length replacement should throw rather than silently shifting the file'
  );
  passed++;
}

// 7. Phase 5b binary name edit: fits within the original allocation, everything
//    after the name (marker, ratings, asset token bytes) is untouched.
{
  const buf = makeSyntheticFile(samplePlayers);
  const model = parseDraftClassFile(buf);
  const original = model.players[1]; // 'David Sanders'
  const edited = setBinaryName(original, 'lastName', 'S');
  check('setBinaryName: lastName updated', edited.binary.lastName, 'S');
  check('setBinaryName: struct length unchanged', edited.binary.raw.length, BINARY_RECORD_LEN);
  check('setBinaryName: firstName untouched', edited.binary.firstName, 'David');
  // Bytes strictly after the renamed field's original allocation must be identical --
  // this is what "same-length edit, no offset shift" actually means at the byte level.
  const firstNameEnd = original.binary.firstName.length;
  let lastNameStart = firstNameEnd;
  while (original.binary.raw[lastNameStart] === 0) lastNameStart++;
  let lastNameAllocEnd = lastNameStart + original.binary.lastName.length;
  while (original.binary.raw[lastNameAllocEnd] === 0) lastNameAllocEnd++;
  const tailOriginal = original.binary.raw.slice(lastNameAllocEnd);
  const tailEdited = edited.binary.raw.slice(lastNameAllocEnd);
  check('setBinaryName: bytes after the renamed field are byte-identical', Buffer.compare(tailOriginal, tailEdited), 0);

  assert.throws(
    () => setBinaryName(original, 'lastName', 'A'.repeat(BINARY_RECORD_LEN)),
    /does not fit/,
    'an oversized replacement name should throw rather than overwrite adjacent fields'
  );
  passed++;
}

// 8. Phase 5b end-to-end: make5bTestEdit changes exactly one player's slot and
//    leaves the rest of the file, byte for byte, identical to the original --
//    this is the actual file this gate hands to a real Madden import test.
{
  const buf = makeSyntheticFile(samplePlayers);
  const model = parseDraftClassFile(buf);
  const { buffer: editedBuf, change } = make5bTestEdit(model, 2, { lastNameMarker: 'TEST' }); // player 2 = 'Colton Vasek', bodyType 'Muscular'; marker sized to fit the synthetic fixture's small gap

  check('make5bTestEdit: output length unchanged', editedBuf.length, buf.length);
  check('make5bTestEdit: bodyType changed to a same-length alternative', change.bodyType.to !== change.bodyType.from, true);
  check('make5bTestEdit: bodyType alternative really is same length', change.bodyType.to.length, change.bodyType.from.length);

  const reparsed = parseDraftClassFile(editedBuf);
  check('make5bTestEdit: edited player bodyType visible on re-parse', reparsed.players[2].json.visuals.bodyType, change.bodyType.to);
  check('make5bTestEdit: edited player lastName visible on re-parse', reparsed.players[2].binary.lastName, 'TEST');

  // Every OTHER player's slot bytes must be untouched.
  for (const i of [0, 1]) {
    const before = Buffer.concat([model.players[i].json.raw, model.players[i].gap.raw, model.players[i].binary.raw]);
    const after = Buffer.concat([reparsed.players[i].json.raw, reparsed.players[i].gap.raw, reparsed.players[i].binary.raw]);
    check(`make5bTestEdit: player ${i}'s slot is untouched`, Buffer.compare(before, after), 0);
  }
  check('make5bTestEdit: header untouched', Buffer.compare(reparsed.header.raw, model.header.raw), 0);
  check('make5bTestEdit: trailer untouched', Buffer.compare(reparsed.trailer.raw, model.trailer.raw), 0);
}

// 9. setBinaryBytes / face-ID helpers: overwrite specific struct bytes in place,
//    same length, only the targeted bytes change; out-of-range throws.
{
  const buf = makeSyntheticFile(samplePlayers);
  const model = parseDraftClassFile(buf);
  const p = model.players[0];

  const edited = setBinaryBytes(p, [{ offset: 146, value: 0xAB }, { offset: 147, value: 0x0F }]);
  check('setBinaryBytes: struct length unchanged', edited.binary.raw.length, BINARY_RECORD_LEN);
  check('setBinaryBytes: byte 146 set', edited.binary.raw[146], 0xAB);
  check('setBinaryBytes: byte 147 set', edited.binary.raw[147], 0x0F);
  check('setBinaryBytes: original model untouched (clone)', p.binary.raw[146] === 0xAB, false);
  // every OTHER byte identical
  let diffs = 0;
  for (let i = 0; i < BINARY_RECORD_LEN; i++) if (i !== 146 && i !== 147 && edited.binary.raw[i] !== p.binary.raw[i]) diffs++;
  check('setBinaryBytes: no collateral byte changes', diffs, 0);

  // face-ID round-trips through the u16 LE helpers
  const withId = setFaceId(p, 3955);
  check('setFaceId/getFaceId round-trip', getFaceId(withId), 3955);
  check('setFaceId writes low byte', withId.binary.raw[146], 3955 & 0xff);
  check('setFaceId writes high byte', withId.binary.raw[147], (3955 >> 8) & 0xff);

  assert.throws(() => setBinaryBytes(p, [{ offset: 999, value: 1 }]), /out of range/, 'out-of-range offset should throw');
  passed++;
}

// 10. Position (offset 74): get/set by name and by raw value, round-trips, and
//     matches the real Madden PositionE values found via schema query (ground
//     truth from FACES_AND_DRAFT_ROADMAP.md Phase 5c: QB=0, LT=5, LG=6, DT=12, CB=16).
{
  const buf = makeSyntheticFile(samplePlayers);
  const model = parseDraftClassFile(buf);
  const p = model.players[0];

  check('POSITION_ENUM ground truth: QB', POSITION_ENUM[0], 'QB');
  check('POSITION_ENUM ground truth: LT (shown as OT in-game)', POSITION_ENUM[5], 'LT');
  check('POSITION_ENUM ground truth: LG (shown as IOL in-game)', POSITION_ENUM[6], 'LG');
  check('POSITION_ENUM ground truth: DT', POSITION_ENUM[12], 'DT');
  check('POSITION_ENUM ground truth: CB', POSITION_ENUM[16], 'CB');

  const asWr = setPosition(p, 'WR');
  check('setPosition by name writes the right byte', asWr.binary.raw[POSITION_OFFSET], 3);
  check('getPosition reads it back by name', getPosition(asWr), 'WR');

  const asRaw = setPosition(p, 12);
  check('setPosition accepts a raw numeric value', getPosition(asRaw), 'DT');

  // struct length and all other bytes unchanged -- single-byte same-length edit
  check('setPosition: struct length unchanged', asWr.binary.raw.length, BINARY_RECORD_LEN);
  let diffs = 0;
  for (let i = 0; i < BINARY_RECORD_LEN; i++) if (i !== POSITION_OFFSET && asWr.binary.raw[i] !== p.binary.raw[i]) diffs++;
  check('setPosition: no collateral byte changes', diffs, 0);

  assert.throws(() => setPosition(p, 'NOT_A_REAL_POSITION'), /unrecognized position/, 'unknown position name should throw');
  passed++;
  assert.throws(() => setPosition(p, 999), /unrecognized position/, 'unknown position value should throw');
  passed++;
}

// 11. Height/Weight (offsets 71/72): get/set round-trip, Weight's -160 encoding,
//     ground truth from real screenshots (Beau Johnson 297lb/6'5"=77in, Jericho
//     Johnson 342lb/6'3"=75in, Malik Washington 231lb/6'4"=76in).
{
  const buf = makeSyntheticFile(samplePlayers);
  const model = parseDraftClassFile(buf);
  const p = model.players[0];

  const tallHeavy = setWeight(setHeight(p, 77), 342);
  check('setHeight/getHeight round-trip', getHeight(tallHeavy), 77);
  check('setWeight/getWeight round-trip', getWeight(tallHeavy), 342);
  check('setWeight: -160 raw encoding', tallHeavy.binary.raw[WEIGHT_OFFSET], 342 - 160);
  check('setHeight: raw inches, no transform', tallHeavy.binary.raw[HEIGHT_OFFSET], 77);

  // struct length and all other bytes unchanged
  check('setHeight/setWeight: struct length unchanged', tallHeavy.binary.raw.length, BINARY_RECORD_LEN);
  let diffs = 0;
  for (let i = 0; i < BINARY_RECORD_LEN; i++) if (i !== HEIGHT_OFFSET && i !== WEIGHT_OFFSET && tallHeavy.binary.raw[i] !== p.binary.raw[i]) diffs++;
  check('setHeight/setWeight: no collateral byte changes', diffs, 0);

  assert.throws(() => setWeight(p, 100), /out of the encodable range/, 'weight below 160 should throw (raw byte would go negative)');
  passed++;
  assert.throws(() => setWeight(p, 500), /out of the encodable range/, 'weight above 415 should throw (raw byte would exceed 255)');
  passed++;
  assert.throws(() => setHeight(p, 300), /not a valid raw byte/, 'height above 255 should throw');
  passed++;
}

// 12. Loop-confirmed fields: Age (70), Jersey (76), Dev trait (140 enum), and the
//     ratings block (82-138). All ground-truthed via the import->read-roster loop.
{
  const buf = makeSyntheticFile(samplePlayers);
  const model = parseDraftClassFile(buf);
  const p = model.players[0];

  check('setAge/getAge round-trip', getAge(setAge(p, 22)), 22);
  check('setAge writes offset 70', setAge(p, 22).binary.raw[AGE_OFFSET], 22);
  check('setJersey/getJersey round-trip', getJersey(setJersey(p, 87)), 87);
  check('setJersey writes offset 76', setJersey(p, 87).binary.raw[JERSEY_OFFSET], 87);
  assert.throws(() => setJersey(p, 100), /out of range/, 'jersey > 99 should throw');
  passed++;

  // dev trait by value and by name (enum identical to CFB)
  check('setDevTrait by value', getDevTrait(setDevTrait(p, 2)).name, 'College_Star');
  check('setDevTrait by name', getDevTrait(setDevTrait(p, 'College_Elite')).value, 3);
  check('setDevTrait writes offset 140', setDevTrait(p, 1).binary.raw[DEVTRAIT_OFFSET], 1);
  assert.throws(() => setDevTrait(p, 9), /unrecognized trait/, 'invalid dev trait should throw');
  passed++;

  // archetype (raw PlayerType value, direct copy)
  check('setArchetype/getArchetype round-trip', getArchetype(setArchetype(p, 27)), 27);
}

// 13. Ratings table integrity + set/get. The table must cover the whole 82-138
//     block (minus the two unmapped offsets 103/121) with unique offsets, and
//     setRatings must write each to its exact confirmed offset.
{
  const buf = makeSyntheticFile(samplePlayers);
  const model = parseDraftClassFile(buf);
  const p = model.players[0];

  const offs = Object.values(RATING_OFFSETS);
  check('rating count (82-138 minus 103,121)', offs.length, 55);
  check('all rating offsets are unique', new Set(offs).size, offs.length);
  check('all rating offsets are within 82..138', offs.every((o) => o >= 82 && o <= 138), true);
  check('SpeedRating is offset 123 (loop ground truth)', RATING_OFFSETS.SpeedRating, 123);
  check('StrengthRating is offset 127 (loop ground truth)', RATING_OFFSETS.StrengthRating, 127);
  check('ZoneCoverageRating is offset 138 (loop ground truth)', RATING_OFFSETS.ZoneCoverageRating, 138);

  const edited = setRatings(p, { SpeedRating: 91, StrengthRating: 55, ZoneCoverageRating: 40, NotARating: 99 });
  check('setRatings writes Speed to offset 123', edited.binary.raw[123], 91);
  check('setRatings writes Strength to offset 127', edited.binary.raw[127], 55);
  check('setRatings writes ZoneCoverage to offset 138', edited.binary.raw[138], 40);
  check('setRatings ignores unknown keys', getRatings(edited).SpeedRating, 91);
  // ratings not passed keep the template value (only the 3 given changed)
  let changed = 0;
  for (let i = 0; i < BINARY_RECORD_LEN; i++) if (edited.binary.raw[i] !== p.binary.raw[i]) changed++;
  check('setRatings only changed the 3 given ratings', changed, 3);
  assert.throws(() => setRatings(p, { SpeedRating: 150 }), /out of range/, 'rating > 99 should throw');
  passed++;
}

console.log(`\n  Draft-class file spec: ${passed} assertions passed.`);

