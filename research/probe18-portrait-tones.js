// READ-ONLY. Derives coach head asset -> skin tone by MEASURING the actual
// portrait images, instead of eyeballing faces in-game.
//
// The breakthrough: the MyFranchise companion app (an Electron app the user
// already has installed) ships every coach portrait as a PNG inside its
// app.asar, named "<portraitId>--coachportraits.png". We already proved
// Portrait = headAssetNumber + 308 (93/93, zero exceptions), so each of our 83
// in-save head assets maps to exactly one portrait image -- and all 83 are
// present.
//
// This replaces the whole manual checklist: rather than asking a human to
// judge 83 faces in Coach Central, we sample face pixels and compute a tone.
//
// Nothing is modified. Portraits are read out of the asar into research/out/
// for inspection; the asar itself is only ever read.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASAR = 'C:/Users/tripl/AppData/Local/Programs/MyFranchise/resources/app.asar';
const OUT = path.join(__dirname, 'out');
const PORTRAIT_OFFSET = 308;

function readAsarDir(fd) {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const buf = Buffer.alloc(jsonLen);
  fs.readSync(fd, buf, 0, jsonLen, 16);
  let base = 16 + jsonLen;
  base += (4 - (base % 4)) % 4; // 4-byte aligned
  return { dir: JSON.parse(buf.toString('utf8')), base };
}

// --- minimal PNG decoder (RGB/RGBA, 8-bit, non-interlaced) -----------------
// Portraits are small; a dependency-free decoder keeps this probe standalone.
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

// Skin sampling: take the central face region, keep pixels that look like skin
// (warm hue, R > G > B) and are not near-black/near-white, then average.
// Hair, headwear and background are excluded by both the region crop and the
// hue test, which is what keeps a dark-haired light-skinned coach from reading
// as dark.
function skinOf(img) {
  const { width: w, height: h, channels: ch, data } = img;
  const x0 = Math.floor(w * 0.30), x1 = Math.ceil(w * 0.70);
  const y0 = Math.floor(h * 0.42), y1 = Math.ceil(h * 0.78);
  const px = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (ch === 4 && data[i + 3] < 200) continue;   // transparent
      if (r < 25 && g < 25 && b < 25) continue;      // near-black (hair/shadow)
      if (r > 235 && g > 235 && b > 235) continue;   // near-white (cap/background)
      if (!(r > g && g >= b)) continue;              // skin is warm: R > G >= B
      px.push([r, g, b]);
    }
  }
  if (px.length < 40) return null;
  px.sort((p, q) => (p[0] + p[1] + p[2]) - (q[0] + q[1] + q[2]));
  // median-ish band, discarding the extremes (specular highlights / deep shade)
  const lo = Math.floor(px.length * 0.25), hi = Math.ceil(px.length * 0.75);
  const band = px.slice(lo, hi);
  const avg = band.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map((v) => v / band.length);
  return { r: avg[0], g: avg[1], b: avg[2], luma: 0.2126 * avg[0] + 0.7152 * avg[1] + 0.0722 * avg[2], samples: px.length };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(OUT, 'portraits'), { recursive: true });

  const fd = fs.openSync(ASAR, 'r');
  const { dir, base } = readAsarDir(fd);

  const portraits = new Map();
  (function walk(node, p) {
    for (const [name, child] of Object.entries(node.files)) {
      const full = `${p}/${name}`;
      if (child.files) walk(child, full);
      else {
        const m = name.match(/^(\d+)--coachportraits\.png$/);
        if (m) portraits.set(Number(m[1]), { offset: Number(child.offset), size: child.size, path: full });
      }
    }
  }(dir, ''));

  const rows = JSON.parse(fs.readFileSync(path.join(OUT, 'coach-appearance.json'), 'utf8'));
  const assets = [...new Set(rows
    .filter((r) => /^coachhead_M_(\d+)_HS$/.test(r.head || ''))
    .map((r) => Number(r.head.match(/^coachhead_M_(\d+)_HS$/)[1])))].sort((a, b) => a - b);

  const results = [];
  for (const asset of assets) {
    const pid = asset + PORTRAIT_OFFSET;
    const e = portraits.get(pid);
    if (!e) { results.push({ asset, portraitId: pid, error: 'portrait not in asar' }); continue; }
    const png = Buffer.alloc(e.size);
    fs.readSync(fd, png, 0, e.size, base + e.offset);
    fs.writeFileSync(path.join(OUT, 'portraits', `asset${String(asset).padStart(4, '0')}_p${pid}.png`), png);
    try {
      const skin = skinOf(decodePng(png));
      results.push(skin
        ? { asset, portraitId: pid, r: +skin.r.toFixed(1), g: +skin.g.toFixed(1), b: +skin.b.toFixed(1), luma: +skin.luma.toFixed(1), samples: skin.samples }
        : { asset, portraitId: pid, error: 'no skin pixels found' });
    } catch (err) {
      results.push({ asset, portraitId: pid, error: err.message });
    }
  }
  fs.closeSync(fd);

  const ok = results.filter((r) => typeof r.luma === 'number').sort((a, b) => b.luma - a.luma);
  console.log(`measured ${ok.length}/${assets.length} assets\n`);
  console.log('  asset  portrait   luma    R    G    B   (lightest first)');
  for (const r of ok) {
    console.log(`   ${String(r.asset).padStart(4, '0')}     ${String(r.portraitId).padStart(4)}   ${String(r.luma).padStart(5)}  ${String(Math.round(r.r)).padStart(3)}  ${String(Math.round(r.g)).padStart(3)}  ${String(Math.round(r.b)).padStart(3)}`);
  }
  const failed = results.filter((r) => r.error);
  if (failed.length) {
    console.log(`\nfailed (${failed.length}):`);
    for (const f of failed) console.log(`   asset ${f.asset} (portrait ${f.portraitId}): ${f.error}`);
  }
  fs.writeFileSync(path.join(OUT, 'portrait-tones.json'), JSON.stringify(results, null, 2));
  console.log(`\nPNGs written to research/out/portraits/ for visual spot-checking.`);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
