// Premultiplied additive sparks: white-hot when fresh, palette colour as they fade.
precision mediump float;
in float vLife;
in float vHead;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  float a = vLife * vLife;
#ifdef POINTS
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d) * 4.0;
  a *= 1.0 - smoothstep(0.15, 1.0, r);
#else
  a *= vHead * 0.7;
#endif
  vec3 col = mix(uColor, vec3(1.0, 0.97, 0.9), 0.55 * vLife * vLife);
  outColor = vec4(col * a, a);
}
