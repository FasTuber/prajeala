// Projection: v −= ∇p, which makes the velocity field divergence-free.
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
out vec4 outColor;

void main() {
  float L = decS(texture(uPressure, vUv - vec2(uTexel.x, 0.0)).r, P_SCALE);
  float R = decS(texture(uPressure, vUv + vec2(uTexel.x, 0.0)).r, P_SCALE);
  float B = decS(texture(uPressure, vUv - vec2(0.0, uTexel.y)).r, P_SCALE);
  float T = decS(texture(uPressure, vUv + vec2(0.0, uTexel.y)).r, P_SCALE);
  vec2 v = decV(texture(uVelocity, vUv));
  v -= 0.5 * vec2(R - L, T - B);
  outColor = encV(v);
}
