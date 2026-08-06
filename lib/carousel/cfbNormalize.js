// Fixes the fields a transferred coach ends up holding values CFB itself
// never gives an employed coach.
//
// HOW THIS LIST WAS BUILT, and why it is an explicit allowlist rather than a
// statistical rule. Two earlier attempts used "anything unlike the other
// coaches" as the test. Both failed, and instructively:
//   - measured against the CRASHING save, the damaged coaches polluted their
//     own baseline, so the detector found nothing;
//   - measured with a percentage threshold, it flagged 134 of 414 coaches in
//     a KNOWN-HEALTHY save, because high-cardinality fields (playbooks,
//     schemes, recruiting pipelines) legitimately have many rare values.
// Being unusual is not the same as being invalid.
//
// So the list below is fixed, and every entry was verified the only way that
// actually proves anything: against the employed coaches of a HEALTHY,
// never-transferred dynasty (414 of them). Each field here is one where all
// six transferred coaches in a crashing save carried a value that not one of
// those 414 healthy coaches ever holds.
//
//   field                       transfers carry        all 414 healthy employed carry
//   CurrentContractExpectation  Count_                 Win4-9Games / WinConfChamp / WinNY6Bowl
//   CoachBackstory              HCSalesman, OCSchemer  Motivator (413), StaffBuilder (1)
//   TeamBuilding                ThroughDraft           Balanced (414)
//   TradingTendency             TradesDown             DoesNotTrade (414)
//   COACH_DEFTENDENCYRUNPASS    44                     0 (413), 50 (1)
//   COACH_RBTENDENCY            95                     50 (269), 0 (145)
//
// CurrentContractExpectation is the most likely crash: Count_ is the enum's
// "no goal" member, normal for a FREE AGENT (about 75% of them carry it) and
// held by zero employed coaches. Advancing past bowl week is exactly when the
// game asks every employed coach whether they met their contract goal.
//
// Several of the others are our own doing rather than shell leftovers:
// TeamBuilding/TradingTendency are COPIED from the Madden coach even though
// synthesis.js documents that CFB is uniformly Balanced/DoesNotTrade, and
// CoachBackstory is synthesised into position-flavoured members
// ({HC,OC,DC}{Schemer,Salesman,Motivator}) that exist in the enum but that
// real CFB coaches never use.
//
// ContractLength/ContractYearsRemaining were on this list in an earlier
// version and are DELIBERATELY removed. They looked damaged on the one
// crashing save this was built against (every transfer read 4, no healthy
// coach there read 4) -- but a second healthy dynasty had coordinators on
// 1/2/3/5-year deals with no 4 either, which just means 4 is uncommon, not
// that it is invalid; nothing establishes it as an employed-vs-free-agent
// marker the way Count_ demonstrably is. "Fixing" it shortened four real
// coordinators' contracts to 1 year for no evidenced reason. Contract terms
// are also a direct, intentional output of the transfer (config.contractLength),
// not free-agent-shell leftovers -- a different category of field than the
// ones actually in this list.
//
// Replacements come from the DESTINATION save's own employed coaches, never a
// hardcoded constant, so this follows whatever that dynasty actually does.

const { safe, biggestTableByName } = require('../saveIO');

const EMPLOYMENT_FIELDS = [
  'CurrentContractExpectation',
  'CoachBackstory',
  'TeamBuilding',
  'TradingTendency',
  'COACH_DEFTENDENCYRUNPASS',
  'COACH_RBTENDENCY',
];

// A value is legitimate if ANY genuine employed coach holds it -- no
// frequency threshold. Thresholds were tried and rejected: they discard
// rare-but-real values (CoachBackstory "StaffBuilder" occurs once in 414
// healthy coaches, COACH_DEFTENDENCYRUNPASS 50 likewise) and flagged them as
// damage. The damaged coaches are kept out of the baseline instead, by
// identifying them first via findDamagedCoaches below -- which is why that
// function keys off a single unambiguous signal rather than this profile.

function employedPeersByPosition(coachRecords, { excludeRows = [] } = {}) {
  const exclude = new Set(excludeRows);
  const byPos = new Map();
  for (const r of coachRecords) {
    if (r.isEmpty || exclude.has(r.index)) continue;
    const ti = safe(r, 'TeamIndex');
    if (ti === undefined || ti === 255) continue;
    if (!safe(r, 'Level')) continue;
    const pos = safe(r, 'Position');
    if (!byPos.has(pos)) byPos.set(pos, []);
    byPos.get(pos).push(r);
  }
  return byPos;
}

