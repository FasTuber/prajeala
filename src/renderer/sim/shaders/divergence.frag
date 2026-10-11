// ∇·v with central differences; edges clamp (free outflow).
uniform sampler2D uVelocity;
out vec4 outColor;

void main() {
  float L = decV(texture(uVelocity, vUv - vec2(uTexel.x, 0.0))).x;
  float R = decV(texture(uVelocity, vUv + vec2(uTexel.x, 0.0))).x;
  float B = decV(texture(uVelocity, vUv - vec2(0.0, uTexel.y))).y;
  float T = decV(texture(uVelocity, vUv + vec2(0.0, uTexel.y))).y;
  float div = 0.5 * (R - L + T - B);
  outColor = vec4(encS(div, DIV_SCALE), 0.0, 0.0, 1.0);
}
