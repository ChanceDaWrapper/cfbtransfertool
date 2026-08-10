// draftClassConvert.js -- converting an exported draft class between Madden
// 26 and Madden 27.
//
// This runs against the two BUNDLED templates, which are real, unmodified
// exports of each game -- so it exercises the genuine formats without needing
// a user's own save on disk.
//
// The invariants that matter: the output must be structurally the target
// game's format, must actually carry the source's players (not the template's
// prospects), and must not smuggle across anything the target game does not
// have -- an M26-only skinTone key, or one of the ~50 head assets that exist
// in Madden 26 and not in Madden 27.

const assert = require('assert');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const dcf = require('../lib/draftClassFile');
const { convertDraftClassBuffer } = require('../lib/draftClassConvert');
const { TEMPLATE_PATHS } = require('../lib/draftClassTemplate');

let passed = 0;
function check(label, got, want) {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  passed++;
}
function ok(label, cond) { assert.ok(cond, label); passed++; }

const bufFor = (key) => zlib.gunzipSync(fs.readFileSync(TEMPLATE_PATHS[key]));
const jsonOf = (pl) => {
  try { return JSON.parse(pl.json.raw.toString('utf8').replace(/\0+$/, '')); } catch (e) { return null; }
};
const headsIn = (model) => {
  const s = new Set();
  for (const p of model.players) { const o = jsonOf(p); if (o && o.genericHeadName) s.add(o.genericHeadName); }
  return s;
};
const draftOrdered = (model) => model.players.slice().sort((a, b) => {
  const ra = dcf.getDraftRound(a) ?? dcf.UNDRAFTED_ROUND;
  const rb = dcf.getDraftRound(b) ?? dcf.UNDRAFTED_ROUND;
  return ra !== rb ? ra - rb : (dcf.getDraftPick(a) || 0) - (dcf.getDraftPick(b) || 0);
});

const m26Buf = bufFor('m26');
const m27Buf = bufFor('m27');
const m26 = dcf.parseDraftClassFile(m26Buf);
const m27 = dcf.parseDraftClassFile(m27Buf);

// ---------------------------------------------------------------------
// 1. M26 -> M27. The harder direction: fewer slots than players, and a
//    head vocabulary the source cannot simply be copied into.
// ---------------------------------------------------------------------
{
  const { buffer, report } = convertDraftClassBuffer(m26Buf, {});
  const out = dcf.parseDraftClassFile(buffer);

  check('target inferred as m27', report.to, 'm27');
  check('source recognised as m26', report.from, 'm26');

  // Structurally the target game's file, not the source's with a new tag.
  check('slot count is M27\'s', out.players.length, m27.players.length);
  check('record length is M27\'s', out.format.binaryRecordLen, 244);
  check('field shift is M27\'s', out.format.fieldShift, 4);
  check('schema tag is M27\'s', out.header.schemaTag, m27.header.schemaTag);
  check('byte length matches a real M27 export', buffer.length, m27Buf.length);

  // The source's players actually landed, in draft order.
  const src = draftOrdered(m26);
  let names = 0, ratings = 0, colleges = 0, positions = 0;
  for (let i = 0; i < out.players.length; i++) {
    const a = src[i]; const b = out.players[i];
    if (`${a.binary.firstName} ${a.binary.lastName}` === `${b.binary.firstName} ${b.binary.lastName}`) names++;
    if (dcf.getPosition(a) === dcf.getPosition(b)) positions++;
    if (dcf.getCollegeIndex(a) === dcf.getCollegeIndex(b)) colleges++;
    const ra = dcf.getRatings(a); const rb = dcf.getRatings(b);
    if (Object.keys(ra).every((k) => ra[k] === rb[k])) ratings++;
  }
  const n = out.players.length;
  check('every slot carries the source player\'s name', names, n);
  check('every slot carries the source position', positions, n);
  check('every slot carries the source college', colleges, n);
  check('every slot carries all 55 source ratings', ratings, n);

  // ...and none of the template's own prospects survived in a filled slot.
  let stillTemplate = 0;
  for (let i = 0; i < n; i++) {
    if (`${m27.players[i].binary.firstName} ${m27.players[i].binary.lastName}`
      === `${out.players[i].binary.firstName} ${out.players[i].binary.lastName}`) stillTemplate++;
  }
  check('no filled slot still holds the template\'s prospect', stillTemplate, 0);

  // The overflow is reported, not silent, and it is the BOTTOM of the board.
  check('the 13 extra players are reported as dropped', report.dropped, m26.players.length - m27.players.length);
  const lastKept = src[n - 1];
  const firstDropped = src[n];
  const rk = dcf.getDraftRound(lastKept) ?? dcf.UNDRAFTED_ROUND;
  const rd = dcf.getDraftRound(firstDropped) ?? dcf.UNDRAFTED_ROUND;
  ok('dropped players sit at or below the last kept player on the board', rd >= rk);

  // Nothing M26-only smuggled across.
  let skinToneKeys = 0;
  for (const p of out.players) { const o = jsonOf(p); if (o && 'skinTone' in o) skinToneKeys++; }
  check('no M26-only skinTone key survives into an M27 file', skinToneKeys, 0);

  const realM27Heads = headsIn(m27);
  let foreignHeads = 0, toneKept = 0, headed = 0;
  for (let i = 0; i < n; i++) {
    const o = jsonOf(out.players[i]);
    if (!o || !o.genericHeadName) continue;
    headed++;
    if (!realM27Heads.has(o.genericHeadName)) foreignHeads++;
    const s = /^gen_(\d+)_/.exec(String((jsonOf(src[i]) || {}).genericHeadName || ''));
    const d = /^gen_(\d+)_/.exec(o.genericHeadName);
    if (s && d && s[1] === d[1]) toneKept++;
  }
  check('every head exists in a real M27 export', foreignHeads, 0);
  check('skin tone survives the head swap for every player', toneKept, headed);

  // The M27-only ability block has no M26 source, so it must stay the
  // template's position-matched values rather than being zeroed or invented.
  let abilityKept = 0;
  for (let i = 0; i < n; i++) {
    const t = m27.players[i].binary.raw; const o = out.players[i].binary.raw;
    if ([202, 204, 206, 208, 210, 242].every((off) => t[off] === o[off])) abilityKept++;
  }
  check('the M27-only ability block is left as the template\'s', abilityKept, n);

  ok('the result re-serializes byte-identically', dcf.serializeDraftClassFile(out).equals(buffer));
}

