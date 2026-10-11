// Feeds the burn front into the fluid simulation: freshly caught cells become
// heat sources and lift the air above them; charring cells give off smoke.
// BURN_VELOCITY selects the velocity pass. Built on common.glsl.
uniform sampler2D uTarget;
uniform sampler2D uBurn;
uniform float uStrength; // 0..1 (fades with the burn)
uniform float uDt;
uniform float uLift;     // upward acceleration at the rim, heights/s²
out vec4 outColor;

void main() {
  vec4 b = texture(uBurn, vUv);
  float r = b.r;
  float rim = step(0.5, r) * (1.0 - smoothstep(0.52, 0.72, r));
  float charring = smoothstep(0.6, 0.75, r) * (1.0 - smoothstep(0.85, 0.97, r));
  vec4 src = texture(uTarget, vUv);
#ifdef BURN_VELOCITY
  vec2 v = decV(src);
  v.y += rim * uLift * uDt * uStrength;
  outColor = encV(v);
#else
  vec2 t = decT(src);
  t.x = max(t.x, rim * (0.75 + 0.25 * b.g) * uStrength);
  t.y = max(t.y, charring * 0.35 * uStrength);
  outColor = encT(t);
#endif
}
