/** Tiny vector helpers for the hot paths (Math.hypot is variadic and slow in V8). */

/** Length of (x, y). */
export function hyp(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}