// For one position: which values are legitimate for each field, and what to
// use instead when a coach's value is not.
function buildEmploymentProfile(peers) {
  const fields = new Map();
  for (const field of EMPLOYMENT_FIELDS) {
    const counts = new Map();
    for (const p of peers) {
      const v = safe(p, field);
      if (v !== undefined) counts.set(v, (counts.get(v) || 0) + 1);
    }
    if (!counts.size) continue;
    const legitimate = new Set();
    let mode = null, best = -1;
    for (const [v, n] of counts) {
      legitimate.add(v);
      if (n > best) { best = n; mode = v; }
    }
    if (!legitimate.size || mode === null) continue;
    fields.set(field, { legitimate, replacement: mode });
  }
  return fields;
}

// Replaces any employment field holding a value CFB never gives an employed
// coach. `preferFrom` (the displaced incumbent) wins where they have a usable
// value -- a contract goal belongs to the job, so the person who just held it
// is the most faithful source.
function applyEmploymentProfile(coachRecord, profile, { preferFrom = null } = {}) {
  if (!profile) return [];
  const changes = [];
  for (const [field, spec] of profile) {
    const v = safe(coachRecord, field);
    if (v === undefined || spec.legitimate.has(v)) continue;

    let replacement = spec.replacement;
    let source = 'the positional norm';
    if (preferFrom) {
      const inherited = safe(preferFrom, field);
      if (inherited !== undefined && spec.legitimate.has(inherited)) {
        replacement = inherited;
        source = 'the outgoing coach';
      }
    }
    try {
      coachRecord[field] = replacement;
      changes.push({ field, from: v, to: replacement, source });
    } catch (e) { /* read-only/derived -- skip */ }
  }
  return changes;
}

// Reports (without changing anything) which employment fields on this coach
// hold a value no employed coach in the save legitimately uses.
function employmentProblems(coachRecord, profile) {
  if (!profile) return [];
  const bad = [];
  for (const [field, spec] of profile) {
    const v = safe(coachRecord, field);
    if (v !== undefined && !spec.legitimate.has(v)) bad.push({ field, value: v });
  }
  return bad;
}

// Finds coaches damaged by an older build's transfer, using ONE unambiguous
// signal: an employed coach whose contract expectation is the enum's "no
// goal" member.
//
// Deliberately a single signal rather than the whole field list. The other
// fields cannot identify damage on their own -- a baseline computed from a
// population that still contains the damaged coaches treats their broken
// values as normal, and every attempt to work around that with frequency
// thresholds produced false positives on healthy dynasties. Count_ has none
// of that ambiguity: it is a sentinel, roughly 75% of free agents carry it,
// and zero employed coaches in either a healthy or a damaged save do.
//
// Once these are known, they can be excluded from the baseline, which is what
// makes the remaining fields safe to evaluate.
const NO_CONTRACT_GOAL = 'Count_';
function findDamagedCoaches(coachRecords) {
  return coachRecords.filter((r) => {
    if (r.isEmpty) return false;
    const ti = safe(r, 'TeamIndex');
    if (ti === undefined || ti === 255) return false;
    if (!safe(r, 'Level')) return false;
    return safe(r, 'CurrentContractExpectation') === NO_CONTRACT_GOAL;
  });
}

async function fixEmploymentFields(cfbFile, coachRecord, { incumbent = null, excludeRows = [] } = {}) {
  const t = biggestTableByName(cfbFile, 'Coach');
  await t.readRecords();
  const byPos = employedPeersByPosition(t.records, { excludeRows: [coachRecord.index, ...excludeRows] });
  const peers = byPos.get(safe(coachRecord, 'Position'));
  if (!peers || !peers.length) return [];
  return applyEmploymentProfile(coachRecord, buildEmploymentProfile(peers), { preferFrom: incumbent });
}

module.exports = {
  fixEmploymentFields, applyEmploymentProfile, buildEmploymentProfile, findDamagedCoaches,
  employedPeersByPosition, employmentProblems, EMPLOYMENT_FIELDS,
};
