// Coach appearance -- gives a transferred coach a real head and portrait
// instead of the silhouette a blank destination row renders as.
//
// Why this can't be copied from CFB (FINDINGS.md section 5, re-confirmed):
// a CFB coach's CharacterVisuals blob contains NO head loadout at all -- only
// apparel -- and the two games' head-asset vocabularies have zero overlap
// (CFB "Generic_0103_C_T0102_H_2_3" / "Unique_C_AltmanGarrett_900" vs Madden
// "coachhead_M_0013_HS"). So the head is SYNTHESIZED from Madden's own
// catalog, exactly the posture lib/appearanceCatalog.js already takes for
// players.
//
// Three things must agree, verified against all 127 coaches in the sample save:
//   1. Coach.GenericHeadAssetName  -- e.g. "coachhead_M_0013_HS"
//   2. The CharacterVisuals JSON's Head loadout PlusHead item -- identical to
//      (1) in 93/93 coaches that have both. They are written as a pair.
//   3. Coach.Portrait -- DETERMINISTIC: portrait = headNumber + 308, with
//      93/93 agreement and zero exceptions (13->321, 55->363, 116->424).
//
// The catalog is read from whichever save is open rather than hardcoded, so
// a title update that adds heads is picked up automatically.

const fs = require('fs');
const path = require('path');
const { safe, biggestTableByName } = require('../saveIO');
const { makeSeededRng } = require('../rosetta/rng');
const { deriveSeedString } = require('../rosetta/identity');

const HEAD_PATTERN = /^coachhead_M_(\d+)_HS$/;
const PORTRAIT_OFFSET = 308; // verified: portrait - headNumber == 308 for all 93 coaches with a parseable head
const TONE_MAP_PATH = path.join(__dirname, '..', '..', 'data', 'coachHeadTones.json');
const CFB_TONE_PATH = path.join(__dirname, '..', '..', 'data', 'cfbCoachTones.json');

function headNumber(headAssetName) {
  const m = String(headAssetName).match(HEAD_PATTERN);
  return m ? Number(m[1]) : null;
}

function portraitForHead(headAssetName) {
  const n = headNumber(headAssetName);
  return n === null ? null : n + PORTRAIT_OFFSET;
}

// head number -> tone (1-8), measured from the shipped portrait art; see
// data/coachHeadTones.json's own _comment for the derivation. Covers the full
// generic catalog (assets 1-200). Missing/partial is fine -- unmapped heads are
// simply never auto-selected by tone.
let toneMapCache = null;
let confirmedCache = null;
function loadToneMap() {
  if (toneMapCache) return toneMapCache;
  const byHeadNumber = new Map();
  const confirmed = new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(TONE_MAP_PATH, 'utf8'));
    for (const [tone, heads] of Object.entries(raw.tones || {})) {
      for (const n of heads) byHeadNumber.set(Number(n), Number(tone));
    }
    for (const n of (raw.confirmedInSave || [])) confirmed.add(Number(n));
  } catch (e) { /* absent or malformed -- tone matching is simply unavailable */ }
  toneMapCache = byHeadNumber;
  confirmedCache = confirmed;
  return byHeadNumber;
}

// Heads proven to exist because a live coach was seen wearing one. The rest of
// the catalog is inferred from the portrait art (same numbering, complete and
// gapless across 1-200), but has not been observed on a coach.
function confirmedHeads() { loadToneMap(); return confirmedCache; }

// NB: named headAssetFor, not headAssetName -- grantAppearance takes a
// `headAssetName` option and would shadow it.
function headAssetFor(n) { return `coachhead_M_${String(n).padStart(4, '0')}_HS`; }

// Where the user's OWN tone choices live. Must be outside the app bundle: in a
// packaged build data/cfbCoachTones.json is inside app.asar, which is a
// read-only archive -- writing to a path in there fails with ENOENT, which is
// exactly what the Tone Overrides UI hit. main.js points this at
// app.getPath('userData') once Electron is ready. Left null under plain node
// (tests, probes), where the shipped file alone is the whole picture.
let userTonePath = null;
function setCfbToneOverridePath(p) { userTonePath = p || null; clearCfbToneCache(); }

