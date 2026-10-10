// Shader sources are bundled as plain strings by esbuild (see scripts/build.mjs).
declare module '*.glsl' {
  const source: string;
  export default source;
}
declare module '*.frag' {
  const source: string;
  export default source;
}
declare module '*.vert' {
  const source: string;
  export default source;
}
