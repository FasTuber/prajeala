// Procedural "fire cursor": three noise-driven flame tongues rooted just below
// the cursor, leaning away from the direction of travel, plus a hot core.
// Premultiplied output; drawn on top of the fluid, under the OS cursor.
// (precision is declared by the prelude chunk in FireCursor.ts)
in vec2 vLocal;
uniform sampler2D uLut;
uniform float uTime;
uniform vec2 uLean;      // (x right, y up); flames are sheared by this
uniform float uIntensity;
uniform float uSeed;
out vec4 outColor;

float tongue(vec2 p, float k) {
  float phase = k * 3.7 + uSeed;
  float h = p.y + 0.55;          // 0 at the root
  if (h < 0.0) return 0.0;
  // shear with height: lean sideways, stretch/compress vertically
  p.x -= uLean.x * h * 0.9;
  h *= 1.0 - clamp(uLean.y, -0.6, 0.6) * 0.6;
  float n = fbm(vec2(p.x * 2.6 + phase * 5.0, h * 1.8 - uTime * (2.6 + 0.4 * k)));
  float width = 0.30 * (1.0 - smoothstep(0.0, 1.55, h)) * (0.7 + 0.6 * n);
  float sway = (n - 0.5) * 0.35 * h;
  float x = p.x - sway;
  float body = 1.0 - abs(x) / max(width, 1e-3);
  float tip = 1.0 - smoothstep(0.45, 1.5, h + (n - 0.5) * 0.7);
  return clamp(body, 0.0, 1.0) * tip;
}

void main() {
  vec2 p = vLocal;
  float f = tongue(p, 0.0);
  f = max(f, tongue(p - vec2(-0.30, -0.06), 1.0) * 0.85);
  f = max(f, tongue(p - vec2(0.32, -0.10), 2.0) * 0.8);
  f = max(f, tongue(p - vec2(0.06, -0.18), 3.0) * 0.6);
  // Hot base that merges the tongues, plus a bright core at the cursor itself.
  vec2 pb = (p - vec2(0.0, -0.3)) * vec2(1.0, 1.7);
  float base = exp(-dot(pb, pb) * 4.5);
  float core = exp(-dot(p, p) * 10.0);
  float t = clamp(f * f * 1.1 + base * 0.8 + core * 0.9, 0.0, 1.0) * uIntensity;
  vec3 col = texture(uLut, vec2(t, 0.5)).rgb;
  col *= 1.0 + 0.4 * smoothstep(0.6, 1.0, t);
  float bright = max(col.r, max(col.g, col.b));
  float alpha = smoothstep(0.06, 0.45, t) * clamp(bright * 1.3, 0.0, 1.0);
  vec3 rgb = min(col * alpha, vec3(1.0));
  outColor = vec4(rgb, max(alpha, max(rgb.r, max(rgb.g, rgb.b))));
}