function readUserTones() {
  if (!userTonePath) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(userTonePath, 'utf8'));
    return raw && typeof raw.overrides === 'object' && raw.overrides ? raw.overrides : {};
  } catch (e) { return {}; } // absent until the user sets their first tone
}

// Hand-supplied tones for CFB heads that encode none, plus the fallback
// distribution. See data/cfbCoachTones.json for what was ruled out and why.
// The shipped file is the read-only base; the user's file is layered on top and
// wins, so a user choice always beats a shipped one for the same head.
let cfbToneCache = null;
function loadCfbTones() {
  if (cfbToneCache) return cfbToneCache;
  let overrides = new Map();
  let distribution = null;
  try {
    const raw = JSON.parse(fs.readFileSync(CFB_TONE_PATH, 'utf8'));
    overrides = new Map(Object.entries(raw.overrides || {}).map(([k, v]) => [k, Number(v)]));
    if (raw.fallbackDistribution) {
      distribution = Object.entries(raw.fallbackDistribution)
        .map(([tone, weight]) => ({ tone: Number(tone), weight: Number(weight) }))
        .filter((x) => x.weight > 0);
    }
  } catch (e) { /* absent is fine -- overrides are optional */ }
  for (const [k, v] of Object.entries(readUserTones())) overrides.set(k, Number(v));
  cfbToneCache = { overrides, distribution };
  return cfbToneCache;
}

// Sets or clears ONE head's tone in the user's own file, leaving every other
// entry alone, then drops the in-memory cache so the very next coach-propose
// call in this same long-running process picks the change up.
function setCoachToneOverride(headAssetName, tone) {
  if (!userTonePath) throw new Error('setCoachToneOverride: no writable tone path configured.');
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(userTonePath, 'utf8')) || {}; } catch (e) { raw = {}; }
  raw.overrides = (raw.overrides && typeof raw.overrides === 'object') ? raw.overrides : {};
  raw._comment = 'Your own CFB coach skin-tone choices. Head asset name -> tone 1-8. '
    + 'Layered on top of the app\'s bundled data/cfbCoachTones.json, and wins over it. '
    + 'Safe to delete: every coach here just goes back to being guessed.';
  if (tone === null || tone === undefined) delete raw.overrides[headAssetName];
  else raw.overrides[headAssetName] = Number(tone);
  fs.mkdirSync(path.dirname(userTonePath), { recursive: true });
  fs.writeFileSync(userTonePath, JSON.stringify(raw, null, 2));
  clearCfbToneCache();
  return raw.overrides;
}

// Drops the in-memory cache so the NEXT loadCfbTones() re-reads from disk
// instead of serving a stale copy.
function clearCfbToneCache() { cfbToneCache = null; }

// CFB encodes tone in the head name: Generic_<idx>_C_T<tex>_<hair>_<TONE>_<v>.
// Verified exact on all 493 head names in the sample dynasty -- 263 parsed,
// zero false positives on Unique_* names, zero Generic_* missed.
//
// Unique_* heads (authored likenesses of real people, ~47% of the CFB pool)
// encode no tone anywhere, so they resolve only via the override file.
function cfbSkinTone(cfbHeadAssetName) {
  if (typeof cfbHeadAssetName !== 'string') return null;
  const override = loadCfbTones().overrides.get(cfbHeadAssetName);
  if (typeof override === 'number') return override;
  const m = cfbHeadAssetName.match(/_[A-Z]+_(\d)_\d+$/);
  return m ? Number(m[1]) : null;
}

