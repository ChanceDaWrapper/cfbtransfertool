// Carousel -- the front door for the coaching-carousel engine. Mirrors
// lib/rosetta/index.js's own convention exactly (see its header): one
// function per lifecycle stage, no single run-everything entry point.
//
// Phase 0: Pool (listCoaches). Phase 1: the map/ layer. Phase 2 (this file's
// moveCoachCfbToMadden): Selection is UI-driven (the caller picks which CFB
// row moves, not this module); Mapped -> map/index.js; Staged -> place.js;
// Written -> write.js. All tied together here as one orchestration function.

const { createCarouselContext } = require('./context');
const { STAGES, tagStage } = require('./lifecycle');
const person = require('./person');
const coachFacet = require('./coachFacet');
const { listCoaches } = require('./coachPool');
const map = require('./map');
const movement = require('./movement');
const { findFreeAgentSlot } = require('./place');
const {
  planTeamPlacement, displaceIncumbent, findMaddenTeam, findIncumbent, clearStaleTeamLoadouts,
} = require('./placeOnTeam');
const {
  planCfbTeamPlacement, displaceCfbIncumbent, findCfbTeam, findCfbIncumbent,
} = require('./placeOnCfbTeam');
const { writeCoachFields, saveAs } = require('./write');
const timing = require('./timing');
const { grantTalentTree } = require('./talentTree');
const { grantCfbTalentTree } = require('./cfbTalentTree');
const { attachCfbEmploymentRecords } = require('./cfbEmploymentRecords');
const { fixEmploymentFields } = require('./cfbNormalize');
const { fixStaleContractOffers } = require('./cfbContractOffers');
const { transferJobSecurityRank, countEmployedCfbCoaches } = require('./cfbJobSecurityRank');
const { assertCfbTransferReady } = require('./preflight');
const { grantAppearance, grantCfbAppearance, cfbSkinTone, loadToneMap, headNumber } = require('./appearance');
const { safe, biggestTableByName } = require('../saveIO');

// Moves ONE coach from a CFB save to a Madden save via Mode A (free-agent
// injection, section 3.7 -- no team, no reciprocal Team.<slot> write; the
// destination game's own hiring system is expected to pick the coach up,
// per Q7's resolution). Writes to `outputPath`, never `maddenFile`'s own
// source path in place.
//
//   cfbFile, maddenFile   -- already-open FranchiseFile instances.
//   cfbCoachRowIndex      -- the CFB Coach table row to move (its `.index`).
//   outputPath            -- where to save the resulting Madden file. Required;
//                             this function never overwrites in place.
//   config.seed           -- carousel RNG seed (blank -> fresh roll each call).
//   config.winsor         -- Level model destination winsorization (default 0.95).
//   config.dryRun         -- if true, computes and returns the mapped fields
//                             and chosen destination row WITHOUT writing or
//                             saving anything -- the "full diff report" the
//                             roadmap's Phase 1 goal describes.
async function moveCoachCfbToMadden({ cfbFile, maddenFile, cfbCoachRowIndex, outputPath, config = {}, log = () => {} }) {
  if (!config.dryRun && !outputPath) {
    throw new Error('moveCoachCfbToMadden: outputPath is required unless config.dryRun is true '
      + '-- this never overwrites the source Madden save in place.');
  }

  const cfbCoachTable = biggestTableByName(cfbFile, 'Coach');
  await cfbCoachTable.readRecords();
  const cfbCoachRecord = cfbCoachTable.records[cfbCoachRowIndex];
  if (!cfbCoachRecord || cfbCoachRecord.isEmpty) {
    throw new Error(`moveCoachCfbToMadden: no coach at CFB Coach row ${cfbCoachRowIndex}.`);
  }

  log(`Mapping ${safe(cfbCoachRecord, 'Name')} (${safe(cfbCoachRecord, 'Position')}, Level ${safe(cfbCoachRecord, 'Level')})...`);
  const models = await map.buildCarouselModels({ cfbFile, maddenFile, winsor: config.winsor });
  const mappedFields = await map.mapCoachCfbToMadden({ cfbCoachRecord, maddenFile, models, config });

  const destRecord = await findFreeAgentSlot(maddenFile, mappedFields.Position);
  const destWas = { row: destRecord.index, contractStatus: safe(destRecord, 'ContractStatus'), position: safe(destRecord, 'Position') };
  log(`Destination: Madden Coach row ${destRecord.index} (was ${destWas.contractStatus} ${destWas.position})`
    + ` -> Level ${mappedFields.Level}, Archetype ${mappedFields.Archetype}, ${mappedFields.ContractStatus}`);

  if (config.dryRun) {
    return { dryRun: true, destRow: destRecord.index, destWas, fields: mappedFields };
  }

  const writtenFields = writeCoachFields(destRecord, mappedFields);
  await saveAs(maddenFile, outputPath);
  log(`Saved to ${outputPath}.`);
  return { dryRun: false, destRow: destRecord.index, destWas, fields: mappedFields, writtenFields, outputPath };
}

