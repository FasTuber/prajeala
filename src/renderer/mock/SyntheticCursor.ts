/**
 * Deterministic Lissajous-style cursor path used by the standalone mock (when
 * the real mouse is idle) and by `--smoke` runs so frames always have content.
 */
import { noise1 } from '../util/noise';

export interface Point {
  x: number;
  y: number;
}

export class SyntheticCursor {
  constructor(private readonly seed = 0) {}

  /** Writes the position for time `t` (seconds) into `out`. */
  sample(t: number, width: number, height: number, out: Point): void {
    const s = this.seed;
    const cx = width * 0.5;
    const cy = height * 0.5;
    const ax = width * 0.36;
    const ay = height * 0.32;
    const wobbleX = (noise1(t * 0.7 + s, 11) - 0.5) * width * 0.12;
    const wobbleY = (noise1(t * 0.9 + s, 12) - 0.5) * height * 0.12;
    out.x = cx + ax * Math.sin(t * 1.1 + s) * Math.cos(t * 0.23) + wobbleX;
    out.y = cy + ay * Math.sin(t * 1.7 + 1.3 + s) + wobbleY;
  }
}
