'use strict';

// Phase 5a -- decode + byte-perfect round-trip for a Madden 26 "Import Draft Class"
// export file (an FBCHUNKS container). READ-ONLY today: this module parses a real
// exported file into a structured model and can re-serialize that model back into
// bytes that are byte-for-byte identical to the input. No field is edited here --
// that is gate 5b's job, once this round-trip is proven solid on real files.
// `madden-franchise` cannot open this format at all (it tries to zlib-inflate a
// chunk that is actually raw JSON), so this is a hand-rolled parser.
//
// Every per-player record turned out to be one contiguous slot:
//   [ JSON visuals blob (variable length: bodyType, genericHeadName, skinTone, loadouts) ]
//   [ zero-byte padding (variable length -- fills the slot out to the next record) ]
//   [ 200-byte binary struct: FirstName, LastName, a "<n>PLACEHOLDER" marker, packed
//     ratings bytes, and a "LastFirst_id1_id2" asset token, null-padded to 200 bytes ]
// The first player's JSON starts immediately after the file header; every later
// player's JSON starts exactly 200 bytes after the previous player's zero-padding
// run ends (i.e. immediately after that player's binary struct). Full derivation
// (including the header field layout) is in FACES_AND_DRAFT_ROADMAP.md, Phase 5.
//
// Two header u32s (fieldB, fieldC) and one more (fieldA) are still unresolved --
// they are carried verbatim as opaque bytes and are not required for the
// byte-perfect round trip this module proves, since header.raw already covers them.

const MAGIC = 'FBCHUNKS';
const BINARY_RECORD_LEN = 200;
// The schema-tag block is a FIXED 36 bytes (0x22..0x46), not a length-prefixed
// field. Confirmed across 4 real exports spanning two schema tags of different
// string lengths ("Madden-26-RL10-8802649", "Madden-26-RL9-8734108") -- the u16
// at 0x20 does NOT track the tag's length (it read 36/5/53/49 across the four
// samples while the tag block start/end and player count offset never moved).
// It is carried verbatim as an opaque header field.
const SCHEMA_BLOCK_START = 0x22;
const SCHEMA_BLOCK_LEN = 36;

function readCString(buf, start, maxLen) {
  let end = start;
  const limit = Math.min(buf.length, start + maxLen);
  while (end < limit && buf[end] !== 0) end++;
  return buf.slice(start, end).toString('utf8');
}

