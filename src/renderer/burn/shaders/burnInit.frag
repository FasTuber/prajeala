// Burn map initialisation. Channels: r = progress (0 intact … 0.5 caught fire …
// 1 ash/gone), g = per-cell resistance (ragged fronts), b = scorch, a = 1.
// Cells outside the burn rectangle start as "gone" so only that region shows.
// Built on common.glsl + noise.glsl.
uniform vec4 uRect;   // burn rect in UV (x0, y0, x1, y1), y up
uniform float uAspect;
uniform float uSeed;
out vec4 outColor;

void main() {
  bool inside = vUv.x >= uRect.x && vUv.x <= uRect.z && vUv.y >= uRect.y && vUv.y <= uRect.w;
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  float n = fbm(p * 7.0 + uSeed) * 0.75 + vnoise(p * 41.0 + uSeed * 3.1) * 0.35;
  float resistance = clamp(0.3 + n, 0.3, 1.0);
  outColor = vec4(inside ? 0.0 : 1.0, resistance, 0.0, 1.0);
}
