// Screen-space quad centred on the cursor. vLocal ∈ [-1,1]², y up.
in vec2 aPosition;
uniform vec2 uCenter; // clip space
uniform vec2 uSize;   // half extents in clip units
out vec2 vLocal;
void main() {
  vLocal = aPosition;
  gl_Position = vec4(uCenter + aPosition * uSize, 0.0, 1.0);
}
