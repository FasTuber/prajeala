#!/usr/bin/env node
// Generates every PNG icon the app ships with, without any npm dependency.
//
//   node scripts/gen-icons.mjs                 write assets/**
//   node scripts/gen-icons.mjs --check         fail if assets/** differ from a fresh render
//   node scripts/gen-icons.mjs --preview=FILE  also write a contact sheet (for eyeballing)
//   node scripts/gen-icons.mjs --out=DIR       write somewhere else than assets/
//
// The flame is an implicit shape: a few teardrop "tongues" turned into exact
// signed-distance fields (distance to their outline polygons) and combined with
// a smooth union. Coverage/anti-aliasing comes straight from the distance, and
// the colour ramps (dark red rim → orange body → yellow core) are driven by the
// same distances. The result is rasterised to an RGBA buffer and encoded as PNG
// by hand (signature, IHDR, adaptively filtered scanlines deflated into IDAT,
// IEND, CRC32 in JS). Everything is deterministic: same input → same bytes.
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ───────────────────────────── CLI ─────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const outDir = resolve(root, option('out') ?? 'assets');
const checkOnly = flag('check');
const previewPath = option('preview');

// ───────────────────────────── maths ─────────────────────────────
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, k) => a + (b - a) * k;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix3 = (a, b, k) => [mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k)];
/** Polynomial smooth minimum (union of two signed distances). */
const smin = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};

// ───────────────────────────── shapes ─────────────────────────────
/**
 * Outline of a stylised flame tongue as a closed polygon (Float64Array of x,y
 * pairs). Round at the bottom, tapering to a point that leans sideways.
 * All units are normalised canvas units (−1 … 1, y up).
 */
function flamePolygon({ x, yBottom, height, halfWidth, lean = 0, bottomRound = 0.42, taperPow = 1.6, taperExp = 1.2, n = 128 }) {
  const profile = (t) => {
    const round = t < bottomRound ? Math.sqrt(Math.max(0, 1 - ((bottomRound - t) / bottomRound) ** 2)) : 1;
    const taper = (1 - t ** taperPow) ** taperExp;
    return round * taper;
  };
  // Normalise so the widest point of the profile equals halfWidth.
  let peak = 0;
  for (let i = 0; i <= 512; i++) peak = Math.max(peak, profile(i / 512));
  const right = [];
  const left = [];
  for (let i = 0; i <= n; i++) {
    const t = 0.5 - 0.5 * Math.cos((Math.PI * i) / n); // cosine spacing: denser at both ends
    const w = (halfWidth * profile(t)) / peak;
    const cx = x + lean * height * t ** 2.2;
    const y = yBottom + t * height;
    right.push(cx + w, y);
    left.push(cx - w, y);
  }
  const pts = new Float64Array(right.length + left.length);
  pts.set(right, 0);
  // Walk the left side back down so the polygon is closed and consistently oriented.
  for (let i = 0, j = left.length - 2; j >= 0; i += 2, j -= 2) {
    pts[right.length + i] = left[j];
    pts[right.length + i + 1] = left[j + 1];
  }
  return pts;
}

/** Exact signed distance from (px,py) to a closed polygon (negative inside). */
function sdPolygon(pts, px, py) {
  const count = pts.length / 2;
  let d = Infinity;
  let sign = 1;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const ax = pts[i * 2];
    const ay = pts[i * 2 + 1];
    const bx = pts[j * 2];
    const by = pts[j * 2 + 1];
    const ex = bx - ax;
    const ey = by - ay;
    const wx = px - ax;
    const wy = py - ay;
    const ee = ex * ex + ey * ey;
    const k = ee > 0 ? clamp((wx * ex + wy * ey) / ee, 0, 1) : 0;
    const qx = wx - ex * k;
    const qy = wy - ey * k;
    const dd = qx * qx + qy * qy;
    if (dd < d) d = dd;
    const c1 = py >= ay;
    const c2 = py < by;
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) sign = -sign;
  }
  return sign * Math.sqrt(d);
}

