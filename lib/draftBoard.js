'use strict';

// Draft-board ORGANIZATION -- how an already-selected class is ordered into
// rounds and picks. See DRAFTBOARD_ROADMAP.md.
//
// This is deliberately a separate concern from SELECTION. projectDraftClass()
// picks which players make the class (using a score that includes CFB's own
// projected round), and that selection is identical no matter which
// organization strategy runs here. Only the ORDER of that fixed pool differs.
//
// That separation is load-bearing, not stylistic: measured against a real
// dynasty, re-deriving the pool from a talent-only score changes membership by
// 36 of 402 players. Selection must therefore be computed once, upstream, and
// simply handed to us.
//
// Strategies are registered in ORGANIZATIONS and chosen by
// cfg.draftBoard.organization, mirroring how cfg.translation.strategy selects
// a rating-conversion engine.

const PICKS_PER_ROUND = 32;
const DRAFTED_PICKS = 224; // 7 rounds x 32; everything past this is the UDFA tail
const DRAFT_AWARDS_BONUS_CAP = 4; // same cap projectDraftClass applies

// Talent-only score: the draft-value formula MINUS the CFB projected-round
// term and minus board variance. This is what makes `realisticDraftDay` an
// independent engine rather than "CFB's projection plus noise" -- that round
// bonus is worth up to +14 points against an overall spread of only ~23, so
// leaving it in would let CFB's rounds dominate the very thing we're trying to
// re-derive from talent.
function talentScoreOf(r, cfg) {
  const dv = cfg.draftValue || {};
  const posValue = cfg.positionValue || {};
  const posBonus = (posValue[r.Position] || 0) * (dv.positionValueWeight ?? 1);
  const awardsBonus = Math.min(DRAFT_AWARDS_BONUS_CAP, (Number(r.AwardsScore) || 0) * (dv.awardsWeight ?? 0.5));
  const prodBonus = ((r._prodScore ?? 50) / 99) * (dv.productionWeight ?? 3);
  const athBonus = ((r._athScore ?? 50) / 99) * (dv.athleticismWeight ?? 2.5);
  let s = Number(r.OverallRating) + posBonus + awardsBonus + prodBonus + athBonus;
  if (r._generational) s += 12; // keep the generational lock at the top of talent
  return s;
}

// How far (in PICKS) this player slides down the board. One-directional and
// fat-tailed: most players barely move, a few fall a long way.
//
// One-directional is the whole design. A random *swap* is conservation of
// position -- moving a good player down to pick 200 forces whoever sat at 200
// up to pick 5, so every steal manufactures an equally severe bust (measured:
// a 54 overall reaching round 1 in a class topping out at 75). A one-way fall
// instead pushes everyone below up by a single slot each, spreading the cost
// across ~200 players rather than concentrating it in one. Measured across
// every chaos level, the worst overall inside round 1 never degraded.
//
// No cap on the fall: a genuinely large slide is the point (per roadmap
// Decision 2). The bias toward staying near the front comes from the shape of
// the distribution, not from a clamp.
// Shape tuned against a real dynasty (402-player class). An earlier, tighter
// version (70/25/5 split) left the chaos dial almost inert -- sweeping it 0->100
// moved slot/overall correlation only -0.68 -> -0.60. Widening the tail to ~12%
// makes the dial actually mean something (-0.68 -> -0.50 across its range) while
// still leaving 60% of the class moving under half a round, which is what keeps
// the board "pulled toward the front."
function drawFall(rng, chaos) {
  const u = rng();
  let rounds;
  if (u < 0.60) rounds = rng() * 0.5;          // ~60%: under half a round
  else if (u < 0.88) rounds = 0.5 + rng() * 2; // ~28%: half a round to two and a half
  else rounds = 2.5 + rng() * 8;               // ~12%: the tail -- these are the steals
  return rounds * PICKS_PER_ROUND * (chaos / 50);
}

// Today's behavior: the pool arrives already sorted by the selection score, so
// organizing it is a no-op. Kept as an explicit strategy so it is a real,
// always-available baseline (useful for a "what would this player have gone?"
// comparison) rather than an implicit special case.
function cfbProjected(selected) {
  return selected;
}

// Re-rank the SAME pool on talent alone, then let players slide.
function realisticDraftDay(selected, cfg, rng) {
  const chaos = Number(cfg.draftBoard?.chaos ?? 50);
  const byTalent = selected
    .map((r) => ({ r, talent: talentScoreOf(r, cfg) }))
    .sort((a, b) => b.talent - a.talent);

  if (!(chaos > 0)) return byTalent.map((x) => x.r);

  return byTalent
    .map((x, i) => ({ r: x.r, eff: i + 1 + drawFall(rng, chaos) }))
    .sort((a, b) => a.eff - b.eff)
    .map((x) => x.r);
}

const ORGANIZATIONS = {
  cfbProjected,
  realisticDraftDay,
};

// Orders `selected` per the configured strategy and stamps _rank/_round/_pick.
// `rng` must be the projection RNG (salted separately from the rating RNG) so
// the board stays reproducible under a seed and can never perturb ratings.
function organizeBoard(selected, cfg, rng) {
  const mode = cfg.draftBoard?.organization ?? 'cfbProjected';
  const strategy = ORGANIZATIONS[mode] || ORGANIZATIONS.cfbProjected;
  const ordered = strategy(selected, cfg, rng);

  ordered.forEach((r, i) => {
    r._rank = i + 1;
    r._round = r._rank <= DRAFTED_PICKS ? Math.ceil(r._rank / PICKS_PER_ROUND) : null;
    r._pick = r._rank <= DRAFTED_PICKS ? ((r._rank - 1) % PICKS_PER_ROUND) + 1 : null;
  });
  return ordered;
}

module.exports = {
  organizeBoard,
  talentScoreOf,
  drawFall,
  ORGANIZATIONS,
  PICKS_PER_ROUND,
  DRAFTED_PICKS,
};
