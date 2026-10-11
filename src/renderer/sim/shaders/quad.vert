// Full-screen triangle-strip quad; vUv in [0,1]² with (0,0) at the bottom-left.
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
