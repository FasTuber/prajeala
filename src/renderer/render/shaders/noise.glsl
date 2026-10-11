// Integer-hashed value noise + fbm. Hashing on integer lattice coordinates keeps
// the noise stable for large (time-scrolled) inputs where float hashes break up.
float hashLattice(ivec2 p) {
  uvec2 u = uvec2(p + ivec2(0x40000));
  uint h = u.x * 374761393u + u.y * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h ^= h >> 16u;
  return float(h & 0x00ffffffu) / 16777216.0;
}

float vnoise(vec2 p) {
  vec2 fl = floor(p);
  vec2 f = p - fl;
  f = f * f * (3.0 - 2.0 * f);
  ivec2 i = ivec2(fl);
  float a = hashLattice(i);
  float b = hashLattice(i + ivec2(1, 0));
  float c = hashLattice(i + ivec2(0, 1));
  float d = hashLattice(i + ivec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// 2-octave fbm on a rotated lattice in roughly [0, 0.75]; cheap enough for simulation passes.
float fbm2(vec2 p) {
  mat2 m = mat2(0.87, 0.48, -0.48, 0.87); // ~29° so lattice rows never align with the screen
  p = m * p;
  float v = 0.5 * vnoise(p);
  p = mat2(1.6, 1.2, -1.2, 1.6) * p;
  v += 0.25 * vnoise(p);
  return v;
}

// 4-octave fbm in roughly [0, 0.94].
float fbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++) {
    v += amp * vnoise(p);
    p = m * p;
    amp *= 0.5;
  }
  return v;
}