// When tone is genuinely unknown, sampling uniformly over Madden's head art
// would inherit that art's distribution, which is not how CFB populates its
// coaching pool. Sampling the CFB distribution instead keeps a batch of
// transfers statistically sane even though each individual is a guess.
function sampleFallbackTone(rng) {
  const { distribution } = loadCfbTones();
  if (!distribution || !distribution.length) return null;
  const total = distribution.reduce((a, x) => a + x.weight, 0);
  let r = rng() * total;
  for (const x of distribution) { r -= x.weight; if (r <= 0) return x.tone; }
  return distribution[distribution.length - 1].tone;
}

// Reads the head/portrait/visuals catalog out of the live destination save.
// Only heads matching the generic coachhead_M_####_HS pattern are offered --
// the other 11 observed values are licensed likenesses (ReidAndy, TomlinMike,
// CarrollPete, ...) or the MustBeUnique sentinel, none of which should ever
// be assigned to a transferred coach.
async function buildAppearanceCatalog(maddenFile) {
  const coachT = biggestTableByName(maddenFile, 'Coach');
  await coachT.readRecords();

  const byHead = new Map(); // headAssetName -> { head, portrait, visualsRow, usedBy }
  let visualsTableId = null;
  for (const r of coachT.records) {
    if (r.isEmpty) continue;
    const head = safe(r, 'GenericHeadAssetName');
    if (!head || !HEAD_PATTERN.test(head)) continue;
    let ref; try { ref = r.getReferenceDataByKey('CharacterVisuals'); } catch (e) { ref = null; }
    if (!ref || (!ref.tableId && !ref.rowNumber)) continue;
    visualsTableId = ref.tableId;
    if (!byHead.has(head)) {
      byHead.set(head, { head, portrait: safe(r, 'Portrait'), visualsRow: ref.rowNumber, usedBy: 0 });
    }
    byHead.get(head).usedBy++;
  }
  return { entries: [...byHead.values()], visualsTableId };
}

// The save only reveals the heads currently worn by someone -- 83 of them in
// the sample save. The real catalog is assets 1-200 (portrait art is complete
// and gapless across that range), so restricting selection to what's in use
// throws away well over half the faces, and skews tone supply badly: tone 8 has
// 5 in-use heads but 15 in the catalog.
//
// So the pool is the catalog, annotated with in-save usage. Catalog-only heads
// have no CharacterVisuals row of their own and borrow a donor's blob for
// apparel -- which is what grantAppearance already did for unused heads.
function poolWithCatalog(catalogEntries) {
  const byHead = new Map(catalogEntries.map((e) => [e.head, e]));
  const out = [...catalogEntries];
  for (const n of loadToneMap().keys()) {
    const head = headAssetFor(n);
    if (byHead.has(head)) continue;
    out.push({ head, portrait: portraitForHead(head), visualsRow: null, usedBy: 0 });
  }
  return out;
}

// Reads a donor's visuals JSON so the new blob keeps the same apparel shape
// the destination game actually ships (shoes/polo/pants/hat/headset), rather
// than inventing item names.
//
// `reason` exists because this function returning a bare null cost three
// rounds of misdiagnosis on a real bug. RawData is a ZSTD-COMPRESSED
// table3 blob, so reading it calls zlib.zstdDecompressSync -- which only
// exists in Node 22.15+. Under the app's old Electron (Node 20.18) that
// call threw, `safe()` swallowed the throw, and every row silently read as
// "unreadable". The save was perfectly fine; the runtime was not. Anything
// that goes wrong here is now reported instead of being flattened into a
// null, so the next such failure names itself immediately.
async function readVisualsJson(maddenFile, visualsTableId, rowNumber) {
  const vt = maddenFile.getTableById(visualsTableId);
  if (!vt) return { json: null, reason: `no table ${visualsTableId} in this save` };
  await vt.readRecords();
  const rec = vt.records[rowNumber];
  if (!rec) return { json: null, reason: `row ${rowNumber} is out of range` };
  if (rec.isEmpty) return { json: null, reason: `row ${rowNumber} is empty` };

  let raw;
  try {
    raw = rec.getValueByKey('RawData');
  } catch (e) {
    // The decompress path itself failed -- a runtime/environment problem,
    // not a data problem. Surface it verbatim.
    return { json: null, reason: `reading RawData threw: ${e.message}` };
  }
  if (typeof raw !== 'string') return { json: null, reason: `RawData is ${typeof raw}, not a string` };
  try { return { json: JSON.parse(raw), reason: null }; } catch (e) {
    return { json: null, reason: `RawData is not valid JSON (${raw.length} chars)` };
  }
}

