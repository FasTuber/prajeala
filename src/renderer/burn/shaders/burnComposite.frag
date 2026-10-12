// Draws the burning snapshot UNDER the fire composite (premultiplied alpha):
// intact paper (with heat haze and scorch), an emissive rim at the front, a
// charred band with dying embers that crumbles into nothing, revealing the live
// desktop. Built on common.glsl (uTexel = fluid texel) + noise.glsl.
uniform sampler2D uBurn;
uniform sampler2D uSnapshot;
uniform sampler2D uTemperature;
uniform sampler2D uLut;
uniform vec4 uImageRect;   // where the picture sits, UV y up (x0, y0, x1, y1)
uniform float uTime;
uniform float uFade;       // 1 while burning → 0 at the end
uniform float uAspect;
out vec4 outColor;

void main() {
  vec4 c = texture(uBurn, vUv);
  float r = c.r;
  if (r >= 0.985 || uFade <= 0.0) {
    outColor = vec4(0.0);
    return;
  }
  vec2 span = max(uImageRect.zw - uImageRect.xy, vec2(1e-5));
  vec2 suv = (vUv - uImageRect.xy) / span;
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) {
    outColor = vec4(0.0);
    return;
  }
  // Heat haze: the picture wobbles where the fluid is hot.
  float tC = decT(sampleTex(uTemperature, vUv)).x;
  float tR = decT(sampleTex(uTemperature, vUv + vec2(uTexel.x * 1.5, 0.0))).x;
  float tU = decT(sampleTex(uTemperature, vUv + vec2(0.0, uTexel.y * 1.5))).x;
  vec2 haze = vec2(tR - tC, tU - tC) * 0.012 + vec2(vnoise(vUv * 40.0 + uTime * 2.0) - 0.5, 0.0) * 0.002 * tC;
  vec2 img = clamp(suv + haze, 0.0, 1.0);
  img.y = 1.0 - img.y; // pictures are stored top row first
  vec3 picture = texture(uSnapshot, img).rgb;

  vec3 col;
  float alpha = 1.0;
  if (r < 0.5) {
    float heating = r * 2.0;
    float s = clamp(c.b * 0.85 + heating * 0.5, 0.0, 1.0);
    float lum = dot(picture, vec3(0.299, 0.587, 0.114));
    vec3 brown = vec3(0.36, 0.2, 0.08) * (0.35 + lum) + vec3(0.05, 0.025, 0.01);
    col = mix(picture, brown, smoothstep(0.2, 1.0, s));
    // the last moment before catching: glowing paper
    col += texture(uLut, vec2(0.55 + 0.35 * heating, 0.5)).rgb * smoothstep(0.7, 1.0, heating) * 0.55;
  } else {
    float k = (r - 0.5) * 2.0; // 0 just caught → 1 ash
    float n = c.g;
    float rim = 1.0 - smoothstep(0.0, 0.16 + 0.1 * n, k);
    vec3 fire = texture(uLut, vec2(0.72 + 0.28 * rim, 0.5)).rgb * (1.2 + 0.6 * rim);
    float lum = dot(picture, vec3(0.299, 0.587, 0.114));
    vec2 p = vUv * vec2(uAspect, 1.0);
    // Screen-space grain so edges and embers are finer than the quarter-res burn map.
    float grain = vnoise(p * 260.0);
    vec3 charred = vec3(0.025, 0.02, 0.018) + vec3(lum * 0.09) * (0.7 + 0.6 * grain);
    // embers glowing in the char, slowly pulsing
    float glowSpots = smoothstep(0.55, 0.85, vnoise(p * 70.0 + vec2(0.0, uTime * 0.25)));
    float pulse = 0.65 + 0.35 * sin(uTime * 3.0 + grain * 12.0);
    float sparkle = glowSpots * smoothstep(0.35, 0.8, grain) * pulse;
    vec3 ember = texture(uLut, vec2(0.6 + 0.25 * sparkle, 0.5)).rgb * sparkle * (1.0 - k) * 1.3;
    col = mix(charred + ember, fire, rim);
    // crumbles away with a ragged, grainy edge
    float edge = 0.48 + 0.22 * n + 0.18 * grain;
    alpha = 1.0 - smoothstep(edge, edge + 0.12, k);
  }
  alpha *= uFade;
  outColor = vec4(min(col, vec3(1.6)) * alpha, alpha);
}
