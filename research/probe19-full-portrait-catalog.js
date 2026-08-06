// READ-ONLY. probe18 only measured the 83 head assets that happened to be in
// use in the sample save. The user is right that that's a small slice -- the
// in-game Generic Heads browser offers ~200 male + ~40 female faces.
//
// This probe takes the whole MyFranchise asar instead:
//   1. enumerates EVERY *--coachportraits.png (not just the in-save 83)
//   2. dumps genHeadPortrait.json and any sibling manifests, so we can see
//      whether the app itself carries a head-asset-name -> portrait-id map
//      (which would let us name heads we've never seen in a save)
//   3. measures skin tone for every portrait, same algorithm as probe18
//
// Nothing is modified; the asar is only read.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASAR = 'C:/Users/tripl/AppData/Local/Programs/MyFranchise/resources/app.asar';
const OUT = path.join(__dirname, 'out');
const PORTRAIT_DIR = path.join(OUT, 'portraits-all');
const PORTRAIT_OFFSET = 308;

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

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} unsupported`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`color type ${colorType} unsupported`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.slice(rp, rp + stride); rp += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function skinOf(img) {
  const { width: w, height: h, channels: ch, data } = img;
  const x0 = Math.floor(w * 0.30), x1 = Math.ceil(w * 0.70);
  const y0 = Math.floor(h * 0.42), y1 = Math.ceil(h * 0.78);
  const px = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (ch === 4 && data[i + 3] < 200) continue;
      if (r < 25 && g < 25 && b < 25) continue;
      if (r > 235 && g > 235 && b > 235) continue;
      if (!(r > g && g >= b)) continue;
      px.push([r, g, b]);
    }
  }
  if (px.length < 40) return null;
  px.sort((p, q) => (p[0] + p[1] + p[2]) - (q[0] + q[1] + q[2]));
  const lo = Math.floor(px.length * 0.25), hi = Math.ceil(px.length * 0.75);
  const band = px.slice(lo, hi);
  const avg = band.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map((v) => v / band.length);
  return { r: avg[0], g: avg[1], b: avg[2], luma: 0.2126 * avg[0] + 0.7152 * avg[1] + 0.0722 * avg[2], samples: px.length };
}

(async () => {
  fs.mkdirSync(PORTRAIT_DIR, { recursive: true });
  const fd = fs.openSync(ASAR, 'r');
  const { dir, base } = readAsarDir(fd);

  const read = (e) => { const b = Buffer.alloc(e.size); fs.readSync(fd, b, 0, e.size, base + Number(e.offset)); return b; };

  // --- 1. inventory every file, bucketed by the "--<kind>.png" suffix -------
  const byKind = new Map();
  const portraits = new Map();
  const manifests = [];
  (function walk(node, p) {
    for (const [name, child] of Object.entries(node.files)) {
      const full = `${p}/${name}`;
      if (child.files) { walk(child, full); continue; }
      const m = name.match(/^(\d+)--([a-z]+)\.png$/i);
      if (m) {
        byKind.set(m[2], (byKind.get(m[2]) || 0) + 1);
        if (m[2] === 'coachportraits') portraits.set(Number(m[1]), child);
      }
      if (/\.json$/i.test(name) && /head|portrait|coach|face|skin/i.test(name)) manifests.push({ full, entry: child });
    }
  }(dir, ''));

  console.log('=== asar image inventory (by suffix) ===');
  for (const [kind, n] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${kind}`);

  console.log(`\n=== candidate manifests (${manifests.length}) ===`);
  for (const m of manifests) console.log(`  ${m.full}  (${m.entry.size} bytes)`);

  // --- 2. dump the manifests so we can look for a name<->id mapping ---------
  for (const m of manifests) {
    const outName = m.full.replace(/^\//, '').replace(/[\/\\]/g, '__');
    const buf = read(m.entry);
    fs.writeFileSync(path.join(OUT, `asar__${outName}`), buf);
    try {
      const j = JSON.parse(buf.toString('utf8'));
      const keys = Array.isArray(j) ? `array[${j.length}]` : Object.keys(j).slice(0, 12).join(', ');
      console.log(`\n  --- ${m.full} --- ${keys}`);
      const sample = Array.isArray(j) ? j.slice(0, 3) : Object.entries(j).slice(0, 3);
      console.log(JSON.stringify(sample, null, 2).split('\n').slice(0, 30).join('\n'));
    } catch (e) { console.log(`  (${m.full} is not JSON: ${e.message})`); }
  }

  // --- 3. measure EVERY coach portrait -------------------------------------
  const ids = [...portraits.keys()].sort((a, b) => a - b);
  console.log(`\n=== measuring all ${ids.length} coach portraits ===`);
  console.log(`portrait id range: ${ids[0]} .. ${ids[ids.length - 1]}`);

  const results = [];
  for (const pid of ids) {
    const png = read(portraits.get(pid));
    const asset = pid - PORTRAIT_OFFSET;
    fs.writeFileSync(path.join(PORTRAIT_DIR, `asset${String(asset).padStart(4, '0')}_p${pid}.png`), png);
    try {
      const skin = skinOf(decodePng(png));
      results.push(skin
        ? { portraitId: pid, asset, r: +skin.r.toFixed(1), g: +skin.g.toFixed(1), b: +skin.b.toFixed(1), luma: +skin.luma.toFixed(1), samples: skin.samples }
        : { portraitId: pid, asset, error: 'no skin pixels found' });
    } catch (e) { results.push({ portraitId: pid, asset, error: e.message }); }
  }
  fs.closeSync(fd);

  const ok = results.filter((r) => typeof r.luma === 'number');
  const bad = results.filter((r) => r.error);
  console.log(`measured ${ok.length}/${ids.length}` + (bad.length ? `, ${bad.length} failed` : ''));
  if (bad.length) for (const b of bad.slice(0, 20)) console.log(`   p${b.portraitId} (asset ${b.asset}): ${b.error}`);

  const lumas = ok.map((r) => r.luma).sort((a, b) => a - b);
  console.log(`luma range ${lumas[0]} .. ${lumas[lumas.length - 1]}  (median ${lumas[Math.floor(lumas.length / 2)]})`);

  // gaps in the id sequence tell us whether ids are dense (a catalog) or sparse
  const gaps = [];
  for (let i = 1; i < ids.length; i++) if (ids[i] !== ids[i - 1] + 1) gaps.push(`${ids[i - 1]}->${ids[i]}`);
  console.log(`\nid sequence gaps (${gaps.length}): ${gaps.slice(0, 40).join('  ')}`);

  fs.writeFileSync(path.join(OUT, 'portrait-tones-all.json'), JSON.stringify(results, null, 2));
  console.log(`\nwrote research/out/portrait-tones-all.json`);
  console.log(`PNGs -> research/out/portraits-all/`);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