/**
 * Builds the flame for a given "fit" (half-extent of the canvas the flame may
 * use). Returns closures evaluating the three layers' signed distances.
 */
function buildFlame(fit) {
  const main = flamePolygon({
    x: -0.02 * fit,
    yBottom: -0.92 * fit,
    height: 1.9 * fit,
    halfWidth: 0.58 * fit,
    lean: 0.07,
  });
  const tongue = flamePolygon({
    x: -0.36 * fit,
    yBottom: -0.74 * fit,
    height: 1.0 * fit,
    halfWidth: 0.27 * fit,
    lean: -0.2,
    taperExp: 1.0,
  });
  const inner = flamePolygon({
    x: 0.01 * fit,
    yBottom: -0.8 * fit,
    height: 1.18 * fit,
    halfWidth: 0.36 * fit,
    lean: 0.05,
    bottomRound: 0.5,
  });
  const core = flamePolygon({
    x: 0.02 * fit,
    yBottom: -0.72 * fit,
    height: 0.66 * fit,
    halfWidth: 0.2 * fit,
    lean: 0.03,
    bottomRound: 0.55,
  });
  return {
    outer: (x, y) => smin(sdPolygon(main, x, y), sdPolygon(tongue, x, y), 0.14 * fit),
    inner: (x, y) => sdPolygon(inner, x, y),
    core: (x, y) => sdPolygon(core, x, y),
  };
}

// ───────────────────────────── colours ─────────────────────────────
const C = {
  rim: [0.58, 0.04, 0.02],
  body: [0.98, 0.3, 0.05],
  bodyTop: [1.0, 0.45, 0.08],
  innerLow: [1.0, 0.56, 0.1],
  innerHigh: [1.0, 0.8, 0.2],
  coreLow: [1.0, 0.97, 0.78],
  coreHigh: [1.0, 0.9, 0.5],
  badgeTop: [0.2, 0.1, 0.14],
  badgeBottom: [0.07, 0.035, 0.06],
  glow: [1.0, 0.38, 0.1],
};

// ───────────────────────────── raster ─────────────────────────────
/**
 * Renders one icon into a straight-alpha RGBA buffer.
 * @param {number} size   width = height in px
 * @param {'badge'|'flame'|'template'} style
 */
