// Adds up to MAX_SPLATS gaussian splats to the velocity (SPLAT_VELOCITY) or
// temperature target in one full-screen pass.
//
// heat >= 0: additive impulse (trail segments, bursts).
// heat <  0: "source" semantics, t = max(t, |heat|·w): steady emitters set a
//            target temperature instead of accumulating, which makes them
//            frame-rate independent and impossible to over-saturate.
//            Sources are swept along the local flow for one frame (see below).
uniform sampler2D uTarget;
uniform vec2 uAspect;           // (W/H, 1): distances measured in screen heights
uniform int uCount;
uniform vec4 uSplatA[MAX_SPLATS]; // x, y (uv), radius (heights), radial impulse (heights/s)
uniform vec4 uSplatB[MAX_SPLATS]; // heat, smoke, vx, vy (heights/s)
#ifndef SPLAT_VELOCITY
uniform sampler2D uVelocity;    // heights/s
uniform float uDt;
#endif
out vec4 outColor;

void main() {
  vec4 src = texture(uTarget, vUv);
#ifdef SPLAT_VELOCITY
  vec2 v = decV(src);
#else
  vec2 t = decT(src);
  // A source emits for the whole frame, so the fluid that passed over it during
  // that time ends up spread along [p, p + v·dt]. Heat this fragment when the
  // segment it travelled, [x - v·dt, x], passes near the source. Without the sweep
  // a fast plume (low fps, high intensity) turns into a stack of separate puffs.
  vec2 sweep = decV(sampleTex(uVelocity, vUv)) * uDt;
  float sweep2 = max(dot(sweep, sweep), 1e-12);
#endif
  for (int i = 0; i < MAX_SPLATS; i++) {
    if (i >= uCount) break;
    vec4 a = uSplatA[i];
    vec4 b = uSplatB[i];
    vec2 d = (vUv - a.xy) * uAspect;
    float r2 = a.z * a.z;
#ifdef SPLAT_VELOCITY
    float d2 = dot(d, d);
#else
    float d2 = dot(d, d);
    if (b.x < 0.0) {
      vec2 q = d - sweep;
      vec2 c = q + sweep * clamp(dot(-q, sweep) / sweep2, 0.0, 1.0);
      d2 = dot(c, c);
    }
#endif
    if (d2 > r2 * 5.0) continue;
    float w = exp(-2.0 * d2 / r2);
#ifdef SPLAT_VELOCITY
    float dist = sqrt(d2);
    vec2 radial = a.w * (d / max(dist, 1e-5)) * smoothstep(0.0, a.z * 0.7, dist);
    v += (b.zw + radial) * w;
#else
    if (b.x < 0.0) {
      t = max(t, vec2(-b.x, b.y) * w);
    } else {
      t += b.xy * w;
    }
#endif
  }
#ifdef SPLAT_VELOCITY
  outColor = encV(v);
#else
  outColor = encT(t);
#endif
}
