// One Jacobi iteration of ∇²p = ∇·v.
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
out vec4 outColor;

void main() {
  float L = decS(texture(uPressure, vUv - vec2(uTexel.x, 0.0)).r, P_SCALE);
  float R = decS(texture(uPressure, vUv + vec2(uTexel.x, 0.0)).r, P_SCALE);
  float B = decS(texture(uPressure, vUv - vec2(0.0, uTexel.y)).r, P_SCALE);
  float T = decS(texture(uPressure, vUv + vec2(0.0, uTexel.y)).r, P_SCALE);
  float div = decS(texture(uDivergence, vUv).r, DIV_SCALE);
  float p = (L + R + B + T - div) * 0.25;
  outColor = vec4(encS(p, P_SCALE), 0.0, 0.0, 1.0);
}
