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

// One live record. `fields` holds every scalar value directly; `refs` holds
// {key: {tableId, rowNumber}} for reference-typed fields (HeadCoach,
// CharacterVisuals, ActiveTalentTree, ...). `index` is the row number other
// records reference this one by.
function makeRecord(index, fields = {}, refs = {}) {
  const rec = { index, isEmpty: false, ...fields };
  rec.getValueByKey = function getValueByKey(k) {
    return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : undefined;
  };
  rec.getReferenceDataByKey = function getReferenceDataByKey(k) {
    return Object.prototype.hasOwnProperty.call(refs, k) ? refs[k] : null;
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
function makeTable({ tableId, name, records, capacity }) {
  const cap = capacity ?? (Math.max(0, ...records.map((r) => r.index)) + 1);
  const byIndex = new Array(cap);
  for (let i = 0; i < cap; i++) byIndex[i] = makeEmptyRecord(i);
  for (const r of records) byIndex[r.index] = r;
  return {
    name,
    header: { tableId, recordCapacity: cap },
    records: byIndex,
    async readRecords() { /* already populated -- matches the real API's idempotent re-read */ },
  };
}

// The fake file itself. `schemas`: { TableName: schema }. `tables`:
// { TableName: tableObjectFromMakeTable }. Table ids are auto-assigned if
// not given explicitly, stable across getTableById/getAllTablesByName so a
// reference built with `refTo(table, row)` always resolves.
function makeFakeFile({ schemas = {}, tables = {} } = {}) {
  const byId = new Map();
  for (const t of Object.values(tables)) byId.set(t.header.tableId, t);

  return {
    schemaList: { getSchema: (name) => schemas[name] || null },
    getTableByName: (name) => tables[name] || null,
    getAllTablesByName: (name) => (tables[name] ? [tables[name]] : []),
    getTableById: (id) => byId.get(id) || null,
    tables: Object.values(tables),
  };
}

// Builds a {tableId, rowNumber} reference to a row in `table`, for use as a
// record's `refs` entry (e.g. a Team's HeadCoach pointer).
function refTo(table, rowNumber) {
  return { tableId: table.header.tableId, rowNumber };
}

module.exports = {
  enumAttr, intAttr, makeSchema, makeRecord, makeEmptyRecord, makeTable, makeFakeFile, refTo,
};