// Finds the first donor row whose blob actually READS, trying candidates in
// preference order.
//
// Why this is not just `entries[0]`: a catalog-only head has no
// CharacterVisuals row of its own and has to borrow one purely for its
// apparel shape. The original code borrowed `catalog.entries[0]`
// unconditionally and assumed it would always parse. It does in the sample
// save -- but `entries[0].visualsRow` is literally row 0 there, and row 0 is
// not guaranteed readable in every save. A user's save hit exactly that:
// "could not read a donor CharacterVisuals blob (row 0)". Because that one
// row is the fallback for EVERY catalog-only head (~117 of the 200), a
// single unreadable row broke every appearance grant in that save, for
// every coach.
//
// Any readable COACH donor is equally valid -- the borrowed blob contributes
// only apparel (shoes/polo/pants/hat/headset); withHead() swaps the head and
// the caller overwrites skinTone -- so falling through to the next candidate
// costs nothing and cannot pick a "wrong" face.
//
// The candidate list is deliberately restricted to rows a real COACH points
// at, and must stay that way: CharacterVisuals is SHARED with players, and
// players outnumber coaches ~24:1 in it (verified: 3052 player-referenced
// rows vs 126 coach-referenced, of 3248 filled). Scanning the table at large
// for "any readable blob" would almost always land on a player's uniform/pads
// loadout and dress a head coach as an athlete.
async function findUsableVisualsDonor(maddenFile, visualsTableId, candidateRows) {
  const tried = [];
  const reasons = [];
  for (const row of candidateRows) {
    if (row === null || row === undefined || tried.includes(row)) continue;
    tried.push(row);
    const res = await readVisualsJson(maddenFile, visualsTableId, row);
    if (res.json) return { json: res.json, row, tried, reasons };
    if (!reasons.includes(res.reason)) reasons.push(res.reason);
  }
  return { json: null, row: null, tried, reasons };
}

// Replaces the Head loadout's item in a visuals blob, leaving apparel intact.
function withHead(visualsJson, headAssetName) {
  const blob = JSON.parse(JSON.stringify(visualsJson));
  let replaced = false;
  for (const lo of (blob.loadouts || [])) {
    if (lo.loadoutType === 'Head' || lo.loadoutCategory === 'Head') {
      for (const el of (lo.loadoutElements || [])) {
        if (/head/i.test(el.slotType)) { el.itemAssetName = headAssetName; replaced = true; }
      }
    }
  }
  if (!replaced) {
    blob.loadouts = blob.loadouts || [];
    blob.loadouts.push({
      loadoutType: 'Head', loadoutCategory: 'Head',
      loadoutElements: [{ slotType: 'PlusHead', itemAssetName: headAssetName }],
    });
  }
  return blob;
}