// ---------------------------------------------------------------------
// 2. M27 -> M26. More slots than players, and skinTone has to come BACK.
// ---------------------------------------------------------------------
{
  const { buffer, report } = convertDraftClassBuffer(m27Buf, {});
  const out = dcf.parseDraftClassFile(buffer);

  check('target inferred as m26', report.to, 'm26');
  check('slot count is M26\'s', out.players.length, m26.players.length);
  check('record length is M26\'s', out.format.binaryRecordLen, 200);
  check('field shift is M26\'s', out.format.fieldShift, 0);
  check('nothing is dropped when the target has more slots', report.dropped, 0);
  check('the unfilled tail is reported', report.leftover, m26.players.length - m27.players.length);

  const src = draftOrdered(m27);
  let names = 0, ratings = 0;
  for (let i = 0; i < src.length; i++) {
    const a = src[i]; const b = out.players[i];
    if (`${a.binary.firstName} ${a.binary.lastName}` === `${b.binary.firstName} ${b.binary.lastName}`) names++;
    const ra = dcf.getRatings(a); const rb = dcf.getRatings(b);
    if (Object.keys(ra).every((k) => ra[k] === rb[k])) ratings++;
  }
  check('every source player landed', names, src.length);
  check('every source player kept all 55 ratings', ratings, src.length);

  // M26 DOES want skinTone -- the converted slots must carry it again.
  let withTone = 0;
  for (let i = 0; i < src.length; i++) {
    const o = jsonOf(out.players[i]);
    if (o && typeof o.skinTone === 'number') withTone++;
  }
  check('converted slots carry M26\'s skinTone field again', withTone, src.length);
}

// ---------------------------------------------------------------------
// 3. Refusals. Converting a file to the format it already is would silently
//    produce a re-encoded copy, which is worse than saying so.
// ---------------------------------------------------------------------
{
  assert.throws(() => convertDraftClassBuffer(m26Buf, { target: 'm26' }), /already M26/i,
    'converting an M26 file to m26 must be refused');
  passed++;
  assert.throws(() => convertDraftClassBuffer(m27Buf, { target: 'm27' }), /already M27/i,
    'converting an M27 file to m27 must be refused');
  passed++;
  assert.throws(() => convertDraftClassBuffer(m26Buf, { target: 'm28' }), /unknown target/i,
    'an unknown target must be refused');
  passed++;
}

console.log(`\n  Draft-class convert spec: ${passed} assertions passed.`);