function render(size, style) {
  const fit = style === 'badge' ? 0.74 : 0.98;
  const { outer, inner, core } = buildFlame(fit);
  const px = 2 / size; // one pixel in normalised units
  const aa = 0.6 * px; // half-width of the anti-aliasing ramp
  const soft = Math.max(0.6, size * 0.004) * px; // feather for the inner layers
  const out = new Uint8Array(size * size * 4);
  const badgeR = 0.95;

  for (let row = 0; row < size; row++) {
    const y = 1 - (row + 0.5) * px;
    for (let col = 0; col < size; col++) {
      const x = (col + 0.5) * px - 1;
      const d0 = outer(x, y);
      const covOuter = smoothstep(aa, -aa, d0);

      let rgb = [0, 0, 0];
      let alpha;

      if (style === 'template') {
        // macOS template image: pure black, the shape lives in the alpha channel;
        // the inner flame is carved out at half opacity so the glyph keeps some depth.
        const covInner = smoothstep(aa, -aa, inner(x, y) + 0.06 * fit);
        alpha = covOuter * (1 - 0.55 * covInner);
      } else {
        const d1 = inner(x, y);
        const d2 = core(x, y);
        const covInner = smoothstep(soft, -soft, d1);
        const covCore = smoothstep(soft, -soft, d2);
        const ty = clamp((y + fit) / (2 * fit), 0, 1); // 0 bottom → 1 top of the flame box

        // Outer tongue: dark rim that warms to orange inwards and upwards.
        const depth = smoothstep(0, -0.2 * fit, d0);
        let flame = mix3(C.rim, mix3(C.body, C.bodyTop, ty), depth);
        flame = mix3(flame, [0.42, 0.03, 0.02], 0.55 * (1 - smoothstep(0.02, 0.3, ty)) * (1 - depth));
        // Inner tongue and bright core.
        const tyInner = clamp((y + 0.8 * fit) / (1.18 * fit), 0, 1);
        flame = mix3(flame, mix3(C.innerLow, C.innerHigh, tyInner), covInner);
        const tyCore = clamp((y + 0.72 * fit) / (0.66 * fit), 0, 1);
        flame = mix3(flame, mix3(C.coreLow, C.coreHigh, tyCore), covCore);

        if (style === 'badge') {
          const dBadge = Math.hypot(x, y) - badgeR;
          const covBadge = smoothstep(aa, -aa, dBadge);
          const tBadge = clamp((y + badgeR) / (2 * badgeR), 0, 1);
          let badge = mix3(C.badgeBottom, C.badgeTop, tBadge);
          // Warm glow bleeding out of the flame onto the badge.
          const glow = Math.exp(-Math.max(d0, 0) / (0.22 * fit)) * 0.5;
          badge = [
            clamp(badge[0] + C.glow[0] * glow, 0, 1),
            clamp(badge[1] + C.glow[1] * glow, 0, 1),
            clamp(badge[2] + C.glow[2] * glow, 0, 1),
          ];
          // Thin lighter rim so the disc reads on dark backgrounds too.
          const rim = smoothstep(aa, -aa, Math.abs(dBadge + 0.012) - 0.012) * 0.12;
          badge = [badge[0] + rim, badge[1] + rim * 0.8, badge[2] + rim * 0.9];
          // Straight-alpha "over": flame on top of the badge.
          alpha = covOuter + covBadge * (1 - covOuter);
          rgb =
            alpha > 0
              ? [
                  (flame[0] * covOuter + badge[0] * covBadge * (1 - covOuter)) / alpha,
                  (flame[1] * covOuter + badge[1] * covBadge * (1 - covOuter)) / alpha,
                  (flame[2] * covOuter + badge[2] * covBadge * (1 - covOuter)) / alpha,
                ]
              : badge;
        } else {
          rgb = flame;
          alpha = covOuter;
        }
      }

      const o = (row * size + col) * 4;
      out[o] = Math.round(clamp(rgb[0], 0, 1) * 255);
      out[o + 1] = Math.round(clamp(rgb[1], 0, 1) * 255);
      out[o + 2] = Math.round(clamp(rgb[2], 0, 1) * 255);
      out[o + 3] = Math.round(clamp(alpha, 0, 1) * 255);
    }
  }
  return out;
}