// Gives `destCoach` a head, a matching portrait, and a private
// CharacterVisuals row. Deterministic given `seed` + the source coach's row,
// so re-running a carousel produces the same faces -- same determinism
// contract the rest of the engine uses.
// Skin tone IS the face -- Madden bakes complexion into each head asset, so
// changing tone means choosing a different head. Selection precedence:
//   1. headAssetName      -- an explicit caller choice always wins
//   2. targetTone         -- pick a head whose mapped tone matches (data/coachHeadTones.json)
//   3. CFB-distribution   -- tone unknown: sample a plausible tone, then match
//   4. seeded random      -- last resort if even the distribution is unavailable
//
// GENDER is deliberately NOT matched. Madden 26 ships no usable female coach
// head catalog -- every in-save coach head is coachhead_M_####_HS, and the old
// tone-banded female names (2_F_WHI_D_001 ...) are the disproven namespace with
// out-of-range portraits. Product decision (user, 2026-07-24): a female coach
// gets a tone-matched head from the catalog we have rather than a broken or
// silhouette face. Tone reading is already gender-agnostic (cfbSkinTone reads
// the tone digit regardless of the ethnicity/gender letters), so a female coach
// flows through paths 2-3 and lands on the correct skin tone automatically.
async function grantAppearance(maddenFile, destCoach, {
  seed = '', sourceRow = 0, preferUnusedHeads = true, headAssetName = null, targetTone = null,
} = {}) {
  const catalog = await buildAppearanceCatalog(maddenFile);
  if (!catalog.entries.length) throw new Error('grantAppearance: no usable coach head assets found in this save.');

  const universe = poolWithCatalog(catalog.entries);

  // Prefer heads no current coach is using, so a transferred coach doesn't
  // visually duplicate someone already in the league. With the full catalog
  // there are normally ~117 genuinely unworn heads to draw from.
  const unused = universe.filter((e) => e.usedBy === 0);
  const pool = preferUnusedHeads && unused.length ? unused : universe;

  const rng = makeSeededRng(deriveSeedString(seed, 'carousel:appearance', sourceRow));
  let chosen;
  let selection = 'seeded';
  // True when the tone was invented rather than read from the coach -- the
  // caller needs to be able to tell "matched" from "plausible guess".
  let toneWasGuessed = false;

  if (headAssetName) {
    if (!HEAD_PATTERN.test(headAssetName)) {
      throw new Error(`grantAppearance: "${headAssetName}" is not a generic coach head. `
        + 'Expected the coachhead_M_<N>_HS form (the in-game Generic Heads browser calls these "Head <N>").');
    }
    chosen = universe.find((e) => e.head === headAssetName)
      // Outside the known catalog entirely -- still allow it, since the caller
      // asked by name and the +308 portrait rule holds across the range.
      || { head: headAssetName, portrait: portraitForHead(headAssetName), visualsRow: null, usedBy: 0 };
    selection = 'explicit';
  } else if (!targetTone) {
    // No tone known for this coach -- sample one from how CFB actually
    // distributes tones, rather than falling through to a uniform draw over
    // Madden's head art. Still fully seeded, so reruns reproduce.
    targetTone = sampleFallbackTone(rng);
    toneWasGuessed = true;
  }

  if (!chosen && targetTone) {
    const toneMap = loadToneMap();
    // Nearest tone rather than exact -- a partially-filled map should still
    // produce the closest available match instead of silently giving up.
    const scored = pool
      .map((e) => ({ e, tone: toneMap.get(headNumber(e.head)) }))
      .filter((x) => typeof x.tone === 'number')
      .sort((a, b) => Math.abs(a.tone - targetTone) - Math.abs(b.tone - targetTone));
    if (scored.length) {
      const best = Math.abs(scored[0].tone - targetTone);
      const tied = scored.filter((x) => Math.abs(x.tone - targetTone) === best);
      chosen = tied[Math.floor(rng() * tied.length) % tied.length].e;
      const how = best === 0 ? 'exact' : `nearest available: ${scored[0].tone}`;
      selection = toneWasGuessed
        ? `tone ${targetTone} (GUESSED from CFB distribution, ${how})`
        : `tone ${targetTone} (${how})`;
    }
  }

  if (!chosen) chosen = pool[Math.floor(rng() * pool.length) % pool.length];

  // Catalog-only heads have no visuals row of their own, so borrow any in-save
  // coach's blob purely for its apparel shape (shoes/polo/pants/hat/headset)
  // and swap the head in -- never invent item names.
  //
  // Preference order: the chosen head's OWN row if it has one, then every
  // other catalog entry as a fallback. See findUsableVisualsDonor's header
  // for why a single hardcoded fallback row was not safe.
  const donor = await findUsableVisualsDonor(maddenFile, catalog.visualsTableId, [
    chosen.visualsRow,
    ...catalog.entries.map((e) => e.visualsRow),
  ]);
  if (!donor.json) {
    // Lead with WHY, not just how many rows failed -- an identical reason
    // repeated across every row (e.g. a zstd decompress that cannot run on
    // this runtime) points at the environment, whereas differing reasons
    // point at the data. That distinction is the whole diagnosis.
    throw new Error('grantAppearance: could not read any usable donor CharacterVisuals blob '
      + `(tried ${donor.tried.length} row(s) in table ${catalog.visualsTableId}). `
      + `Reason${donor.reasons.length > 1 ? 's' : ''}: ${donor.reasons.join(' | ')}`);
  }
  const donorRow = donor.row;
  const blob = withHead(donor.json, chosen.head);

  // Mirror what the game itself does: when it creates a coach it writes a
  // `skinTone` descriptor alongside the head (verified -- a user-created dark
  // coach came out as coachhead_M_0033_HS + skinTone:7). It does NOT drive the
  // render (the head's complexion is baked in), but writing the matching value
  // keeps the blob internally consistent with the game's own convention.
  const chosenTone = loadToneMap().get(headNumber(chosen.head));
  if (typeof chosenTone === 'number') blob.skinTone = chosenTone;

  // A PRIVATE visuals row -- sharing one between two coaches would couple
  // their appearance, the same reason talent trees are cloned rather than
  // shared.
  const vt = maddenFile.getTableById(catalog.visualsTableId);
  await vt.readRecords();
  const free = vt.records.find((r) => r.isEmpty);
  if (!free) throw new Error(`grantAppearance: no free rows in CharacterVisuals (capacity ${vt.header.recordCapacity}).`);
  free.RawData = JSON.stringify(blob);

  const portrait = portraitForHead(chosen.head);
  destCoach.GenericHeadAssetName = chosen.head;
  if (portrait !== null) destCoach.Portrait = portrait;
  destCoach.CharacterVisuals = vt.getBinaryReferenceToRecord(free.index);

  return {
    head: chosen.head, portrait, visualsRow: free.index,
    inSaveHeads: catalog.entries.length, catalogSize: universe.length, poolSize: pool.length,
    donorVisualsRow: donorRow,
    // false = the asset name comes from the portrait catalog rather than a live
    // coach. Same numbering, complete across 1-200, but unobserved in a save.
    headConfirmedInSave: confirmedHeads().has(headNumber(chosen.head)),
    selection, // 'explicit' | 'tone N (exact|nearest|GUESSED ...)' | 'seeded'
    // true = we had no tone for this coach and invented a plausible one. The
    // face is not wrong so much as unknown; an entry in data/cfbCoachTones.json
    // turns it into a real match.
    toneWasGuessed,
    mappedTone: loadToneMap().get(headNumber(chosen.head)) ?? null,
    toneMapSize: loadToneMap().size,
  };
}

