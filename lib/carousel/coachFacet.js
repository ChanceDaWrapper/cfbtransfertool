// CoachFacet -- everything about a Coach row that is NOT part of the
// game-agnostic Person core (person.js), extracted schema-driven rather than
// as a hardcoded field list. Per COACH_CAROUSEL_ROADMAP.md's "never hardcode
// what the schema can answer" posture (also applied to the scheme lookup
// table): whatever fields the live Coach schema actually has, minus the 19
// already lifted into Person, is what a facet carries -- so this file does
// not need editing when a title update adds or removes a Coach field.
//
// `raw` and `refs` are kept SEPARATE (not merged into one bag) because they
// need different accessors: getValueByKey() on a reference-typed field
// (Scheme, TeamPhilosophy, CareerStats, ...) returns a useless raw bitstring,
// not the pointer -- verified against a live save. `refs[name]` is always a
// `{tableId, rowNumber} | null` from getReferenceDataByKey(); `raw[name]` is
// always the plain value (or enum member NAME string) from getValueByKey().
//
// This module intentionally does NOT interpret any field -- no enum
// crossing, no scheme lookup, no synthesis. That is Phase 1's map/ layer,
// which consumes exactly this shape. This is extraction only.

const { safe, safeRef } = require('../saveIO');
const { PERSON_FIELDS } = require('./person');

const PERSON_FIELD_SET = new Set(PERSON_FIELDS);
const SCALAR_TYPES = new Set(['int', 'bool', 'string', 'float']);

// An attribute is a reference (points at a row in another table, or is an
// array/struct blob) unless it's a plain scalar type OR an enum -- enum
// members read back as their NAME string via getValueByKey (e.g.
// ContractStatus -> "FreeAgent"), which is exactly what Phase 1's
// name-based enum bridge needs, so enums stay in `raw`, not `refs`.
function isReferenceType(attr) {
  return !attr.enum && !SCALAR_TYPES.has(attr.type);
}

// Computed ONCE per open save (not per coach row) -- classifying every
// attribute in the live Coach schema is wasted work to repeat for every one
// of a save's few hundred coaches.
function classifyCoachSchema(file) {
  const schema = file.schemaList.getSchema('Coach');
  if (!schema) throw new Error("classifyCoachSchema: this save's schema has no Coach table definition.");
  const scalarFields = [];
  const referenceFields = [];
  for (const attr of schema.attributes) {
    if (PERSON_FIELD_SET.has(attr.name)) continue; // already lifted into Person -- don't duplicate
    (isReferenceType(attr) ? referenceFields : scalarFields).push(attr.name);
  }
  return { scalarFields, referenceFields };
}

// Pure given a precomputed classification: record -> CoachFacet. `record` is
// the same duck-typed object extractPerson takes, plus getReferenceDataByKey
// for the reference fields.
function extractCoachFacet(record, { sourceGame, fieldClassification }) {
  const raw = {};
  for (const name of fieldClassification.scalarFields) raw[name] = safe(record, name);
  const refs = {};
  for (const name of fieldClassification.referenceFields) refs[name] = safeRef(record, name);
  return { sourceGame, raw, refs };
}

module.exports = { classifyCoachSchema, extractCoachFacet, isReferenceType };