// ───────────────────────────── PNG encoder ─────────────────────────────
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Applies the PNG filter with the lowest sum of absolute values to each scanline. */
function filterScanlines(rgba, width, height) {
  const bpp = 4;
  const stride = width * bpp;
  const out = Buffer.alloc((stride + 1) * height);
  const candidates = Array.from({ length: 5 }, () => Buffer.alloc(stride));
  for (let row = 0; row < height; row++) {
    const line = rgba.subarray(row * stride, (row + 1) * stride);
    const prior = row > 0 ? rgba.subarray((row - 1) * stride, row * stride) : null;
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const buf = candidates[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prior ? prior[i] : 0;
        const c = prior && i >= bpp ? prior[i - bpp] : 0;
        let v;
        switch (f) {
          case 1:
            v = line[i] - a;
            break;
          case 2:
            v = line[i] - b;
            break;
          case 3:
            v = line[i] - ((a + b) >> 1);
            break;
          case 4:
            v = line[i] - paeth(a, b, c);
            break;
          default:
            v = line[i];
        }
        v &= 0xff;
        buf[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    out[row * (stride + 1)] = best;
    candidates[best].copy(out, row * (stride + 1) + 1);
  }
  return out;
}

function encodePng(rgba, width, height) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace
  const idat = deflateSync(filterScanlines(rgba, width, height), { level: 9 });
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ───────────────────────────── outputs ─────────────────────────────
/** @type {{ file: string, size: number, style: 'badge'|'flame'|'template' }[]} */
const OUTPUTS = [
  { file: 'icon.png', size: 512, style: 'badge' },
  { file: 'icon-256.png', size: 256, style: 'badge' },
  { file: 'tray/tray-16.png', size: 16, style: 'flame' },
  { file: 'tray/tray-32.png', size: 32, style: 'flame' },
  { file: 'tray/trayTemplate.png', size: 16, style: 'template' },
  { file: 'tray/trayTemplate@2x.png', size: 32, style: 'template' },
];

/** Contact sheet: every icon on a grey/checker background, small ones also magnified 8×. */
function renderPreview(rendered) {
  const cell = 160;
  const cols = rendered.length;
  const W = cell * cols;
  const H = cell * 2;
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const dark = y < cell;
      const checker = ((x >> 3) + (y >> 3)) & 1;
      const v = dark ? (checker ? 40 : 52) : checker ? 230 : 245;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
      rgba[o + 3] = 255;
    }
  }
  const blit = (src, size, ox, oy, scale) => {
    for (let y = 0; y < size * scale; y++) {
      for (let x = 0; x < size * scale; x++) {
        const s = (((y / scale) | 0) * size + ((x / scale) | 0)) * 4;
        const a = src[s + 3] / 255;
        if (a === 0) continue;
        const o = ((oy + y) * W + ox + x) * 4;
        for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(src[s + c] * a + rgba[o + c] * (1 - a));
      }
    }
  };
  rendered.forEach(({ size, pixels }, i) => {
    const scale = size <= 32 ? Math.floor(128 / size) : 1;
    const shown = Math.min(size, 128);
    const pad = Math.floor((cell - shown * (size <= 32 ? scale : 1)) / 2);
    if (size > 128) {
      // Nearest-neighbour downsample for the sheet only (the real file is untouched).
      const small = new Uint8Array(128 * 128 * 4);
      for (let y = 0; y < 128; y++)
        for (let x = 0; x < 128; x++) {
          const s = (Math.floor((y * size) / 128) * size + Math.floor((x * size) / 128)) * 4;
          small.set(pixels.subarray(s, s + 4), (y * 128 + x) * 4);
        }
      blit(small, 128, i * cell + pad, pad, 1);
      blit(small, 128, i * cell + pad, cell + pad, 1);
    } else {
      blit(pixels, size, i * cell + pad, pad, scale);
      blit(pixels, size, i * cell + pad, cell + pad, scale);
      // Also show it at 1:1 in the corner.
      blit(pixels, size, i * cell + 4, 4, 1);
      blit(pixels, size, i * cell + 4, cell + 4, 1);
    }
  });
  return encodePng(rgba, W, H);
}

const started = Date.now();
const rendered = OUTPUTS.map((o) => {
  const pixels = render(o.size, o.style);
  return { ...o, pixels, png: encodePng(pixels, o.size, o.size) };
});

let differences = 0;
for (const { file, png, size, style } of rendered) {
  const target = resolve(outDir, file);
  if (checkOnly) {
    const same = existsSync(target) && readFileSync(target).equals(png);
    if (!same) differences++;
    console.log(`${same ? 'ok     ' : 'DIFFERS'} ${file}`);
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, png);
  console.log(`wrote ${file}  ${size}×${size} ${style.padEnd(8)} ${png.length} bytes`);
}
if (previewPath) {
  const target = resolve(root, previewPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderPreview(rendered));
  console.log(`wrote preview ${target}`);
}
console.log(`[icons] ${checkOnly ? 'checked' : 'generated'} ${rendered.length} files in ${Date.now() - started} ms`);
if (differences > 0) {
  console.error(`[icons] ${differences} file(s) are out of date — run \`npm run icons\`.`);
  process.exit(1);
}
