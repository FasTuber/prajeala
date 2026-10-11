// Vorticity confinement (swirl) + buoyancy (hot cells rise), applied to velocity.
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform sampler2D uTemperature;
uniform float uDt;
uniform float uCurlStrength;
uniform float uBuoyancy;
uniform float uMaxSpeed; // heights per second
out vec4 outColor;

void main() {
  float L = abs(decS(texture(uCurl, vUv - vec2(uTexel.x, 0.0)).r, CURL_SCALE));
  float R = abs(decS(texture(uCurl, vUv + vec2(uTexel.x, 0.0)).r, CURL_SCALE));
  float B = abs(decS(texture(uCurl, vUv - vec2(0.0, uTexel.y)).r, CURL_SCALE));
  float T = abs(decS(texture(uCurl, vUv + vec2(0.0, uTexel.y)).r, CURL_SCALE));
  float C = decS(texture(uCurl, vUv).r, CURL_SCALE);

  // N = ∇|ω| / |∇|ω||,  force = ε (N × ω) = ε ω (N.y, −N.x)
  vec2 grad = 0.5 * vec2(R - L, T - B);
  vec2 N = grad / (length(grad) + 1e-5);
  vec2 force = uCurlStrength * C * vec2(N.y, -N.x);

  vec2 v = decV(texture(uVelocity, vUv));
  v += force * uDt;

  vec2 t = decT(texture(uTemperature, vUv));
  v.y += uBuoyancy * (t.x + 0.15 * t.y) * uDt;

  // Soft speed limit: keeps steady plumes from turning into chimneys.
  float speed = length(v);
  v *= min(1.0, uMaxSpeed / max(speed, 1e-5));

  outColor = encV(v);
}