// ===========================================================================
// Madden -> CFB appearance (the reverse direction). Genuinely simpler than
// the forward direction's catalog: CFB's Generic_* head names encode the
// tone digit directly (Generic_<idx>_C_T<tex>_<hair>_<TONE>_<variant>), so
// no portrait-art measurement project was needed to build this -- cfbSkinTone
// already reads it, reused verbatim.
//
// Head and Portrait are copied TOGETHER from a real donor coach's own pair,
// exactly like the forward direction does for catalog-only heads -- this
// sidesteps CFB's Portrait id having no clean formula (verified: unlike
// Madden's exact +308 rule, CFB Portrait-vs-head-index deltas are mostly +10
// but not uniformly, so donor-copying the pair is the only safe way to keep
// them internally consistent).
//
// No CharacterVisuals write for the CFB side -- confirmed finding (this
// file's own header): a CFB coach's CharacterVisuals blob carries no head
// loadout at all, only apparel. GenericHeadAssetName + Portrait are the
// whole story here.
const CFB_GENERIC_HEAD_PATTERN = /^Generic_/;

// Every live CFB coach wearing a Generic_* head, with its own tone (read via
// cfbSkinTone, which already handles the override file) and Portrait id.
async function buildCfbAppearanceCatalog(cfbFile) {
  const coachT = biggestTableByName(cfbFile, 'Coach');
  await coachT.readRecords();
  const entries = [];
  for (const r of coachT.records) {
    if (r.isEmpty) continue;
    const head = safe(r, 'GenericHeadAssetName');
    if (!head || !CFB_GENERIC_HEAD_PATTERN.test(head)) continue;
    const portrait = safe(r, 'Portrait');
    if (typeof portrait !== 'number') continue;
    entries.push({ head, portrait, tone: cfbSkinTone(head), usedBy: 1 });
  }
  return { entries };
}

