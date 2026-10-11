// Final pass: temperature → palette LUT with upward-scrolling fbm detail,
// soft glow halo and faint smoke. Output is PREMULTIPLIED alpha over a
// transparent canvas. Built on top of common.glsl (uTexel = sim texel).
uniform sampler2D uTemperature; // simulation field (r = heat, g = smoke)
uniform sampler2D uGlow;        // blurred heat
uniform sampler2D uLut;         // 256×1 palette
uniform float uTime;
uniform float uAspect;   // W/H
uniform float uDetail;   // 0..1 noise erosion strength
uniform float uGlow_;    // glow strength
uniform float uSmoke;    // smoke opacity
uniform int uView;       // debug: 0 normal, 1 heat, 2 smoke, 3 glow
uniform float uDark;     // Mod Torță: darkness over the desktop (0 = off)
uniform vec3 uTorch;     // torch centre (uv) and radius (screen heights); radius 0 = no torch
out vec4 outColor;

void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  // Two noise fields scrolling upward at different speeds: large tongues + fine licks.
  float n1 = fbm(p * 5.0 + vec2(0.0, -uTime * 0.75));
  float n2 = fbm(p * 12.0 + vec2(3.7, -uTime * 1.6));

  float heat0 = sampleTex(uTemperature, vUv).r;
  // Distort the field lookup so edges flicker instead of staying blobby.
  vec2 dist = (vec2(n2, n1) - 0.47) * (0.09 * uDetail) * (1.0 - heat0 * 0.5);
  vec2 field = sampleTex(uTemperature, clamp(vUv + dist, 0.0, 1.0)).rg;
  float heat = field.r;
  float smoke = field.g;

  float n = mix(n1, n2, 0.45);
  // Erode cool fringes into tongues, keep hot cores solid.
  float t = heat * (0.9 + 0.7 * n) - (1.0 - heat) * (0.7 * uDetail) * n;
  t = clamp(t, 0.0, 1.0);

  vec3 col = texture(uLut, vec2(t, 0.5)).rgb;
  col *= 1.0 + 0.5 * smoothstep(0.55, 1.0, t);
  // Opacity follows brightness so dim fringes tint rather than darken the desktop.
  float bright = max(col.r, max(col.g, col.b));
  float alpha = smoothstep(0.04, 0.35, t) * clamp(bright * 1.3, 0.0, 1.0);
  vec3 rgb = col * alpha;

  // Glow halo from the blurred heat field (always brightens: orange-ish, additive-like).
  float g = texture(uGlow, vUv).r;
  float ga = uGlow_ * smoothstep(0.0, 0.5, g) * (1.0 - alpha);
  vec3 gcol = texture(uLut, vec2(clamp(0.4 + g * 0.5, 0.0, 1.0), 0.5)).rgb;
  rgb += gcol * ga;
  alpha += ga * max(gcol.r, max(gcol.g, gcol.b));

  // Faint smoke trailing the flames.
  float sa = uSmoke * smoothstep(0.02, 0.7, smoke) * (1.0 - alpha);
  rgb += vec3(0.07, 0.06, 0.06) * sa;
  alpha += sa;

  // Mod Torță: everything is dark except what the torch and the fires light up.
  if (uDark > 0.0) {
    float flick = 0.93 + 0.07 * fbm(vec2(uTime * 2.3, 1.7));
    vec2 d = vec2((vUv.x - uTorch.x) * uAspect, vUv.y - uTorch.y);
    float r = uTorch.z * flick;
    float lit = uTorch.z > 0.0 ? 1.0 - smoothstep(r * 0.5, r, length(d)) : 0.0;
    lit = max(lit, smoothstep(0.03, 0.5, g) * 0.9 + smoothstep(0.05, 0.4, heat) * 0.6);
    lit = clamp(lit, 0.0, 1.0);
    // A warm fringe where the light fades into the dark.
    float fringe = lit * (1.0 - lit) * 4.0;
    vec3 warm = vec3(0.32, 0.12, 0.02) * fringe * uDark * 0.2;
    float shade = uDark * (1.0 - lit) * (1.0 - alpha);
    rgb += warm * (1.0 - alpha);
    alpha += shade + max(warm.r, max(warm.g, warm.b)) * (1.0 - alpha);
  }

  rgb = min(rgb, vec3(1.0));
  alpha = clamp(max(alpha, max(rgb.r, max(rgb.g, rgb.b))), 0.0, 1.0);
  outColor = vec4(rgb, alpha);

  if (uView != 0) {
    float v = uView == 1 ? heat0 : uView == 2 ? sampleTex(uTemperature, vUv).g : g;
    outColor = vec4(vec3(v), 1.0);
  }
}
