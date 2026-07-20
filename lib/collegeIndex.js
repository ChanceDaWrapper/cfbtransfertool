'use strict';

// Loads data/collegeFieldIndex.json (baked by tools/bakeCollegeFieldIndex.js):
// College reference bitstring (same keys as data/college_lookup.json's values)
// -> the u16LE college index a draft-class player's binary offset 66 needs to
// display that school on import. See draftClassFile.js's COLLEGE_INDEX_OFFSET
// for how the field itself was ground-truthed.

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'data', 'collegeFieldIndex.json');

let cached = null;
function loadCollegeFieldIndex() {
  if (!cached) {
    if (!fs.existsSync(INDEX_PATH)) {
      throw new Error(
        `College field index not found at ${INDEX_PATH}. Generate it with: `
        + `node tools/bakeCollegeFieldIndex.js "<path to a Madden 26 franchise save>"`
      );
    }
    cached = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  }
  return cached;
}

// Returns the college index for a College reference bitstring, or null if
// that school isn't in the baked catalog (the template doesn't cover every
// Madden college -- current coverage is 127 schools, ~98% of drafted players
// in practice since it's weighted toward the schools that actually produce
// draft picks).
function collegeIndexForRef(ref) {
  const catalog = loadCollegeFieldIndex();
  return ref != null && ref in catalog ? catalog[ref] : null;
}

module.exports = {
  INDEX_PATH,
  loadCollegeFieldIndex,
  collegeIndexForRef,
};
