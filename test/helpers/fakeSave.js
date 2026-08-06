// A minimal, in-memory stand-in for a live FranchiseFile, built to satisfy
// exactly the surface lib/carousel/ actually reads: schemaList.getSchema(),
// getTableByName/getAllTablesByName/getTableById, and per-record
// getValueByKey/getReferenceDataByKey. No real save file needed.
//
// WHY THIS EXISTS. The carousel's orchestration layer (map/index.js's
// mapCoachCfbToMadden/mapCoachMaddenToCfb, carousel/index.js's
// moveCoach*, run.js's propose/commit) had zero test coverage as of this
// file's creation -- every sub-module it composes (coachFieldMap,
// enumBridge, archetypeMap, synthesis, the pure halves of levelScale/
// schemeLookup) was tested in isolation, but nothing exercised the actual
// composition. That's precisely where the crash-on-advance and infinite-
// load bugs shipped from. This fixture exists so orchestration can be
// tested the same way the rest of this codebase already is -- without
// needing a real, personal save file (which cannot be committed) or a
// live game (which cannot run in a test).
//
// Deliberately NOT a mock library or a wrapper around madden-franchise --
// a plain object literal per record/table, matching the shape every real
// call site already reads via saveIO.js's `safe()`/`safeRef()`. Keeping it
// this literal means a reader can see exactly what data a test depends on
// without chasing through a builder API.

// One enum-typed schema attribute. `members` is the list of legal name
// strings this field accepts -- crossEnum/liveEnumMembers read exactly this.
function enumAttr(name, members) {
  return { name, type: 'enum', enum: { members: members.map((m) => ({ name: m })) } };
}

// One numeric-typed schema attribute -- levelScale.js's levelRange and
// map/index.js's fieldMax both read min/maxValue directly.
function intAttr(name, { min = 0, max = 99999 } = {}) {
  return { name, type: 'int', minValue: min, maxValue: max };
}

function makeSchema(attributes) {
  return { attributes };
}

// A reference-typed field's value and a scalar field's value live in the SAME
// slot on a real FranchiseFileRecord -- getValueByKey and getReferenceDataByKey
// are just two different VIEWS of whatever is currently there (a raw
// bitstring copy vs. the resolved {tableId,rowNumber}). Tagging the stored
// value itself (rather than keeping a separate, construction-time-only `refs`
// bag) is what makes `record[key] = table.getBinaryReferenceToRecord(row)`
// -- a real mutation lib/carousel/*.js performs constantly -- visible to a
// LATER getReferenceDataByKey call, exactly like the real library.
function isRefValue(v) {
  return v !== null && typeof v === 'object' && typeof v.tableId === 'number';
}
// A deterministic-looking 32-char binary string standing in for the raw
// bitstring copy a real getValueByKey returns for a reference field -- some
// callers (cfbEmploymentRecords.js's static-asset check) pattern-match
// /^[01]{32}$/ before deciding a value is a direct bitstring rather than an
// in-save table reference.
function fakeRawBits(ref) {
  const n = (ref.tableId * 100003 + ref.rowNumber) >>> 0;
  return n.toString(2).padStart(32, '0').slice(-32);
}

// One live record. `fields` holds scalar AND reference values -- pass a
// {tableId, rowNumber} object (see refTo()) for any reference-typed field.
// `index` is the row number other records reference this one by. The third
// argument is accepted for backward compatibility with callers that still
// pass references separately; they're merged into `fields` either way.
function makeRecord(index, fields = {}, legacyRefs = {}) {
  const rec = { index, isEmpty: false, ...fields, ...legacyRefs };
  rec.getValueByKey = function getValueByKey(k) {
    if (!Object.prototype.hasOwnProperty.call(this, k)) return undefined;
    const v = this[k];
    return isRefValue(v) ? fakeRawBits(v) : v;
  };
  rec.getReferenceDataByKey = function getReferenceDataByKey(k) {
    const v = Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null;
    return isRefValue(v) ? { tableId: v.tableId, rowNumber: v.rowNumber } : null;
  };
  return rec;
}

function makeEmptyRecord(index) {
  return {
    index, isEmpty: true,
    getValueByKey: () => undefined,
    getReferenceDataByKey: () => null,
  };
}

// A dense table: index 0..n-1, empty rows for anything not explicitly given
// a record -- matches how a real Coach/Team table is a fixed-capacity array
// with some rows populated and the rest sitting on the free list.
//
// `schema`, if given, is set BOTH as file.schemaList.getSchema(name) would
// return it (see makeFakeFile) AND directly on the table object as `.schema`
// -- real code reads it both ways depending on the call site (e.g.
// cfbEmploymentRecords.js's freshStatsFieldValues reads statsTable.schema
// directly, since it only has the table object in hand, not the file).
function makeTable({ tableId, name, records, capacity, schema = null }) {
  const cap = capacity ?? (Math.max(0, ...records.map((r) => r.index)) + 1);
  const byIndex = new Array(cap);
  for (let i = 0; i < cap; i++) byIndex[i] = makeEmptyRecord(i);
  for (const r of records) byIndex[r.index] = r;
  return {
    name,
    header: { tableId, recordCapacity: cap },
    schema,
    records: byIndex,
    async readRecords() { /* already populated -- matches the real API's idempotent re-read */ },
    // Real tables build the {tableId,rowNumber} reference object for you
    // rather than making a caller construct one by hand -- e.g.
    // cfbEmploymentRecords.js's `destCoach.CharacterVisuals =
    // visTable.getBinaryReferenceToRecord(fresh.index)`. Same shape refTo()
    // builds; kept as two entry points because that's what the real call
    // sites use (one has the table object in scope, the other doesn't).
    getBinaryReferenceToRecord(rowNumber) { return { tableId, rowNumber }; },
  };
}

// The fake file itself. `schemas`: { TableName: schema }. `tables`:
// { TableName: tableObjectFromMakeTable }. Table ids are auto-assigned if
// not given explicitly, stable across getTableById/getAllTablesByName so a
// reference built with `refTo(table, row)` always resolves.
function makeFakeFile({ schemas = {}, tables = {} } = {}) {
  const byId = new Map();
  for (const t of Object.values(tables)) byId.set(t.header.tableId, t);

  const file = {
    schemaList: { getSchema: (name) => schemas[name] || null },
    getTableByName: (name) => tables[name] || null,
    getAllTablesByName: (name) => (tables[name] ? [tables[name]] : []),
    getTableById: (id) => byId.get(id) || null,
    tables: Object.values(tables),
    // lib/carousel/write.js's saveAs() just calls file.save(outputPath) --
    // recorded rather than a no-op so a test can assert a write actually
    // happened (or, for a dry run, assert it deliberately did NOT).
    savedTo: null,
    async save(outputPath) { file.savedTo = outputPath; },
  };
  return file;
}

// Builds a {tableId, rowNumber} reference to a row in `table`, for use as a
// record's `refs` entry (e.g. a Team's HeadCoach pointer).
function refTo(table, rowNumber) {
  return { tableId: table.header.tableId, rowNumber };
}

module.exports = {
  enumAttr, intAttr, makeSchema, makeRecord, makeEmptyRecord, makeTable, makeFakeFile, refTo,
};
