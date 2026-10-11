// Shared prelude for every simulation fragment shader.
//
// Field layout
//   velocity     RG   (x right, y up) in "screen heights per second"
//   temperature  RG   (r = heat 0..1, g = smoke 0..1)
//   pressure / divergence / curl: R, signed
//
// BYTE_MODE: 8-bit textures; signed values are stored as 0..1 ↔ -S..S.
// MANUAL_BILINEAR: textures are NEAREST-filtered, sampleTex() interpolates by hand.
precision highp float;
precision highp sampler2D;

in vec2 vUv;
uniform vec2 uTexel; // 1 / simulation size

const float VEL_SCALE = 4.0;
const float P_SCALE = 2.0;
const float DIV_SCALE = 2.0;
const float CURL_SCALE = 4.0;
const float VEL_MAX = 3.9;

#ifdef BYTE_MODE
vec2 decV(vec4 c) { return (c.rg * 2.0 - 1.0) * VEL_SCALE; }
vec4 encV(vec2 v) { return vec4(clamp(v / VEL_SCALE * 0.5 + 0.5, 0.0, 1.0), 0.0, 1.0); }
float decS(float c, float s) { return (c * 2.0 - 1.0) * s; }
float encS(float v, float s) { return clamp(v / s * 0.5 + 0.5, 0.0, 1.0); }
#else
vec2 decV(vec4 c) { return c.rg; }
vec4 encV(vec2 v) { return vec4(clamp(v, -VEL_MAX, VEL_MAX), 0.0, 1.0); }
float decS(float c, float s) { return c; }
float encS(float v, float s) { return v; }
#endif

vec2 decT(vec4 c) { return c.rg; }
vec4 encT(vec2 t) { return vec4(clamp(t, 0.0, 1.0), 0.0, 1.0); }

#ifdef MANUAL_BILINEAR
vec4 sampleTex(sampler2D s, vec2 uv) {
  vec2 st = uv / uTexel - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec2 base = (i + 0.5) * uTexel;
  vec4 a = texture(s, base);
  vec4 b = texture(s, base + vec2(uTexel.x, 0.0));
  vec4 c = texture(s, base + vec2(0.0, uTexel.y));
  vec4 d = texture(s, base + uTexel);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
#else
vec4 sampleTex(sampler2D s, vec2 uv) { return texture(s, uv); }
#endif
