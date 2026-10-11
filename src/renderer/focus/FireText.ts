/**
 * Turns a short string into a cloud of points so the fire can write it:
 * the text is drawn once on a small 2D canvas and sampled on a grid. Points
 * are centred and expressed in units of the text height. Results are cached.
 */

export interface FireGlyphs {
  /** x, y pairs (text-height units, centred on 0,0, y down). */
  points: Float32Array;
  count: number;
  /** Grid step in text-height units (handy as a splat radius). */
  step: number;
  /** Width / height of the inked area. */
  aspect: number;
}

const RASTER_HEIGHT = 72;
const EMPTY: FireGlyphs = { points: new Float32Array(0), count: 0, step: 0.1, aspect: 1 };

export class FireText {
  private readonly cache = new Map<string, FireGlyphs>();
  private canvas: HTMLCanvasElement | null = null;

  constructor(private readonly maxPoints = 110) {}

  get(text: string): FireGlyphs {
    const hit = this.cache.get(text);
    if (hit) return hit;
    const glyphs = this.rasterize(text);
    if (this.cache.size > 24) this.cache.clear();
    this.cache.set(text, glyphs);
    return glyphs;
  }

  private rasterize(text: string): FireGlyphs {
    if (!text || typeof document === 'undefined') return EMPTY;
    const canvas = (this.canvas ??= document.createElement('canvas'));
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) return EMPTY;
    const font = `900 ${RASTER_HEIGHT}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
    g.font = font;
    const w = Math.ceil(g.measureText(text).width) + 8;
    const h = Math.ceil(RASTER_HEIGHT * 1.25);
    canvas.width = Math.max(1, w);
    canvas.height = h;
    g.font = font; // resizing resets the context state
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    g.fillText(text, w / 2, h / 2);
    const data = g.getImageData(0, 0, w, h).data;
    const inked = (x: number, y: number): boolean => (data[(y * w + x) * 4 + 3] ?? 0) > 140;

    // Coarsen the grid until the glyph fits the splat budget.
    for (let step = 4; step <= 24; step += 2) {
      const pts: number[] = [];
      let minX = Infinity;
      let maxX = -Infinity;
      for (let y = step >> 1; y < h; y += step) {
        for (let x = step >> 1; x < w; x += step) {
          if (!inked(x, y)) continue;
          pts.push(x, y);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
      const count = pts.length / 2;
      if (count > this.maxPoints) continue;
      if (count === 0) return EMPTY;
      const points = new Float32Array(pts.length);
      const cx = (minX + maxX) / 2;
      for (let i = 0; i < pts.length; i += 2) {
        points[i] = ((pts[i] ?? 0) - cx) / RASTER_HEIGHT;
        points[i + 1] = ((pts[i + 1] ?? 0) - h / 2) / RASTER_HEIGHT;
      }
      return { points, count, step: step / RASTER_HEIGHT, aspect: (maxX - minX + step) / RASTER_HEIGHT };
    }
    return EMPTY;
  }
}
