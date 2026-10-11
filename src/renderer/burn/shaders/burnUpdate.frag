// One step of the burning-paper cellular automaton (a gather: each cell looks
// at its neighbours). Fire climbs faster than it creeps down or sideways, the
// fluid can set paper alight (cursor flames, bursts) and ignition points start
// new fronts. Built on common.glsl (uTexel = burn-map texel, decT/sampleTex for
// the fluid temperature).
uniform sampler2D uBurn;
uniform sampler2D uTemperature;
uniform float uDt;
uniform float uTime;
uniform float uSpread;      // ignitions per second for a fully surrounded cell
uniform float uBurnTime;    // seconds from "caught" to ash
uniform float uSweep;       // 0..1 end-of-burn sweep: leftover paper catches everywhere
uniform float uHeatIgnite;  // fluid temperature that lights the paper (> 1 disables)
uniform float uAspect;
uniform vec4 uIgnite[8];    // x, y (UV), radius (screen heights), unused
uniform int uIgniteCount;
out vec4 outColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// 1 for cells that are burning right now (caught, not yet ash).
float lit(vec2 uv) {
  float r = texture(uBurn, uv).r;
  return step(0.5, r) * step(r, 0.97);
}

void main() {
  vec4 c = texture(uBurn, vUv);
  float r = c.r;
  float resistance = max(c.g, 0.05);
  float scorch = c.b;
  vec2 tx = uTexel;

  if (r < 0.5) {
    float below = lit(vUv - vec2(0.0, tx.y));
    float above = lit(vUv + vec2(0.0, tx.y));
    float side = lit(vUv - vec2(tx.x, 0.0)) + lit(vUv + vec2(tx.x, 0.0));
    float diag = lit(vUv - tx) + lit(vUv + vec2(tx.x, -tx.y));
    float heat = 0.45 * below + 0.22 * side + 0.18 * above + 0.1 * diag;

    float rnd = hash12(vUv * 1931.7 + vec2(fract(uTime * 7.31), fract(uTime * 3.17)) * 97.0);
    // Towards the end the fronts speed up (sweep) so the whole sheet is gone in time.
    float spread = uSpread * (1.0 + 3.0 * uSweep);
    bool catches = heat > 0.0 && rnd < spread * uDt * heat / resistance;

    // Two-way coupling: hot fluid (cursor fire, bursts, other flames) lights the paper.
    float t = decT(texture(uTemperature, vUv)).x;
    catches = catches || t > uHeatIgnite;

    for (int i = 0; i < 8; i++) {
      if (i >= uIgniteCount) break;
      vec4 ig = uIgnite[i];
      vec2 d = (vUv - ig.xy) * vec2(uAspect, 1.0);
      if (dot(d, d) < ig.z * ig.z) catches = true;
    }
    // Very end: isolated leftovers catch on their own, so the show always finishes.
    float late = max(0.0, uSweep - 0.6) / 0.4;
    catches = catches || hash12(vUv * 733.1 + uTime) < late * late * uDt * 3.0;

    // Paper browns ahead of the front.
    scorch = min(1.0, scorch + uDt * heat * 1.4);
    if (catches) {
      r = 0.5;
    } else {
      r = min(0.49, r + uDt * heat * 0.5);
    }
  } else if (r < 1.0) {
    // Burning → char → ash. Never slower than one 8-bit step per frame.
    r = min(1.0, r + max(uDt / uBurnTime * 0.5, 1.5 / 255.0));
  }
  outColor = vec4(r, c.g, scorch, 1.0);
}
