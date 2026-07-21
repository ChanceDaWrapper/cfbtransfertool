// READ-ONLY. The BaseScheme enum (reachable via Team.CurrentOffensiveScheme /
// DefaultOffensiveScheme) is the NAMED scheme vocabulary in both games.
// Dump it side by side -- this is the raw material for the scheme lookup table.
// Also dumps every enum in each schema whose name looks scheme/playbook-ish.
const fs = require('fs');
const path = require('path');
const { openCfb, openMadden } = require('./_saves');

const OUT = path.join(__dirname, 'out');

// schemaList.getEnum(name) returns nothing usable for these; the reliable route
// is to reach the FranchiseEnum through an ATTRIBUTE that is typed with it.
const ENUM_VIA = {
  BaseScheme: ['Team', 'DefaultOffensiveScheme'],
  SchemePreference: ['Team', 'PreferredSchemeType'],
  CoachTalentArcheType: ['Coach', 'DominantArchetype'],
  StaffArchetypeEnum: ['Coach', 'Archetype'],
  CoachSpecialty: ['Coach', 'COACH_SPECIALTY'],
  CoachSpecialtyType: ['Coach', 'SpecialtyType'],
  StaffPersonContractStatus: ['Coach', 'ContractStatus'],
  CoachBackstory: ['Coach', 'CoachBackstory'],
};

function getEnum(file, name) {
  const via = ENUM_VIA[name];
  if (!via) return null;
  try {
    const schema = file.schemaList.getSchema(via[0]);
    if (!schema) return null;
    const attr = schema.attributes.find((a) => a.name === via[1]);
    if (!attr || !attr.enum) return null;
    return attr.enum.members.map((m) => ({ i: m.index, name: m.name, value: m.value }));
  } catch (e) { return null; }
}

// normalize CFB "OFF_WEST_COAST_ZONE_RUN" and Madden "WestCoastZoneRun" to a
// common key so the two vocabularies can be auto-aligned.
function norm(n) {
  return String(n).replace(/^(OFF|DEF)_/i, '').replace(/[_\s]/g, '').toLowerCase();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cfb = await openCfb();
  const mad = await openMadden();

  const names = Object.keys(ENUM_VIA);
  const dump = {};
  for (const n of names) {
    dump[n] = { cfb: getEnum(cfb, n), madden: getEnum(mad, n) };
  }
  fs.writeFileSync(path.join(OUT, 'basescheme.json'), JSON.stringify(dump, null, 2));

  for (const n of names) {
    const c = dump[n].cfb, m = dump[n].madden;
    console.log(`\n################ ${n}  cfbN=${c ? c.length : '-'} madN=${m ? m.length : '-'}`);
    if (c) console.log('  CFB: ' + c.map((x) => `${x.name}=${x.value}`).join(' | '));
    if (m) console.log('  MAD: ' + m.map((x) => `${x.name}=${x.value}`).join(' | '));
    if (c && m) {
      const cm = new Map(c.filter((x) => !/^(First_|Last_|Max_|Count_|Invalid|None)/i.test(x.name)).map((x) => [norm(x.name), x]));
      const mm = new Map(m.filter((x) => !/^(First_|Last_|Max_|Count_|Invalid|None)/i.test(x.name)).map((x) => [norm(x.name), x]));
      const matched = [...cm.keys()].filter((k) => mm.has(k));
      const onlyC = [...cm.keys()].filter((k) => !mm.has(k));
      const onlyM = [...mm.keys()].filter((k) => !cm.has(k));
      console.log(`\n  --- NORMALIZED ALIGNMENT: ${matched.length} matched, ${onlyC.length} CFB-only, ${onlyM.length} Madden-only`);
      for (const k of matched) {
        const a = cm.get(k), b = mm.get(k);
        console.log(`     ${a.name.padEnd(34)} (${String(a.value).padStart(3)})  <->  ${b.name.padEnd(30)} (${String(b.value).padStart(3)})${a.value === b.value ? '' : '   *value differs*'}`);
      }
      if (onlyC.length) console.log('     CFB-ONLY: ' + onlyC.map((k) => cm.get(k).name).join(', '));
      if (onlyM.length) console.log('     MAD-ONLY: ' + onlyM.map((k) => mm.get(k).name).join(', '));
    }
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