// Moves ONE coach from a CFB save directly into a NAMED Madden team's job
// (Mode B, section 3.7) -- acts on a specific movement.js proposal, e.g.
// "put Freeman on the Giants" rather than injecting him as a free agent and
// hoping Madden's own hiring system picks him up.
//
// Displaces the incumbent (if any) into free agency, writes the new coach's
// mapped fields into a destination row, and writes BOTH pointers describing
// the new job (Coach.TeamIndex on the new row, and the reciprocal
// Team.<slot> reference back at them -- Q8's locked decision). Writes to
// `outputPath`, never `maddenFile`'s own source path in place.
//
//   teamIndex / teamName  -- identifies the Madden team (either works).
//   contractLength        -- years on the new contract (default 4).
//   (all other options match moveCoachCfbToMadden.)
async function moveCoachCfbToMaddenTeam({
  cfbFile, maddenFile, cfbCoachRowIndex, teamIndex, teamName, contractLength = 4,
  outputPath, config = {}, log = () => {},
}) {
  if (!config.dryRun && !outputPath) {
    throw new Error('moveCoachCfbToMaddenTeam: outputPath is required unless config.dryRun is true '
      + '-- this never overwrites the source Madden save in place.');
  }

  const cfbCoachTable = biggestTableByName(cfbFile, 'Coach');
  await cfbCoachTable.readRecords();
  const cfbCoachRecord = cfbCoachTable.records[cfbCoachRowIndex];
  if (!cfbCoachRecord || cfbCoachRecord.isEmpty) {
    throw new Error(`moveCoachCfbToMaddenTeam: no coach at CFB Coach row ${cfbCoachRowIndex}.`);
  }

  log(`Mapping ${safe(cfbCoachRecord, 'Name')} (${safe(cfbCoachRecord, 'Position')}, Level ${safe(cfbCoachRecord, 'Level')})...`);
  const models = await map.buildCarouselModels({ cfbFile, maddenFile, winsor: config.winsor });
  const plan = await planTeamPlacement({ cfbCoachRecord, maddenFile, models, teamIndex, teamName, contractLength, config });

  const incumbentDesc = plan.incumbent
    ? `${safe(plan.incumbent, 'Name')} (Level ${safe(plan.incumbent, 'Level')}, ${safe(plan.incumbent, 'CareerWins')}-${safe(plan.incumbent, 'CareerLosses')})`
    : '(vacant)';
  log(`${plan.teamName} ${plan.position}: displacing ${incumbentDesc} -> hiring `
    + `${safe(cfbCoachRecord, 'Name')} (mapped Level ${plan.mappedFields.Level}, Archetype ${plan.mappedFields.Archetype}, `
    + `salary ${plan.mappedFields.ContractSalary}, record ${plan.mappedFields.CareerWins}-${plan.mappedFields.CareerLosses})`);
  log(`  destination row ${plan.destRecord.index} -- ${plan.destReason}`);

  if (config.dryRun) {
    return {
      dryRun: true, teamIndex: plan.teamIndex, teamName: plan.teamName, position: plan.position,
      incumbentRow: plan.incumbent ? plan.incumbent.index : null,
      destRow: plan.destRecord.index, fields: plan.mappedFields,
    };
  }

  const displaced = displaceIncumbent(plan.incumbent, plan.teamIndex);
  const writtenFields = writeCoachFields(plan.destRecord, plan.mappedFields);

  // The team's own gameday/playsheet/wear-and-tear loadout slots hold
  // whichever Talent row the PREVIOUS HeadCoach personally equipped -- those
  // rows are private to one coach, so they go stale the moment the job
  // changes hands (COACH_TRANSFER_AUDIT.md L5). Only a HeadCoach's tree
  // populates them (see clearStaleTeamLoadouts's header), so OC/DC hires
  // leave them untouched.
  let clearedLoadouts = [];
  if (plan.position === 'HeadCoach') {
    clearedLoadouts = await clearStaleTeamLoadouts(maddenFile, plan.teamRecord);
    if (clearedLoadouts.length) {
      log(`  cleared ${clearedLoadouts.length} stale loadout slot(s) left by the outgoing coach: `
        + `${clearedLoadouts.map((c) => `${c.field}#${c.slot}`).join(', ')}`);
    }
  }

  // Give the new coach a private talent tree. Without this they render as
  // "Level 1 / DUMMY ARCHETYPE / no abilities" regardless of what
  // Coach.Level and Coach.Archetype say -- Madden's Coach Central reads the
  // tree, not those scalars (verified in-game). See talentTree.js.
  let talentReport = null;
  if (!config.skipTalentTree) {
    talentReport = await grantTalentTree(maddenFile, plan.destRecord, {
      position: plan.position,
      archetype: plan.mappedFields.Archetype,
      targetLevel: plan.mappedFields.Level,
      // Never clone from the row we're writing into, nor from the coach we
      // just displaced (their tree is about to be stale anyway).
      excludeRows: [plan.destRecord.index, plan.incumbent ? plan.incumbent.index : -1],
    });
    const cats = talentReport.categories.map((c) => `${c.category.replace('Talents', '')}=${c.cloned}`).join(' ');
    log(`  talent tree: cloned from ${talentReport.donor.name} (L${talentReport.donor.level}, `
      + `${talentReport.donor.archetype}${talentReport.donor.exactArchetype ? '' : ' -- archetype fallback'}); `
      + `${cats}; IndexInUnlockList=${talentReport.unlockIndex}`);
  }

  // Give the new coach a face. A blank destination row has no
  // GenericHeadAssetName and a null CharacterVisuals reference, which renders
  // as a silhouette; CFB's own visuals carry no head loadout to copy, so the
  // head is synthesized from Madden's catalog. See appearance.js.
  let appearanceReport = null;
  let appearanceError = null;
  if (!config.skipAppearance) {
    // A face is COSMETIC. Everything above this point -- the job, the level,
    // the contract, the talent tree, both team pointers -- is the actual
    // transfer, and it has already succeeded by the time we get here. So an
    // appearance failure is reported and stepped over, never allowed to
    // abort the write.
    //
    // This was a real user-facing bug: a save whose CharacterVisuals blobs
    // could not be read made grantAppearance throw, which killed the entire
    // Write Save -- the user could not move ANY coach at all, over a face.
    // Worse, the thrown message told them to "pass config.skipAppearance",
    // which is not reachable from the UI (see renderer.js) -- advice they
    // had no way to act on.
    try {
      appearanceReport = await grantAppearance(maddenFile, plan.destRecord, {
        seed: config.seed, sourceRow: cfbCoachRowIndex,
        // Skin tone IS the face -- Madden bakes complexion into the head asset
        // (there is no tint field; see COACH_FIDELITY_ROADMAP.md 4.1). So tone
        // matching means picking a different head.
        //   config.coachHeadAsset -- explicit choice, always wins
        //   targetTone            -- read from the CFB coach's own head name when
        //                            it encodes one (null for Unique_* heads, i.e.
        //                            the named/marquee coaches)
        headAssetName: config.coachHeadAsset,
        targetTone: config.coachSkinTone ?? cfbSkinTone(safe(cfbCoachRecord, 'GenericHeadAssetName')),
      });
      log(`  appearance: head ${appearanceReport.head} (${appearanceReport.selection}), portrait ${appearanceReport.portrait}, `
        + `visuals row ${appearanceReport.visualsRow} -- tone map has ${appearanceReport.toneMapSize} of ${appearanceReport.catalogSize} heads`);
    } catch (e) {
      appearanceError = e.message;
      log(`  appearance: SKIPPED -- ${e.message}`);
      log('  the transfer itself is unaffected: job, level, contract, talent tree and both team '
        + 'pointers are all written. The coach keeps the destination row\'s existing face.');
    }
  }

  // The reciprocal Team.<slot> write -- Q8's "always write both" decision.
  // getBinaryReferenceToRecord is the vendored madden-franchise library's own
  // API for constructing a valid same-save reference (verified: it just
  // encodes {tableId: this table's own id, rowNumber: index} -- the exact
  // shape getReferenceDataByKey reads back).
  const coachTable = biggestTableByName(maddenFile, 'Coach');
  plan.teamRecord[plan.position] = coachTable.getBinaryReferenceToRecord(plan.destRecord.index);

  await saveAs(maddenFile, outputPath);
  log(`Saved to ${outputPath}.`);
  return {
    dryRun: false, teamIndex: plan.teamIndex, teamName: plan.teamName, position: plan.position,
    displacedIncumbent: displaced, destRow: plan.destRecord.index, fields: plan.mappedFields,
    writtenFields, talentReport, appearanceReport, appearanceError, clearedLoadouts, outputPath,
  };
}

// Moves ONE coach from a Madden save directly into a NAMED CFB school's job
// -- the reverse direction's Mode B, mirroring moveCoachCfbToMaddenTeam
// exactly (same shape, same log cadence, same dryRun contract). Writes to
// `outputPath`, never `cfbFile`'s own source path in place.
//
// Two real differences from the forward function, both because of verified
// CFB-side facts rather than arbitrary asymmetry:
//   - grantCfbTalentTree never allocates rows (every CFB Coach row already
//     owns its own private talent chain -- see cfbTalentTree.js's header),
//     so there is no "excludeRows" concept to pass it.
//   - grantCfbAppearance needs the source coach's OWN tone (read via
//     loadToneMap/headNumber off the Madden record), not cfbSkinTone (that
//     reads a CFB head name; the source here is Madden).
//
//   teamIndex / teamName  -- identifies the CFB school (either works).
//   contractLength        -- years on the new contract (default 4).
//   (all other options match moveCoachCfbToMaddenTeam.)
async function moveCoachMaddenToCfbTeam({
  cfbFile, maddenFile, maddenCoachRowIndex, teamIndex, teamName, contractLength = 4,
  outputPath, config = {}, log = () => {},
}) {
  if (!config.dryRun && !outputPath) {
    throw new Error('moveCoachMaddenToCfbTeam: outputPath is required unless config.dryRun is true '
      + '-- this never overwrites the source CFB save in place.');
  }

  // Structural pre-flight, FIRST -- before the plan is built and long before
  // anything is written. Confirms the destination actually contains the tables
  // and fields this transfer is about to read and write. Passes silently on
  // every save this has been run against; it exists so that if a future title
  // update renames or drops something, the user gets a refusal naming what is
  // missing instead of either an opaque null-dereference from deep in the
  // engine or, worse, a silently wrong answer written to their dynasty.
  // See lib/carousel/preflight.js for why each item is fatal vs a warning.
  assertCfbTransferReady(cfbFile, { what: 'this CFB dynasty', log });

  const maddenCoachTable = biggestTableByName(maddenFile, 'Coach');
  await maddenCoachTable.readRecords();
  const maddenCoachRecord = maddenCoachTable.records[maddenCoachRowIndex];
  if (!maddenCoachRecord || maddenCoachRecord.isEmpty) {
    throw new Error(`moveCoachMaddenToCfbTeam: no coach at Madden Coach row ${maddenCoachRowIndex}.`);
  }

  log(`Mapping ${safe(maddenCoachRecord, 'Name')} (${safe(maddenCoachRecord, 'Position')}, Level ${safe(maddenCoachRecord, 'Level')})...`);
  const models = await map.buildCarouselModels({ cfbFile, maddenFile, winsor: config.winsor, direction: 'maddenToCfb' });
  const plan = await planCfbTeamPlacement({ maddenCoachRecord, cfbFile, models, teamIndex, teamName, contractLength, config });

  const incumbentDesc = plan.incumbent
    ? `${safe(plan.incumbent, 'Name')} (Level ${safe(plan.incumbent, 'Level')})`
    : '(vacant)';
  log(`${plan.teamName} ${plan.position}: displacing ${incumbentDesc} -> hiring `
    + `${safe(maddenCoachRecord, 'Name')} (mapped Level ${plan.mappedFields.Level}, `
    + `Archetype ${plan.mappedFields.DominantArchetype}, salary ${plan.mappedFields.ContractSalary})`);
  log(`  destination row ${plan.destRecord.index} -- ${plan.destReason}`);

  if (config.dryRun) {
    return {
      dryRun: true, teamIndex: plan.teamIndex, teamName: plan.teamName, position: plan.position,
      incumbentRow: plan.incumbent ? plan.incumbent.index : null,
      destRow: plan.destRecord.index, fields: plan.mappedFields,
    };
  }

  const displaced = displaceCfbIncumbent(plan.incumbent, plan.teamIndex);
  const writtenFields = writeCoachFields(plan.destRecord, plan.mappedFields);

  // Hand the job's league-wide job-security STANDING to whoever now holds the
  // job. This is not a cosmetic field: CurrentJobSecurityPercentageRank is a
  // dense unique permutation over the employed coaches (1..N, no gaps, no
  // duplicates -- verified in two independent healthy saves), and free agents
  // sit outside it on a sentinel. Skipping this leaves the arriving coach
  // carrying the free-agent sentinel while the fired incumbent walks off with a
  // real rank, so the permutation ends up with a hole AND an out-of-range
  // duplicate. That is what made a preseason transfer produce a dynasty that
  // loaded forever. Must run AFTER displaceCfbIncumbent (which is what frees the
  // incumbent's rank) and after writeCoachFields (which sets TeamIndex/Level,
  // i.e. what makes the arriving coach count as employed at all).
  // See lib/carousel/cfbJobSecurityRank.js for the full measurement.
  const rankMove = transferJobSecurityRank(plan.destRecord, plan.incumbent, {
    employedCountAfter: plan.incumbent ? null : await countEmployedCfbCoaches(cfbFile),
  });
  if (rankMove) {
    log(rankMove.mode === 'inherited'
      ? `  job-security rank: ${rankMove.rank} inherited from the outgoing coach`
      : `  job-security rank: ${rankMove.rank} (new last place -- no incumbent to inherit from)`);
  } else {
    log('  job-security rank: could not be set -- see cfbJobSecurityRank.js; '
      + 'run tools/repairTransferredCoaches.js on the output if the save will not load');
  }

  // Same rule as the forward direction, same reason: without a populated
  // talent structure a coach's Level/Archetype scalars are backing data the
  // UI doesn't read from directly (verified for Madden in-game; CFB's own
  // in-game verification is still pending -- see cfbTalentTree.js's header
  // for the measured Level<->talent-spend correlation this ships against).
  //
  // excludeRows matters here in a way it didn't get in test until this was
  // caught live: writeCoachFields already wrote Name/Level onto destRecord
  // ABOVE this line, and pickCfbDonorCoach re-reads the Coach table fresh --
  // so without excluding destRecord's own row, the destination coach can
  // become eligible as its OWN nearest-level donor (a perfect Level match to
  // itself), silently "granting" a no-op copy of its own blank state. Also
  // exclude the just-displaced incumbent, same as the forward direction.
  let talentReport = null;
  if (!config.skipTalentTree) {
    talentReport = await grantCfbTalentTree(cfbFile, plan.destRecord, {
      position: plan.position,
      targetLevel: plan.mappedFields.Level,
      excludeRows: [plan.destRecord.index, plan.incumbent ? plan.incumbent.index : -1],
    });
    log(`  talent tree: matched to ${talentReport.donor.name} (L${talentReport.donor.level}); `
      + `${talentReport.subtreesCopied} subtrees, ${talentReport.statusesCopied} statuses, ${talentReport.totalSpent} points spent`);
    if (talentReport.skipped) log(`  WARNING: talent tree skipped -- ${talentReport.skipped}`);
  }

  // Give the new coach a face -- a blank CFB shell's own head is whatever
  // that filler shell already had, not the arriving Madden coach's likeness.
  let appearanceReport = null;
  let appearanceError = null;
  if (!config.skipAppearance) {
    // Same rule as the forward direction: a face is cosmetic and must never
    // abort a transfer that has already succeeded. See that function's own
    // comment for the user-facing incident this prevents.
    try {
      const maddenHead = safe(maddenCoachRecord, 'GenericHeadAssetName');
      appearanceReport = await grantCfbAppearance(cfbFile, plan.destRecord, {
        seed: config.seed, sourceRow: maddenCoachRowIndex,
        headAssetName: config.coachHeadAsset,
        targetTone: config.coachSkinTone ?? loadToneMap().get(headNumber(maddenHead)) ?? null,
      });
      log(`  appearance: head ${appearanceReport.head} (${appearanceReport.selection}), portrait ${appearanceReport.portrait}`);
    } catch (e) {
      appearanceError = e.message;
      log(`  appearance: SKIPPED -- ${e.message}`);
      log('  the transfer itself is unaffected: job, level, contract, talent state and both team '
        + 'pointers are all written. The coach keeps the destination row\'s existing face.');
    }
  }

  // Bring the landing shell up to "employed coach" shape. A disposable CFB
  // shell owns no CareerStats/SeasonStats/CharacterVisuals and points
  // TeamPhilosophy at a different asset table than any employed coach uses;
  // leaving it that way produced a save that looked perfect but CRASHED the
  // moment the user advanced past bowl week, because that is when CFB walks
  // every employed coach's season records. See cfbEmploymentRecords.js.
  //
  // NOT wrapped in a try/catch, unlike the cosmetic appearance step above:
  // if these records cannot be attached, the coach must not be written at
  // all. A missing face is a blemish; a missing season record is a save that
  // bricks on advance.
  const employmentReport = await attachCfbEmploymentRecords(cfbFile, plan.destRecord, {
    teamRecord: plan.teamRecord,
    incumbent: plan.incumbent,
    excludeRows: [plan.incumbent ? plan.incumbent.index : -1],
  });
  log(`  employment records: ${employmentReport.attached.length ? `attached ${employmentReport.attached.join(', ')}` : 'none needed'}`
    + `${employmentReport.reused.length ? `; kept existing ${employmentReport.reused.join(', ')}` : ''}`);
  if (employmentReport.philosophy) log(`  team philosophy: inherited from ${employmentReport.philosophy}`);

  // Attaching the missing structures was necessary but NOT sufficient -- a
  // repaired save built from only that step still crashed on advance. The
  // written coach was additionally out of distribution on 12-19 further
  // fields at once (a Count_ contract expectation no real coach carries, a
  // 4-year contract where real coordinators have 1-2, Madden career points
  // on a CFB coordinator, ... -- values CFB itself never gives an employed
  // coach. The clearest is CurrentContractExpectation=Count_, the enum's "no
  // contract goal" member: normal for a free agent, held by ZERO employed
  // coaches in a healthy dynasty, and read by the game at exactly the moment
  // the user's save died. See cfbNormalize.js for how the field list was
  // established (against a healthy save, not this one).
  const employmentFixes = await fixEmploymentFields(cfbFile, plan.destRecord, {
    incumbent: plan.incumbent,
    excludeRows: [plan.incumbent ? plan.incumbent.index : -1],
  });
  if (employmentFixes.length) {
    log(`  employment fields: ${employmentFixes.map((c) => `${c.field} ${JSON.stringify(c.from)}->${JSON.stringify(c.to)}`).join(', ')}`);
  }

  // The shell we just overwrote may have had pending contract offers from
  // other schools -- those live in their own table and still point at this
  // row. An employed coach's offer must name the school being poached from
  // (160/160 do); a free agent's does not. Leaving them free-agent-shaped
  // gives the carousel a null to walk into. See cfbContractOffers.js.
  const offerFixes = await fixStaleContractOffers(cfbFile, { coachRows: [plan.destRecord.index] });
  if (offerFixes.length) {
    log(`  contract offers: repaired ${offerFixes.length} pending offer(s) left over from the landing slot`);
  }

  // The reciprocal Team.<slot> write -- same "always write both" rule as the
  // forward direction (Q8).
  const coachTable = biggestTableByName(cfbFile, 'Coach');
  plan.teamRecord[plan.position] = coachTable.getBinaryReferenceToRecord(plan.destRecord.index);

  await saveAs(cfbFile, outputPath);
  log(`Saved to ${outputPath}.`);
  return {
    dryRun: false, teamIndex: plan.teamIndex, teamName: plan.teamName, position: plan.position,
    displacedIncumbent: displaced, destRow: plan.destRecord.index, fields: plan.mappedFields,
    writtenFields, talentReport, appearanceReport, appearanceError, outputPath,
  };
}

module.exports = {
  createCarouselContext,
  STAGES,
  tagStage,
  person,
  coachFacet,
  listCoaches,
  map,
  movement,
  proposeCarousel: movement.proposeCarousel,
  findFreeAgentSlot,
  findMaddenTeam,
  findIncumbent,
  findCfbTeam,
  findCfbIncumbent,
  timing,
  writeCoachFields,
  saveAs,
  moveCoachCfbToMadden,
  moveCoachCfbToMaddenTeam,
  moveCoachMaddenToCfbTeam,
};
