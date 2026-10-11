// Sparks: each particle contributes two vertices (tail, head). LINES draw both,
// POINTS draw only the heads via a second VAO with a 32-byte stride.
in vec2 aPosition; // CSS px, y down
in vec2 aData;     // life (1 → fresh, 0 → dead), head flag (0 tail, 1 head)
uniform vec2 uResolution; // CSS px
uniform float uPointSize; // device px
out float vLife;
out float vHead;
void main() {
  vec2 clip = (aPosition / uResolution) * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
  vLife = aData.x;
  vHead = aData.y;
  gl_PointSize = uPointSize * (0.45 + 0.55 * aData.x);
}
