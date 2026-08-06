// The Person identity core -- the field-for-field Coach<->Player
// intersection, verified against BOTH games' live schemas (not assumed from
// field names alone; see the note on Position below). Every Rosetta/carousel
// subsystem that needs "is this a coach or a player" doesn't matter yet
// builds on this shape. See COACH_CAROUSEL_ROADMAP.md section 1.2.
//
// Re-verified directly against schema (not just FINDINGS.md's field-name
// diff) that these 19 names are genuinely the same concept in both tables,
// not just a name collision: PERSON_FIELDS lists only fields whose Coach-side
// and Player-side types agree. `Position` was DELIBERATELY EXCLUDED even
// though the name is shared -- CFB Coach.Position uses the CoachPosition
// enum (HeadCoach/OffensiveCoordinator/...) while CFB Player.Position uses
// PositionE (QB/WR/...); same is true in Madden (StaffPosition vs
// PositionE). Copying "Position" through Person would silently turn a
// player's playing position into a coaching title. Each role facet (see
// CoachFacet below; a future PlayerFacet) owns its own `position` with its
// own enum -- this is exactly the trap Phase 5 (retired player -> coach)
// needs to not fall into, so it's fixed here at the root rather than papered
// over downstream.

const { safe } = require('../saveIO');
const identity = require('../rosetta/identity');

// The 18 fields (19 shared names minus Position), grouped the way
// COACH_CAROUSEL_ROADMAP.md section 1.2 groups them. Kept as a flat
// source-of-truth list (PERSON_FIELDS) plus the grouping
// (PERSON_FIELD_GROUPS) so a schema-presence assertion (Phase 1's startup
// check) can walk either shape.
const PERSON_FIELD_GROUPS = {
  identity: ['FirstName', 'LastName', 'IsCreated', 'IsLegend', 'IsUserControlled', 'PresentationId'],
  bio: ['Age', 'Height', 'Weight', 'CharacterBodyType', 'Personality'],
  appearance: ['GenericHeadAssetName', 'CharacterVisuals'],
  career: ['ExperiencePoints', 'LegacyScore', 'YearlyAwardCount'],
  assignment: ['TeamIndex', 'PrevTeamIndex'],
};
const PERSON_FIELDS = Object.values(PERSON_FIELD_GROUPS).flat();

// Pure extraction: record -> Person. `record` is duck-typed (needs `.index`
// and `.getValueByKey`), so this is trivially fakeable in a unit test without
// a real save -- see test/carouselPerson.spec.js. `sourceGame` is 'cfb' or
// 'madden'; `sourceTable` is the table this record came from ('Coach' today,
// 'Player' once Phase 5 adds a PlayerFacet extractor alongside this one).
function extractPerson(record, { sourceGame, sourceTable }) {
  if (sourceGame !== 'cfb' && sourceGame !== 'madden') {
    throw new Error(`extractPerson: sourceGame must be 'cfb' or 'madden', got ${JSON.stringify(sourceGame)}`);
  }
  return {
    identity: {
      sourceGame,
      sourceTable,
      sourceRow: identity.canonicalId(record),
      firstName: safe(record, 'FirstName'),
      lastName: safe(record, 'LastName'),
      isCreated: !!safe(record, 'IsCreated'),
      isLegend: !!safe(record, 'IsLegend'),
      isUserControlled: !!safe(record, 'IsUserControlled'),
      presentationId: safe(record, 'PresentationId'),
    },
    bio: {
      age: safe(record, 'Age'),
      height: safe(record, 'Height'),
      weight: safe(record, 'Weight'),
      bodyType: safe(record, 'CharacterBodyType'),
      personality: safe(record, 'Personality'),
    },
    appearance: {
      genericHeadAssetName: safe(record, 'GenericHeadAssetName'),
      characterVisuals: safe(record, 'CharacterVisuals'),
    },
    career: {
      experiencePoints: safe(record, 'ExperiencePoints'),
      legacyScore: safe(record, 'LegacyScore'),
      yearlyAwardCount: safe(record, 'YearlyAwardCount'),
    },
    assignment: {
      teamIndex: safe(record, 'TeamIndex'),
      prevTeamIndex: safe(record, 'PrevTeamIndex'),
    },
  };
}

module.exports = { PERSON_FIELDS, PERSON_FIELD_GROUPS, extractPerson };
