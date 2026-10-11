// Separable 9-tap gaussian (5 fetches using linear filtering) for the glow halo.
precision highp float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform vec2 uDirection; // texel size along the blur axis
out vec4 outColor;

void main() {
  vec4 c = texture(uTexture, vUv) * 0.2270270270;
  vec2 o1 = uDirection * 1.3846153846;
  vec2 o2 = uDirection * 3.2307692308;
  c += (texture(uTexture, vUv + o1) + texture(uTexture, vUv - o1)) * 0.3162162162;
  c += (texture(uTexture, vUv + o2) + texture(uTexture, vUv - o2)) * 0.0702702703;
  outColor = c;
}
