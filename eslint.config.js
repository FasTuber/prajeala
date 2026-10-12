// ESLint flat config (ESM). Type-aware linting is intentionally off to keep
// `npm run lint` fast; `npm run typecheck` covers the type-level checks.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// Hand-written global sets (no `globals` package needed). ES built-ins come
// from `ecmaVersion`, so only host-specific names are listed here.
const nodeGlobals = Object.fromEntries(
  [
    'process',
    'Buffer',
    'console',
    'global',
    'globalThis',
    'require',
    'module',
    'exports',
    '__dirname',
    '__filename',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'setImmediate',
    'clearImmediate',
    'queueMicrotask',
    'structuredClone',
    'performance',
    'URL',
    'URLSearchParams',
    'TextEncoder',
    'TextDecoder',
    'AbortController',
    'AbortSignal',
    'fetch',
    'Request',
    'Response',
    'Headers',
    'Blob',
    'crypto',
    'navigator',
  ].map((name) => [name, 'readonly']),
);

const browserGlobals = Object.fromEntries(
  [
    'window',
    'document',
    'navigator',
    'location',
    'console',
    'self',
    'globalThis',
    'performance',
    'screen',
    'devicePixelRatio',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'requestIdleCallback',
    'cancelIdleCallback',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'queueMicrotask',
    'structuredClone',
    'URL',
    'URLSearchParams',
    'TextEncoder',
    'TextDecoder',
    'AbortController',
    'AbortSignal',
    'fetch',
    'Request',
    'Response',
    'Headers',
    'Blob',
    'crypto',
    'Image',
    'ImageData',
    'ImageBitmap',
    'createImageBitmap',
    'OffscreenCanvas',
    'HTMLElement',
    'HTMLCanvasElement',
    'HTMLDivElement',
    'HTMLInputElement',
    'HTMLSelectElement',
    'HTMLButtonElement',
    'CanvasRenderingContext2D',
    'WebGLRenderingContext',
    'WebGL2RenderingContext',
    'WebGLProgram',
    'WebGLShader',
    'WebGLTexture',
    'WebGLFramebuffer',
    'WebGLBuffer',
    'WebGLVertexArrayObject',
    'WebGLUniformLocation',
    'ResizeObserver',
    'MutationObserver',
    'IntersectionObserver',
    'CustomEvent',
    'Event',
    'EventTarget',
    'MouseEvent',
    'PointerEvent',
    'KeyboardEvent',
    'MessageEvent',
    'matchMedia',
    'getComputedStyle',
    'localStorage',
    'sessionStorage',
    'alert',
  ].map((name) => [name, 'readonly']),
);

export default defineConfig([
  globalIgnores(['dist/**', 'release/**', 'node_modules/**', 'assets/**', 'smoke-report.json', 'package-lock.json']),

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports', disallowTypeAnnotations: false },
      ],
      // Pragmatic: optional native modules and WebGL glue occasionally need `any`.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      // New in eslint 10's recommended set; useful hint, but it has false positives
      // around loops/try-catch, so it must not fail the build.
      'no-useless-assignment': 'warn',
    },
  },

  {
    files: ['scripts/**/*.{js,mjs,cjs}', '*.config.{js,mjs,cjs,ts,mts}', 'src/main/**', 'src/preload/**'],
    languageOptions: { globals: nodeGlobals },
    rules: {
      // The main bundle gets a `require` from scripts/build.mjs (createRequire banner) and the
      // preload is CJS: `require()` is the supported way to load the optional native modules there.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['src/renderer/**'],
    languageOptions: { globals: browserGlobals },
  },
  {
    // Zmeul's core is pure and deterministic: seeded Random, its own clock, no DOM and no GL.
    files: ['src/renderer/zmeu/core/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'zmeu/core is pure: App passes everything in through ZmeuSenses.' },
        { name: 'document', message: 'zmeu/core is pure: App passes everything in through ZmeuSenses.' },
        { name: 'performance', message: 'zmeu/core keeps its own clock; App passes wallMs to step().' },
        { name: 'requestAnimationFrame', message: 'zmeu/core is stepped by App.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded Random from util/math.' },
        { object: 'Date', property: 'now', message: 'zmeu/core keeps its own clock.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/gl', '**/gl/**', '**/render', '**/render/**', '*.glsl', '*.vert', '*.frag', '**/*.glsl', '**/*.vert', '**/*.frag'],
              message: 'zmeu/core may only import util/math, util/noise and src/shared.',
            },
            {
              // Allow-list: siblings, util/math, util/noise and src/shared; nothing else (no packages, no app code).
              regex: '^(?!\\./[^/]+$|\\.\\./\\.\\./util/(?:math|noise)$|\\.\\./\\.\\./\\.\\./shared/[^/]+$)',
              message: 'zmeu/core may only import util/math, util/noise and src/shared.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/shared/**', 'src/types/**', 'tests/**'],
    languageOptions: { globals: { ...nodeGlobals, ...browserGlobals } },
  },
]);