// Scans a JSON object starting at `start` (buf[start] must be '{'), respecting
// quoted strings and escape sequences, and returns the index right after the
// matching top-level closing brace. This is only ever called at a position we
// already know is a real JSON start (the fixed +200-after-binary-struct rule
// above) -- it is never used to search for '{', because the binary struct that
// follows each JSON blob contains arbitrary bytes that can coincidentally equal
// 0x7b, which broke a naive indexOf('{') during investigation.
function scanJsonObject(buf, start) {
  if (buf[start] !== 0x7b) {
    throw new Error(`Expected '{' at offset ${start}, found byte 0x${buf[start].toString(16)}`);
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < buf.length; i++) {
    const b = buf[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (b === 0x5c) escaped = true; // backslash
      else if (b === 0x22) inString = false; // closing "
      continue;
    }
    if (b === 0x22) { inString = true; continue; }
    if (b === 0x7b) depth++;
    else if (b === 0x7d) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error(`Unterminated JSON object starting at offset ${start}`);
}

function parseDraftClassFile(buf) {
  if (buf.length < 0x22 || buf.slice(0, 8).toString('utf8') !== MAGIC) {
    throw new Error('Not a recognized draft-class file (missing FBCHUNKS magic)');
  }
  const header = {
    magic: MAGIC,
    version: buf.readUInt16LE(0x08),
    fieldA: buf.readUInt32LE(0x0A),
    fieldB: buf.readUInt32LE(0x0E),
    fieldC: buf.readUInt32LE(0x12),
    year: buf.readUInt16LE(0x16),
    month: buf.readUInt16LE(0x18),
    day: buf.readUInt16LE(0x1A),
    hour: buf.readUInt16LE(0x1C),
    minute: buf.readUInt16LE(0x1E),
    fieldD: buf.readUInt16LE(0x20), // unresolved, opaque -- NOT a schema-tag length (see note above)
  };
  const schemaBlockEnd = SCHEMA_BLOCK_START + SCHEMA_BLOCK_LEN;
  if (schemaBlockEnd > buf.length) {
    throw new Error('Schema block runs past end of file -- unrecognized header layout');
  }
  header.schemaTag = readCString(buf, SCHEMA_BLOCK_START, SCHEMA_BLOCK_LEN - 4);
  header.playerCount = buf.readUInt32LE(schemaBlockEnd - 4);
  header.raw = buf.slice(0, schemaBlockEnd);

  const players = [];
  let cursor = schemaBlockEnd;
  for (let i = 0; i < header.playerCount; i++) {
    const jsonStart = cursor;
    const jsonEnd = scanJsonObject(buf, jsonStart);
    const jsonRaw = buf.slice(jsonStart, jsonEnd);
    let visuals;
    try {
      visuals = JSON.parse(jsonRaw.toString('utf8'));
    } catch (e) {
      throw new Error(`Player ${i}: JSON blob at offset ${jsonStart} failed to parse: ${e.message}`);
    }

    let gapEnd = jsonEnd;
    while (gapEnd < buf.length && buf[gapEnd] === 0) gapEnd++;
    const gapRaw = buf.slice(jsonEnd, gapEnd);

    const binaryStart = gapEnd;
    const binaryEnd = binaryStart + BINARY_RECORD_LEN;
    if (binaryEnd > buf.length) {
      throw new Error(`Player ${i}: binary record at offset ${binaryStart} runs past end of file`);
    }
    const binaryRaw = buf.slice(binaryStart, binaryEnd);
    const firstName = readCString(binaryRaw, 0, BINARY_RECORD_LEN);
    // lastName follows the null padding after firstName; scan past it rather than
    // assuming a fixed field width -- real samples show the width tracks name length.
    let p = firstName.length;
    while (p < BINARY_RECORD_LEN && binaryRaw[p] === 0) p++;
    const lastName = readCString(binaryRaw, p, BINARY_RECORD_LEN - p);
    const assetTokenMatch = binaryRaw.toString('latin1').match(/[A-Za-z' ]+_\d+_\d+/);

    players.push({
      json: { raw: jsonRaw, visuals },
      gap: { raw: gapRaw },
      binary: {
        raw: binaryRaw,
        firstName,
        lastName,
        assetToken: assetTokenMatch ? assetTokenMatch[0] : null,
      },
    });

    cursor = binaryEnd;
  }

  const trailer = { raw: buf.slice(cursor) };

  return { header, players, trailer, totalLength: buf.length };
}

function serializeDraftClassFile(model) {
  const parts = [model.header.raw];
  for (const p of model.players) {
    parts.push(p.json.raw, p.gap.raw, p.binary.raw);
  }
  parts.push(model.trailer.raw);
  return Buffer.concat(parts);
}

// The 5a gate: parse a real exported file, re-serialize it, and assert the
// output is byte-for-byte identical to the input. If this fails, the format is
// not understood well enough to attempt edits -- stay on the roster-write path.
function verifyRoundTrip(originalBuf) {
  const model = parseDraftClassFile(originalBuf);
  const reemitted = serializeDraftClassFile(model);
  const identical = Buffer.compare(originalBuf, reemitted) === 0;
  return { identical, model, reemittedLength: reemitted.length, originalLength: originalBuf.length };
}

// --- Phase 5b: minimal, same-length edits -----------------------------------
// These exist to produce the single-edit test file for the real-Madden-import
// gate (5b). They deliberately do the LEAST invasive edit possible: change a
// JSON value without altering that player's JSON blob length by even one byte
// (so nothing downstream in the file shifts), and change a binary name field
// only within its existing null-padded allocation (also no shift). Nothing in
// this module attempts a full field-mapping or class-emit yet -- that's 5c/5d,
// gated on this step actually being accepted by Madden.

// bodyType's real enum members that happen to be the same byte length as each
// other (verified against every sample seen: "Standard", "Freshman", and
// "Muscular" are all exactly 8 characters) -- swapping among these changes the
// visible field without touching the JSON blob's byte length at all.
const SAME_LENGTH_BODY_TYPES = ['Standard', 'Freshman', 'Muscular'];

// Returns a new player record with `key` in its JSON visuals replaced by
// `newValue`, WITHOUT changing the JSON blob's byte length. Throws if the
// replacement would change the length (the caller asked for an edit that
// isn't safe under the "same-length" constraint this gate is testing).
function setJsonFieldSameLength(player, key, newValue) {
  const oldValueText = JSON.stringify(player.json.visuals[key]);
  const newValueText = JSON.stringify(newValue);
  if (oldValueText === undefined) {
    throw new Error(`Player has no existing "${key}" field to replace -- same-length edit needs an existing value`);
  }
  if (newValueText.length !== oldValueText.length) {
    throw new Error(
      `setJsonFieldSameLength: "${key}" old value ${oldValueText} (${oldValueText.length}b) and `
      + `new value ${newValueText} (${newValueText.length}b) are not the same byte length`
    );
  }
  const oldJsonText = player.json.raw.toString('utf8');
  const needle = `"${key}":${oldValueText}`;
  const idx = oldJsonText.indexOf(needle);
  if (idx === -1) {
    throw new Error(`Could not locate "${key}":${oldValueText} verbatim in this player's JSON blob`);
  }
  const replacement = `"${key}":${newValueText}`;
  const newJsonText = oldJsonText.slice(0, idx) + replacement + oldJsonText.slice(idx + needle.length);
  const newJsonRaw = Buffer.from(newJsonText, 'utf8');
  if (newJsonRaw.length !== player.json.raw.length) {
    throw new Error('Internal error: same-length replacement changed the JSON blob length');
  }
  return {
    ...player,
    json: { raw: newJsonRaw, visuals: { ...player.json.visuals, [key]: newValue } },
  };
}

// bodyType is the ONE field this exporter must write via JSON edit rather than a
// same-length binary byte (5d.0 in FACES_AND_DRAFT_ROADMAP.md). It is NOT a
// same-length edit like setJsonFieldSameLength (the 5 values have different
// string lengths), so this compensates by growing/shrinking this player's
// zero-byte GAP by the exact opposite amount, keeping [json+gap] total length
// (and therefore every later player's offset) unchanged.
//
// Ground-truthed via the import->read-roster loop: Madden reads body type from
// the LOADOUT item's itemAssetName ("<X>_BodyType" inside the CharacterBodyType
// slot), NOT from the top-level "bodyType" JSON key -- confirmed because 148/402
// template players have no top-level key at all yet still import with the
// correct CharacterBodyType, matching the loadout token in every case with zero
// exceptions. The loadout token uses one alias ("Freshman" is written as "Lean")
// that the top-level field does not use; every other value matches its own name.
// The top-level key (when present) is also kept in sync for internal
// consistency, though it does not appear to be what Madden actually reads.
const BODY_TYPES = ['Standard', 'Thin', 'Muscular', 'Heavy', 'Freshman'];
const BODY_TYPE_LOADOUT_ALIAS = { Freshman: 'Lean' };

function setBodyType(player, newBodyType) {
  if (!BODY_TYPES.includes(newBodyType)) {
    throw new Error(`setBodyType: unrecognized bodyType ${JSON.stringify(newBodyType)} (expected one of ${JSON.stringify(BODY_TYPES)})`);
  }
  let jsonText = player.json.raw.toString('utf8');

  const loadoutMatch = jsonText.match(/"(\w+)_BodyType"/);
  if (!loadoutMatch) {
    throw new Error("setBodyType: could not find a \"<X>_BodyType\" loadout token in this player's JSON blob");
  }
  const oldLoadoutToken = `"${loadoutMatch[1]}_BodyType"`;
  const newLoadoutToken = `"${BODY_TYPE_LOADOUT_ALIAS[newBodyType] || newBodyType}_BodyType"`;
  jsonText = jsonText.replace(oldLoadoutToken, newLoadoutToken);

  const oldTop = player.json.visuals.bodyType;
  if (oldTop !== undefined) {
    jsonText = jsonText.replace(`"bodyType":"${oldTop}"`, `"bodyType":"${newBodyType}"`);
  }

  const newJsonRaw = Buffer.from(jsonText, 'utf8');
  const delta = newJsonRaw.length - player.json.raw.length;
  const newGapLen = player.gap.raw.length - delta;
  if (newGapLen < 0) {
    throw new Error(
      `setBodyType: not enough padding slack in this player's slot to grow the JSON blob `
      + `by ${delta} bytes (only ${player.gap.raw.length} bytes of gap available)`
    );
  }
  return {
    ...player,
    json: { raw: newJsonRaw, visuals: { ...player.json.visuals, bodyType: newBodyType } },
    gap: { raw: Buffer.alloc(newGapLen, 0) },
  };
}

// Gap-compensated raw-JSON substring swap: replaces `oldSub` with `newSub` in a
// player's JSON blob and shrinks/grows that player's trailing zero-padding by the
// opposite delta, so [json+gap] total length (and every later player's offset)
// is unchanged -- the same technique setBodyType uses. `visualsPatch` is merged
// into the parsed visuals for callers that read them back.
function replaceJsonToken(player, oldSub, newSub, visualsPatch) {
  const text = player.json.raw.toString('utf8');
  const idx = text.indexOf(oldSub);
  if (idx === -1) throw new Error(`replaceJsonToken: could not find ${JSON.stringify(oldSub)} in player's JSON blob`);
  const newRaw = Buffer.from(text.slice(0, idx) + newSub + text.slice(idx + oldSub.length), 'utf8');
  const newGapLen = player.gap.raw.length - (newRaw.length - player.json.raw.length);
  if (newGapLen < 0) {
    throw new Error(`replaceJsonToken: not enough padding slack (need ${newRaw.length - player.json.raw.length} more bytes, have ${player.gap.raw.length})`);
  }
  return {
    ...player,
    json: { raw: newRaw, visuals: { ...player.json.visuals, ...(visualsPatch || {}) } },
    gap: { raw: Buffer.alloc(newGapLen, 0) },
  };
}

// The 3D head/skin asset. genericHeadName's leading digit is the rendered head &
// BODY skin tone (gen_<skin>_<facialHair>_<hairstyle>_<variant>) -- this is what
// actually colors the in-game model; the JSON `skinTone` field does NOT (it only
// labels the portrait). Set it to a head of the player's skin tone so the body
// matches the portrait. See FACES_AND_DRAFT_ROADMAP.md "appearance model".
function getGenericHead(player) { return player.json.visuals.genericHeadName; }
function setGenericHead(player, headName) {
  const cur = player.json.visuals.genericHeadName;
  if (cur === undefined) throw new Error('setGenericHead: player has no genericHeadName to replace');
  if (cur === headName) return player;
  return replaceJsonToken(player, `"genericHeadName":"${cur}"`, `"genericHeadName":"${headName}"`, { genericHeadName: headName });
}

// The portrait's skin label. A render-band portrait faceId carries an inherent
// skin; EA records it here. We keep it in sync with the chosen faceId and head so
// portrait, metadata, and body all agree on one skin tone.
function getSkinTone(player) { return player.json.visuals.skinTone; }
function setSkinTone(player, skinTone) {
  const cur = player.json.visuals.skinTone;
  if (cur === undefined) throw new Error('setSkinTone: player has no skinTone field to replace');
  if (cur === skinTone) return player;
  return replaceJsonToken(player, `"skinTone":${cur}`, `"skinTone":${skinTone}`, { skinTone });
}

// Character build -- the VISIBLE body frame in the 3D model, a single byte at
// offset 141 (right after the dev-trait byte). Distinct from setBodyType above,
// which writes the JSON loadout token driving the readable CharacterBodyType
// attribute: ground-truthed against EA's own draft files (100% consistent), the
// rendered model reads THIS byte, not the loadout token, so both must be set.
const CHARACTER_BUILD_OFFSET = 141;
const BODY_BUILD_INDEX = { Standard: 0, Thin: 1, Muscular: 2, Heavy: 3, Freshman: 4, Lean: 4 };
function getCharacterBuild(player) { return player.binary.raw[CHARACTER_BUILD_OFFSET]; }
function setCharacterBuild(player, bodyType) {
  const idx = BODY_BUILD_INDEX[bodyType];
  if (idx === undefined) throw new Error(`setCharacterBuild: unrecognized bodyType ${JSON.stringify(bodyType)} (expected one of ${JSON.stringify(Object.keys(BODY_BUILD_INDEX))})`);
  return setBinaryBytes(player, [{ offset: CHARACTER_BUILD_OFFSET, value: idx }]);
}

// Returns a new player record with the binary struct's firstName or lastName
// replaced by `newName`, reusing the SAME null-padded byte span the original
// name occupied (so nothing after it in the 200-byte struct shifts). Throws if
// `newName` is longer than the original name's allocated span.
function setBinaryName(player, field, newName) {
  if (field !== 'firstName' && field !== 'lastName') {
    throw new Error(`setBinaryName: field must be 'firstName' or 'lastName', got ${field}`);
  }
  const buf = Buffer.from(player.binary.raw); // clone -- never mutate the original model in place
  let start;
  if (field === 'firstName') {
    start = 0;
  } else {
    start = player.binary.firstName.length;
    while (start < buf.length && buf[start] === 0) start++;
  }
  const oldName = player.binary[field];
  let end = start + oldName.length;
  while (end < buf.length && buf[end] === 0) end++; // include the name's trailing null-padding run
  const availableLen = end - start;
  const newBytes = Buffer.from(newName, 'utf8');
  if (newBytes.length > availableLen) {
    throw new Error(
      `New ${field} "${newName}" (${newBytes.length}b) does not fit in the original `
      + `${availableLen}-byte allocation for this player`
    );
  }
  buf.fill(0, start, end);
  newBytes.copy(buf, start);
  const assetTokenMatch = buf.toString('latin1').match(/[A-Za-z' ]+_\d+_\d+/);
  return {
    ...player,
    binary: {
      ...player.binary,
      raw: buf,
      [field]: newName,
      assetToken: assetTokenMatch ? assetTokenMatch[0] : player.binary.assetToken,
    },
  };
}

// Returns a new player record with specific bytes of the 200-byte binary struct
// overwritten in place (clones first -- never mutates the caller's model). Each
// edit is { offset, value }; value is written as a single byte. Same-length by
// construction (fixed struct), so it stays in the 5b-validated edit path. Used
// to set the face/portrait-ID field at offset 146-147 (the byte-147 flag that
// gates whether a generic head renders vs. shows blank -- see Phase 5c in
// FACES_AND_DRAFT_ROADMAP.md).
function setBinaryBytes(player, edits) {
  const buf = Buffer.from(player.binary.raw);
  for (const { offset, value } of edits) {
    if (!Number.isInteger(offset) || offset < 0 || offset >= buf.length) {
      throw new Error(`setBinaryBytes: offset ${offset} out of range [0, ${buf.length})`);
    }
    buf[offset] = value & 0xff;
  }
  return { ...player, binary: { ...player.binary, raw: buf } };
}

// Reads/writes the 16-bit little-endian face/portrait ID at offset 146. Faced
// template players cluster around 3700-4100; faceless (blank) around 15800-15925.
const FACE_ID_OFFSET = 146;
function getFaceId(player) {
  const b = player.binary.raw;
  return b[FACE_ID_OFFSET] + b[FACE_ID_OFFSET + 1] * 256;
}
function setFaceId(player, faceId) {
  return setBinaryBytes(player, [
    { offset: FACE_ID_OFFSET, value: faceId & 0xff },
    { offset: FACE_ID_OFFSET + 1, value: (faceId >> 8) & 0xff },
  ]);
}

// Reads/writes the 16-bit little-endian college index at offset 66. This is
// Madden's own enumeration of colleges (Alabama=4, Clemson=39, Oklahoma=158,
// ...) -- a clean bijection with the College field confirmed against a real
// import->read-roster loop (399/399 template slots, 127 distinct colleges,
// zero collisions). Unlike the leftover asset token (which also affects
// college but is capacity-limited to one player per template slot), this
// field has no supply constraint: any number of players can share a college.
const COLLEGE_INDEX_OFFSET = 66;
function getCollegeIndex(player) {
  const b = player.binary.raw;
  return b[COLLEGE_INDEX_OFFSET] + b[COLLEGE_INDEX_OFFSET + 1] * 256;
}
function setCollegeIndex(player, collegeIndex) {
  return setBinaryBytes(player, [
    { offset: COLLEGE_INDEX_OFFSET, value: collegeIndex & 0xff },
    { offset: COLLEGE_INDEX_OFFSET + 1, value: (collegeIndex >> 8) & 0xff },
  ]);
}

// Position: a single byte at offset 74, holding Madden's real `PositionE` enum
// value. Found by cross-referencing 5 known positions (from real in-game
// scouting screenshots: OT/DT/QB/IOL/CB) against every offset in the struct --
// offset 74 was the only one that was both internally consistent per known
// position AND distinct across positions. Confirmed decisively by querying a
// real Madden franchise save's schema directly (via madden-franchise) for the
// authoritative PositionE member values, then checking the full 402-player
// template distribution against it: all 402 players landed on a real, sane
// position value (no leftovers, no invalid/manager-position values), with a
// realistic draft-class shape (WR most common at 52, specialists rarest at 3).
// CFB's own Position enum uses the IDENTICAL numeric values for every real
// position code (verified against a real CFB dynasty save's schema) -- so a CFB
// player's raw Position value writes into this byte with NO translation needed.
const POSITION_OFFSET = 74;
const POSITION_ENUM = {
  0: 'QB', 1: 'HB', 2: 'FB', 3: 'WR', 4: 'TE', 5: 'LT', 6: 'LG', 7: 'C', 8: 'RG', 9: 'RT',
  10: 'LE', 11: 'RE', 12: 'DT', 13: 'LOLB', 14: 'MLB', 15: 'ROLB', 16: 'CB', 17: 'FS', 18: 'SS',
  19: 'K', 20: 'P', 21: 'LS', 22: 'KR', 23: 'PR', 24: 'KOS', 25: '3DRB', 26: 'GAD', 27: 'PWHB',
  28: 'SLWR', 29: 'RLE', 30: 'RRE', 31: 'RDT', 32: 'NT', 33: 'SUBLB', 34: 'SLCB',
};
const POSITION_NAME_TO_VALUE = Object.fromEntries(Object.entries(POSITION_ENUM).map(([v, n]) => [n, Number(v)]));

function getPosition(player) {
  const v = player.binary.raw[POSITION_OFFSET];
  return POSITION_ENUM[v] ?? null;
}
// Accepts either a position name (e.g. 'WR') or a raw numeric enum value.
function setPosition(player, position) {
  const value = typeof position === 'number' ? position : POSITION_NAME_TO_VALUE[position];
  if (value === undefined || !(value in POSITION_ENUM)) {
    throw new Error(`setPosition: unrecognized position ${JSON.stringify(position)}`);
  }
  return setBinaryBytes(player, [{ offset: POSITION_OFFSET, value }]);
}

// Height (offset 71, raw inches, no encoding) and Weight (offset 72, encoded as
// raw byte + 160 -- the SAME "-160 offset" convention this app already decodes
// on CFB's own Weight field). Found via 3 real height/weight ground-truth pairs
// from in-game screenshots (Beau Johnson 297lb/6'5", Jericho Johnson 342lb/6'3",
// Malik Washington 231lb/6'4"): offset 71 matched height with zero transform;
// offset 72 matched weight-160 exactly for all three. Confirmed across the full
// 402-player population: 0 out-of-realistic-range values, and position-averaged
// height/weight look exactly like real football body types (offensive line ~310lb
// & 76-78in, cornerbacks ~187lb & 72in, quarterbacks ~210lb & 74in).
const HEIGHT_OFFSET = 71;
const WEIGHT_OFFSET = 72;
const WEIGHT_RAW_ADJUST = 160;

function getHeight(player) { return player.binary.raw[HEIGHT_OFFSET]; }
function setHeight(player, heightInches) {
  if (!Number.isInteger(heightInches) || heightInches < 0 || heightInches > 255) {
    throw new Error(`setHeight: ${heightInches} is not a valid raw byte value`);
  }
  return setBinaryBytes(player, [{ offset: HEIGHT_OFFSET, value: heightInches }]);
}
function getWeight(player) { return player.binary.raw[WEIGHT_OFFSET] + WEIGHT_RAW_ADJUST; }
function setWeight(player, weightLbs) {
  const raw = weightLbs - WEIGHT_RAW_ADJUST;
  if (!Number.isInteger(raw) || raw < 0 || raw > 255) {
    throw new Error(`setWeight: ${weightLbs} lbs is out of the encodable range (${WEIGHT_RAW_ADJUST}-${WEIGHT_RAW_ADJUST + 255} lbs)`);
  }
  return setBinaryBytes(player, [{ offset: WEIGHT_OFFSET, value: raw }]);
}

// --- Fields confirmed via the import -> read-roster loop -------------------
// (FACES_AND_DRAFT_ROADMAP.md "PHASE 5 RESTRUCTURE"): a probe class was imported
// into a real franchise, and each field below was matched by reading the imported
// rookies back through madden-franchise (ground truth, not inference). Age (70),
// Height (71), Weight (72), Position (74) above were confirmed the same way.

const AGE_OFFSET = 70;          // raw byte
const JERSEY_OFFSET = 76;       // raw byte (JerseyNum)
const ARCHETYPE_OFFSET = 75;    // PlayerType enum -- CFB and Madden share it 69/69, so a direct copy
const DEVTRAIT_OFFSET = 140;    // TraitDevelopment enum -- CFB and Madden share it, so a direct copy
const DRAFT_ROUND_OFFSET = 80;  // projected draft round (63 = undrafted); projection only
const DRAFT_PICK_OFFSET = 78;   // u16 LE, paired "Round R Pick P" projection

// TraitDevelopment enum, identical in CFB 27 and Madden 26 (verified by querying
// both schemas). CFB player's raw value copies straight over.
const TRAIT_DEVELOPMENT_ENUM = { 0: 'Normal', 1: 'College_Impact', 2: 'College_Star', 3: 'College_Elite', 4: 'Hidden' };

function getAge(player) { return player.binary.raw[AGE_OFFSET]; }
function setAge(player, age) {
  if (!Number.isInteger(age) || age < 0 || age > 255) throw new Error(`setAge: ${age} is not a valid raw byte value`);
  return setBinaryBytes(player, [{ offset: AGE_OFFSET, value: age }]);
}
function getJersey(player) { return player.binary.raw[JERSEY_OFFSET]; }
function setJersey(player, num) {
  if (!Number.isInteger(num) || num < 0 || num > 99) throw new Error(`setJersey: ${num} is out of range (0-99)`);
  return setBinaryBytes(player, [{ offset: JERSEY_OFFSET, value: num }]);
}
// Archetype (PlayerType). Extracted directly from Madden's own schema (byte-
// identical in CFB 27 -- verified 69/69 real archetypes match, see
// FACES_AND_DRAFT_ROADMAP.md Phase 5c-map). This table also carries the
// schema's internal range-marker sentinel names (e.g. "QB_First_"/"OLB_Last_"),
// which share a numeric value with a real archetype in the same position group
// -- harmless here since a real CFB player's decoded PlayerType always resolves
// to the real archetype name, never a sentinel (confirmed against real player
// reads), so those keys simply never get looked up.
const PLAYER_TYPE_NAME_TO_VALUE = {
  First_: 0, Offense_First_: 0, QB_FieldGeneral: 0, QB_First_: 0, QB_StrongArm: 1, QB_Improviser: 2,
  QB_Scrambler: 3, QB_Last_: 4, QB_PureScrambler: 4, HB_First_: 5, HB_PowerBack: 5, HB_ElusiveBack: 6,
  HB_ReceivingBack: 7, HB_PowerBlocking: 8, HB_PowerReceiving: 9, HB_ElusivePower: 10, HB_ElusiveReceiving: 11,
  HB_Last_: 11, FB_Blocking: 12, FB_First_: 12, FB_Last_: 13, FB_Utility: 13, WR_DeepThreat: 14,
  WR_First_: 14, WR_Playmaker: 15, WR_PhysicalRouteRunner: 16, WR_ShiftyRouteRunner: 17, WR_PhysicalBlocker: 18,
  WR_GadgetReceiver: 19, WR_Physical: 20, WR_Last_: 21, WR_Slot: 21, TE_Blocking: 22, TE_First_: 22,
  TE_VerticalThreat: 23, TE_PhysicalRouteRunner: 24, TE_PossessionBlocking: 25, TE_Last_: 26, TE_Possession: 26,
  C_First_: 27, C_PassProtector: 27, OL_First_: 27, C_Power: 28, C_WellRounded: 29, C_Agile: 30, C_Last_: 30,
  OT_First_: 31, OT_PassProtector: 31, OT_Power: 32, OT_WellRounded: 33, OT_Agile: 34, OT_Last_: 34,
  G_First_: 35, G_PassProtector: 35, G_WellRounded: 36, G_Power: 37, G_Agile: 38, G_Last_: 38,
  Offense_Last_: 38, OL_Last_: 38, DE_First_: 39, DE_SmallerSpeedRusher: 39, Defense_First_: 39, DL_First_: 39,
  DE_PowerRusher: 40, DE_PurePower: 41, DE_Last_: 42, DE_RunStopper: 42, DT_First_: 43, DT_NoseTackle: 43,
  DT_PurePower: 44, DT_SpeedRusher: 45, DL_Last_: 46, DT_Last_: 46, DT_PowerRusher: 46, LB_First_: 47,
  OLB_First_: 47, OLB_SpeedRusher: 47, OLB_PowerRusher: 48, OLB_PassCoverage: 49, OLB_Last_: 50,
  OLB_RunStopper: 50, MLB_FieldGeneral: 51, MLB_First_: 51, MLB_PassCoverage: 52, LB_Last_: 53, MLB_Last_: 53,
  MLB_RunStopper: 53, CB_First_: 54, CB_MantoMan: 54, DB_First_: 54, CB_Slot: 55, CB_Zone: 56,
  CB_HybridCorner: 57, CB_Last_: 57, S_First_: 58, S_Zone: 58, S_Hybrid: 59, DB_Last_: 60, Defense_Last_: 60,
  S_Last_: 60, S_RunSupport: 60, KP_Accurate: 61, KP_First_: 61, KP_Last_: 62, KP_Power: 62,
  Count_No_Returners: 63, KR_Balanced: 63, Returner_First_: 63, PR_Balanced: 64, Returner_Last_: 64,
  LS_First_: 65, LS_Power: 65, LS_Accurate: 66, LS_Last_: 66, GAD_Gadget: 67, Last_: 67, Count_: 68,
  Locked: 68, Invalid_: 80,
};
const PLAYER_TYPE_VALUE_TO_NAME = (() => {
  // Prefer a "real" (non-sentinel) archetype name for display when a value has
  // more than one name -- purely cosmetic, does not affect name->value lookups.
  const isSentinel = (n) => /_First_$|_Last_$|^First_$|^Last_$|^Count_|^Invalid_$|^Offense_|^Defense_/.test(n);
  const out = {};
  for (const [name, value] of Object.entries(PLAYER_TYPE_NAME_TO_VALUE)) {
    if (out[value] === undefined || isSentinel(out[value])) out[value] = name;
  }
  return out;
})();

// Archetype (PlayerType). The exporter copies the CFB player's raw PlayerType
// value directly (shared enum -- no translation).
function getArchetype(player) {
  const v = player.binary.raw[ARCHETYPE_OFFSET];
  return { value: v, name: PLAYER_TYPE_VALUE_TO_NAME[v] ?? null };
}
// Accepts a raw numeric PlayerType value OR its name (e.g. 'WR_DeepThreat').
function setArchetype(player, playerType) {
  const value = typeof playerType === 'string' ? PLAYER_TYPE_NAME_TO_VALUE[playerType] : playerType;
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`setArchetype: unrecognized PlayerType ${JSON.stringify(playerType)}`);
  }
  return setBinaryBytes(player, [{ offset: ARCHETYPE_OFFSET, value }]);
}
// Draft round/pick: Madden's own scouting-board projection display ("Round R,
// Pick P"). Round is a raw byte at offset 80 (1-7; 63 observed as the
// undrafted/beyond-round-7 sentinel). Pick is a u16 LE at offset 78. Both are
// purely descriptive projection text -- setting them does not affect where the
// player lands if the user actually runs a draft, only what the pre-draft board
// displays.
const UNDRAFTED_ROUND = 63;
function getDraftRound(player) { return player.binary.raw[DRAFT_ROUND_OFFSET]; }
function setDraftRound(player, round) {
  const value = round == null ? UNDRAFTED_ROUND : round;
  if (!Number.isInteger(value) || (value < 1 || value > 7) && value !== UNDRAFTED_ROUND) {
    throw new Error(`setDraftRound: ${round} must be an integer 1-7, or null/undefined for undrafted`);
  }
  return setBinaryBytes(player, [{ offset: DRAFT_ROUND_OFFSET, value }]);
}
function getDraftPick(player) {
  const b = player.binary.raw;
  return b[DRAFT_PICK_OFFSET] + b[DRAFT_PICK_OFFSET + 1] * 256;
}
function setDraftPick(player, pick) {
  if (!Number.isInteger(pick) || pick < 0 || pick > 0xffff) {
    throw new Error(`setDraftPick: ${pick} must be an integer 0-65535`);
  }
  return setBinaryBytes(player, [
    { offset: DRAFT_PICK_OFFSET, value: pick & 0xff },
    { offset: DRAFT_PICK_OFFSET + 1, value: (pick >> 8) & 0xff },
  ]);
}

function getDevTrait(player) {
  const v = player.binary.raw[DEVTRAIT_OFFSET];
  return { value: v, name: TRAIT_DEVELOPMENT_ENUM[v] ?? null };
}
// Accepts a raw enum value (0-4) or a name ('Normal'/'College_Impact'/...).
function setDevTrait(player, trait) {
  let value = trait;
  if (typeof trait === 'string') {
    value = Number(Object.entries(TRAIT_DEVELOPMENT_ENUM).find(([, n]) => n === trait)?.[0]);
  }
  if (!Number.isInteger(value) || !(value in TRAIT_DEVELOPMENT_ENUM)) {
    throw new Error(`setDevTrait: unrecognized trait ${JSON.stringify(trait)}`);
  }
  return setBinaryBytes(player, [{ offset: DEVTRAIT_OFFSET, value }]);
}

// Ratings block: one raw byte per rating, offsets 82-138. Every entry was
// confirmed by the sentinel probe (each offset's value showed up in exactly this
// Madden field on the imported rookie) AND cross-validated on ~200 real imported
// players at 199/200 exact. Keyed by the Madden franchise field name. 55 ratings
// (82-138); offsets 103 and 121 are intentionally absent (they did not map to a
// settable rating and are left at the template's value). Writing a rating leaves Madden to recompute
// OverallRating from the set (confirmed: Overall was recomputed on import).
const RATING_OFFSETS = {
  AccelerationRating: 82, AgilityRating: 83, AwarenessRating: 84, BCVisionRating: 85,
  BlockSheddingRating: 86, BreakSackRating: 87, BreakTackleRating: 88, CarryingRating: 89,
  CatchingRating: 90, CatchInTrafficRating: 91, ChangeOfDirectionRating: 92, FinesseMovesRating: 93,
  HitPowerRating: 94, ImpactBlockingRating: 95, InjuryRating: 96, JukeMoveRating: 97,
  JumpingRating: 98, KickAccuracyRating: 99, KickPowerRating: 100, KickReturnRating: 101,
  LeadBlockRating: 102, ManCoverageRating: 104, PassBlockFinesseRating: 105, PassBlockPowerRating: 106,
  PassBlockRating: 107, PersonalityRating: 108, PlayActionRating: 109, PlayRecognitionRating: 110,
  PowerMovesRating: 111, PressRating: 112, PursuitRating: 113, ReleaseRating: 114,
  DeepRouteRunningRating: 115, MediumRouteRunningRating: 116, ShortRouteRunningRating: 117,
  RunBlockFinesseRating: 118, RunBlockPowerRating: 119, RunBlockRating: 120, SpectacularCatchRating: 122,
  SpeedRating: 123, SpinMoveRating: 124, StaminaRating: 125, StiffArmRating: 126,
  StrengthRating: 127, TackleRating: 128, ThrowAccuracyDeepRating: 129, ThrowAccuracyMidRating: 130,
  ThrowAccuracyRating: 131, ThrowAccuracyShortRating: 132, ThrowOnTheRunRating: 133, ThrowPowerRating: 134,
  ThrowUnderPressureRating: 135, ToughnessRating: 136, TruckingRating: 137, ZoneCoverageRating: 138,
};

function getRatings(player) {
  const out = {};
  for (const [name, off] of Object.entries(RATING_OFFSETS)) out[name] = player.binary.raw[off];
  return out;
}
// Writes a subset of ratings. `ratings` is a map of Madden field name -> 0..99
// value; unknown keys are ignored, out-of-range values throw. Ratings not given
// keep the template's value.
function setRatings(player, ratings) {
  const edits = [];
  for (const [name, value] of Object.entries(ratings)) {
    const off = RATING_OFFSETS[name];
    if (off === undefined) continue;
    if (!Number.isInteger(value) || value < 0 || value > 99) {
      throw new Error(`setRatings: ${name}=${value} is out of range (0-99)`);
    }
    edits.push({ offset: off, value });
  }
  return setBinaryBytes(player, edits);
}

// Builds the 5b test file: on a cloned model, changes ONE player's bodyType to
// a same-byte-length alternative and that same player's lastName to a marker
// string (padded within its existing allocation), and returns the full
// re-serialized buffer, ready to save as a file for a real Madden import test.
// This never touches the input buffer or the caller's model.
function make5bTestEdit(model, playerIndex, { lastNameMarker = 'PHASE5BTEST' } = {}) {
  const player = model.players[playerIndex];
  if (!player) throw new Error(`No player at index ${playerIndex}`);
  const currentBodyType = player.json.visuals.bodyType;
  const nextBodyType = SAME_LENGTH_BODY_TYPES.find((v) => v !== currentBodyType && v.length === (currentBodyType || '').length);
  if (!nextBodyType) {
    throw new Error(
      `Player ${playerIndex} has bodyType "${currentBodyType}", which isn't the same length as any of `
      + `${JSON.stringify(SAME_LENGTH_BODY_TYPES)} -- pick a different player whose bodyType is `
      + `Standard, Freshman, or Muscular (all 8 characters, so they're safely interchangeable).`
    );
  }
  let edited = setJsonFieldSameLength(player, 'bodyType', nextBodyType);
  edited = setBinaryName(edited, 'lastName', lastNameMarker);

  const players = model.players.slice();
  players[playerIndex] = edited;
  const editedModel = { ...model, players };
  return {
    buffer: serializeDraftClassFile(editedModel),
    model: editedModel,
    change: { playerIndex, bodyType: { from: currentBodyType, to: nextBodyType }, lastName: { from: player.binary.lastName, to: lastNameMarker } },
  };
}

module.exports = {
  MAGIC,
  BINARY_RECORD_LEN,
  SAME_LENGTH_BODY_TYPES,
  FACE_ID_OFFSET,
  COLLEGE_INDEX_OFFSET,
  getCollegeIndex,
  setCollegeIndex,
  getGenericHead,
  setGenericHead,
  getSkinTone,
  setSkinTone,
  CHARACTER_BUILD_OFFSET,
  BODY_BUILD_INDEX,
  getCharacterBuild,
  setCharacterBuild,
  POSITION_OFFSET,
  POSITION_ENUM,
  POSITION_NAME_TO_VALUE,
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
  HEIGHT_OFFSET,
  WEIGHT_OFFSET,
  WEIGHT_RAW_ADJUST,
  getHeight,
  setHeight,
  getWeight,
  setWeight,
  AGE_OFFSET,
  JERSEY_OFFSET,
  ARCHETYPE_OFFSET,
  PLAYER_TYPE_NAME_TO_VALUE,
  PLAYER_TYPE_VALUE_TO_NAME,
  DEVTRAIT_OFFSET,
  DRAFT_ROUND_OFFSET,
  DRAFT_PICK_OFFSET,
  UNDRAFTED_ROUND,
  TRAIT_DEVELOPMENT_ENUM,
  RATING_OFFSETS,
  BODY_TYPES,
  BODY_TYPE_LOADOUT_ALIAS,
  getAge,
  setAge,
  getJersey,
  setJersey,
  getArchetype,
  setArchetype,
  getDevTrait,
  setDevTrait,
  getDraftRound,
  setDraftRound,
  getDraftPick,
  setDraftPick,
  getRatings,
  setRatings,
  setBodyType,
  make5bTestEdit,
};
