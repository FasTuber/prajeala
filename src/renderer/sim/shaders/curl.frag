// Scalar vorticity ω = ∂v/∂x − ∂u/∂y (central differences, unit spacing).
uniform sampler2D uVelocity;
out vec4 outColor;

void main() {
  float L = decV(texture(uVelocity, vUv - vec2(uTexel.x, 0.0))).y;
  float R = decV(texture(uVelocity, vUv + vec2(uTexel.x, 0.0))).y;
  float B = decV(texture(uVelocity, vUv - vec2(0.0, uTexel.y))).x;
  float T = decV(texture(uVelocity, vUv + vec2(0.0, uTexel.y))).x;
  float curl = 0.5 * ((R - L) - (T - B));
  outColor = vec4(encS(curl, CURL_SCALE), 0.0, 0.0, 1.0);
}
