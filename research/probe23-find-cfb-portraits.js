// READ-ONLY. Hunts for a source of CFB *coach* portrait art, the way
// MyFranchise's app.asar turned out to be the source for Madden.
//
// CFB coaches DO carry a Portrait id (13-bit, observed 1..1056), so if any
// installed tool ships portrait PNGs keyed by that id we can measure CFB coach
// skin tone exactly as we measured Madden's -- which would close the last gap
// (the 230 Unique_* coaches whose head names encode no tone digit).
//
// Scans every app.asar on the machine and reports image-file naming patterns,
// so we can tell at a glance whether any of them carries coach art.

const fs = require('fs');

const ASARS = [
  'C:/Users/tripl/AppData/Local/Programs/CFB Transfer/resources/app.asar',
  'C:/Users/tripl/AppData/Local/Programs/madden-franchise-editor/resources/app.asar',
  'C:/Users/tripl/AppData/Local/Programs/MyFranchise/resources/app.asar',
  'C:/Users/tripl/Downloads/CFB27-Draft-Class-Exporter-v0.2.0-win32-x64/CFB27 Draft Class Exporter-win32-x64/resources/app.asar',
];

function readAsarDir(fd) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const buf = Buffer.alloc(jsonLen);
  fs.readSync(fd, buf, 0, jsonLen, 16);
  let base = 16 + jsonLen;
  base += (4 - (base % 4)) % 4;
  return { dir: JSON.parse(buf.toString('utf8')), base };
}

for (const asar of ASARS) {
  if (!fs.existsSync(asar)) { console.log(`\n### MISSING ${asar}`); continue; }
  console.log(`\n### ${asar}`);
  let fd;
  try { fd = fs.openSync(asar, 'r'); } catch (e) { console.log(`  cannot open: ${e.message}`); continue; }
  let dir;
  try { ({ dir } = readAsarDir(fd)); } catch (e) { console.log(`  cannot parse: ${e.message}`); fs.closeSync(fd); continue; }

  const imgPatterns = new Map();  // normalised name shape -> count
  const dirsWithImages = new Map();
  const jsonHits = [];
  let total = 0;

  (function walk(node, p) {
    for (const [name, child] of Object.entries(node.files || {})) {
      const full = `${p}/${name}`;
      if (child.files) { walk(child, full); continue; }
      total++;
      if (/\.(png|jpg|jpeg|webp|dds)$/i.test(name)) {
        const shape = name.replace(/\d+/g, '#');
        imgPatterns.set(shape, (imgPatterns.get(shape) || 0) + 1);
        const d = p.split('/').slice(0, 6).join('/');
        dirsWithImages.set(d, (dirsWithImages.get(d) || 0) + 1);
      }
      if (/\.json$/i.test(name) && /coach|head|portrait|face|skin|visual|appearance/i.test(name)) {
        jsonHits.push({ full, size: child.size, offset: child.offset });
      }
    }
  }(dir, ''));

  console.log(`  ${total} files`);
  const imgs = [...imgPatterns].sort((a, b) => b[1] - a[1]);
  console.log(`  image name shapes (top 12 of ${imgs.length}):`);
  for (const [shape, n] of imgs.slice(0, 12)) console.log(`     ${String(n).padStart(6)}  ${shape}`);
  console.log(`  dirs holding images (top 8):`);
  for (const [d, n] of [...dirsWithImages].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`     ${String(n).padStart(6)}  ${d}`);
  console.log(`  appearance-ish JSON (${jsonHits.length}):`);
  for (const j of jsonHits.slice(0, 12)) console.log(`     ${j.full} (${j.size}b)`);

  fs.closeSync(fd);
}