// Gives `destCoach` (a CFB Coach record) a head + portrait pair. Selection
// precedence mirrors grantAppearance exactly:
//   1. headAssetName -- explicit choice always wins
//   2. targetTone    -- nearest available match, tie-broken by seeded rng
//   3. seeded random -- deterministic fallback, no tone guarantee (flagged
//      toneWasGuessed so a caller can distinguish a match from a guess, same
//      as the forward direction's own contract)
async function grantCfbAppearance(cfbFile, destCoach, {
  seed = '', sourceRow = 0, targetTone = null, headAssetName = null,
} = {}) {
  const catalog = await buildCfbAppearanceCatalog(cfbFile);
  if (!catalog.entries.length) throw new Error('grantCfbAppearance: no usable Generic_* CFB coach heads found in this save.');

  const rng = makeSeededRng(deriveSeedString(seed, 'carousel:cfbAppearance', sourceRow));
  let chosen;
  let selection = 'seeded';
  let toneWasGuessed = false;

  if (headAssetName) {
    chosen = catalog.entries.find((e) => e.head === headAssetName);
    if (!chosen) {
      throw new Error(`grantCfbAppearance: "${headAssetName}" is not a Generic_* head currently in use in this save.`);
    }
    selection = 'explicit';
  } else if (typeof targetTone === 'number') {
    const scored = catalog.entries
      .filter((e) => typeof e.tone === 'number')
      .map((e) => ({ e, diff: Math.abs(e.tone - targetTone) }))
      .sort((a, b) => a.diff - b.diff);
    if (scored.length) {
      const best = scored[0].diff;
      const tied = scored.filter((x) => x.diff === best);
      chosen = tied[Math.floor(rng() * tied.length) % tied.length].e;
      selection = best === 0 ? `tone ${targetTone} (exact)` : `tone ${targetTone} (nearest available: ${chosen.tone})`;
    }
  }

  if (!chosen) {
    // No tone signal (a licensed Madden head, or targetTone simply unknown) --
    // sample uniformly across the live Generic_* pool rather than fail.
    chosen = catalog.entries[Math.floor(rng() * catalog.entries.length) % catalog.entries.length];
    toneWasGuessed = true;
    selection = 'tone unknown (GUESSED, seeded random from the live Generic_* pool)';
  }

  destCoach.GenericHeadAssetName = chosen.head;
  destCoach.Portrait = chosen.portrait;

  return {
    head: chosen.head, portrait: chosen.portrait, mappedTone: chosen.tone ?? null,
    catalogSize: catalog.entries.length, selection, toneWasGuessed,
  };
}

module.exports = {
  grantAppearance, buildAppearanceCatalog, poolWithCatalog, portraitForHead, withHead, readVisualsJson,
  findUsableVisualsDonor,
  cfbSkinTone, loadToneMap, loadCfbTones, clearCfbToneCache, sampleFallbackTone, confirmedHeads, headNumber, headAssetFor,
  setCfbToneOverridePath, setCoachToneOverride,
  grantCfbAppearance, buildCfbAppearanceCatalog,
  HEAD_PATTERN, PORTRAIT_OFFSET, TONE_MAP_PATH, CFB_TONE_PATH,
};
