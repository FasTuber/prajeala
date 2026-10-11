// Semi-Lagrangian advection of velocity (ADVECT_VELOCITY) or temperature,
// with per-frame dissipation (pow(k, dt), computed on the CPU) and, for the
// temperature field, a noise-modulated linear cooling that makes flame tips
// ragged and keeps the heat from living for ever.
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform float uDt;
uniform vec2 uAspectInv;   // (H/W, 1): heights/s → uv/s
uniform vec2 uDissipation; // per-frame multipliers for the two channels
uniform float uEps;        // minimum per-frame decay (defeats 8-bit quantisation stalls)
uniform float uCooling;    // temperature units per second
uniform float uTime;
uniform float uAspect;     // W/H
out vec4 outColor;

void main() {
  vec2 vel = decV(sampleTex(uVelocity, vUv));
  vec2 coord = vUv - uDt * vel * uAspectInv;
  // Open boundaries: anything advected in from outside the screen is cold air.
  float inside = step(0.0, coord.x) * step(coord.x, 1.0) * step(0.0, coord.y) * step(coord.y, 1.0);
  coord = clamp(coord, uTexel * 0.5, 1.0 - uTexel * 0.5);
#ifdef ADVECT_VELOCITY
  vec2 v = decV(sampleTex(uSource, coord)) * uDissipation.x;
  v -= sign(v) * min(abs(v), vec2(uEps));
  outColor = encV(v);
#else
  vec2 t = decT(sampleTex(uSource, coord)) * uDissipation * inside;
  float n = fbm2(vec2(vUv.x * uAspect, vUv.y) * 9.0 + vec2(uTime * 0.25, -uTime * 0.9)); // ≈ 0..0.75
  float cool = uCooling * uDt * (0.5 + 1.3 * n);
  t.x = max(t.x - cool - uEps, 0.0);
  t.y = max(t.y - uEps, 0.0);
  outColor = encT(t);
#endif
}
