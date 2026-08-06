// The Pool stage (lifecycle.js): every non-empty Coach row in an open save,
// as { person, coach }. The only I/O-touching module in lib/carousel/ so
// far -- person.js and coachFacet.js are pure extraction, this is what
// actually reads a table.
//
// Both games keep more than one table named 'Coach' in these sample saves
// (CFB ids 4173/6110, Madden 4160/5899) -- biggestTableByName (lib/saveIO.js)
// picks the one actually in use, same logic pipeline.js's buildTeamNames
// already applies to 'Team'.

const { biggestTableByName } = require('../saveIO');
const { extractPerson } = require('./person');
const { classifyCoachSchema, extractCoachFacet } = require('./coachFacet');
const { tagStage } = require('./lifecycle');

// file: an opened madden-franchise FranchiseFile (CFB or Madden).
// sourceGame: 'cfb' | 'madden' -- tags every Person/CoachFacet extracted.
async function listCoaches(file, sourceGame) {
  if (sourceGame !== 'cfb' && sourceGame !== 'madden') {
    throw new Error(`listCoaches: sourceGame must be 'cfb' or 'madden', got ${JSON.stringify(sourceGame)}`);
  }
  const table = biggestTableByName(file, 'Coach');
  if (!table) {
    throw new Error(`listCoaches: this ${sourceGame} save has no Coach table.`);
  }
  await table.readRecords();

  const fieldClassification = classifyCoachSchema(file);
  const pool = [];
  for (const record of table.records) {
    if (record.isEmpty) continue;
    pool.push({
      person: extractPerson(record, { sourceGame, sourceTable: 'Coach' }),
      coach: extractCoachFacet(record, { sourceGame, fieldClassification }),
    });
  }
  return tagStage(pool, 'pool', { sourceGame, tableId: table.header.tableId });
}

module.exports = { listCoaches };
