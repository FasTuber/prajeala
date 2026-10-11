# Prăjeală — plan de implementare

> Foc pe ecran, pe aplicații și pe cursor: un overlay transparent, click-through, mereu deasupra,
> care rulează o simulare de fluid/foc pe GPU și reacționează la cursor, click-uri și fereastra activă.

## 1. Obiective

| # | Cerință | Cum o livrăm |
|---|---------|--------------|
| 1 | Efecte de foc pe ecran | Fereastră overlay transparentă pe fiecare monitor, simulare de fluid (WebGL2) randată ca flăcări. Mod „ecran în flăcări”: foc care urcă de la marginea de jos. |
| 2 | Efecte de foc pe aplicațiile de pe laptop | Urmărim fereastra activă (titlu + bounds) și aprindem conturul ei: flăcări care ies din marginea de sus și ling laturile. |
| 3 | Cursorul ca textură interactivă | Cursorul devine sursă de foc: halo de flăcări, coadă („cometă”) proporțională cu viteza, scântei, explozie la click. Mișcarea cursorului injectează viteză în fluid, deci flăcările „se trag” după el. |
| 4 | Sesiuni paralele + cloud | Construit în cloud cu trei agenți în paralel pe seturi disjuncte de fișiere (renderer / main process / tooling) peste un contract partajat (`src/shared`). |

## 2. Arhitectură

```
Electron (main, ESM)                      Renderer (WebGL2, per monitor)
┌──────────────────────────────┐          ┌───────────────────────────────┐
│ OverlayManager               │  IPC     │ FireSimulation (GPU fluid)    │
│  · 1 BrowserWindow / display │ ───────▶ │  splat → curl → vorticity →   │
│  · transparent, frameless,   │ cursor,  │  divergence → pressure →      │
│    alwaysOnTop(screen-saver),│ clicks,  │  gradient → advect → render   │
│    click-through (forward)   │ active   │ Emitters                      │
│ CursorTracker (poll 120 Hz,  │ window,  │  · cursor (halo/trail/comet)  │
│   + uiohook-napi opțional)   │ settings │  · click burst                │
│ ActiveWindowTracker          │          │  · active-window frame        │
│   (get-windows opțional)     │ ◀─────── │  · screen-bottom fire         │
│ Tray + global shortcuts      │ ready    │ Sparks (CPU particles)        │
│ Settings (userData/json)     │ report   │ Palette LUT (classic/blue/…)  │
└──────────────────────────────┘          └───────────────────────────────┘
                 ▲
       src/shared/{settings,ipc,palettes}.ts  — contractul comun
```

### Stack
- **Electron 44** (main în ESM, preload în CJS sandboxed, renderer WebGL2 fără framework).
- **TypeScript 5.9**, bundling cu **esbuild** (shaders `.glsl` importate ca text).
- **Vitest** pentru module pure, **ESLint 10 + typescript-eslint**.
- **electron-builder** pentru instalatoare (NSIS / DMG / AppImage).
- Dependențe native **opționale** (nu blochează instalarea dacă lipsesc):
  - `uiohook-napi` — click-uri globale (explozii la click). Fără ea, doar mișcarea cursorului.
  - `get-windows` — fereastra activă (foc pe aplicații). Fără ea, modul „aplicații” e dezactivat automat.

### Simularea focului (renderer)
1. Texturi ping-pong (half-float dacă există `EXT_color_buffer_float`, altfel RGBA8): viteză, temperatură/densitate, presiune, divergență, curl.
2. Pe cadru: injectare (splat) de căldură + viteză la emițători → curl + vorticity confinement (flăcări care se răsucesc) → divergență → Jacobi presiune (N iterații, configurabil) → scădere gradient → advecție viteză și temperatură (semi-Lagrangian) → flotabilitate (căldura urcă) → disipare.
3. Randare: temperatură → LUT paletă (negru→roșu→portocaliu→galben→alb), detaliu fbm noise, alpha din temperatură, compozitare premultiplied peste fundal transparent.
4. Simularea rulează la rezoluție redusă (`simScale`, implicit 0.25), randarea la rezoluția nativă.

### Overlay (main)
- `BrowserWindow({ transparent, frame:false, alwaysOnTop, skipTaskbar, focusable:false, hasShadow:false })`
- `setIgnoreMouseEvents(true, { forward: true })` → click-through total; mouse-move-ul ajunge în continuare la renderer.
- `setAlwaysOnTop(true, 'screen-saver')` + `setVisibleOnAllWorkspaces(true, { visibleOnFullScreenWindows: true })`.
- Recreare automată la adăugare/scoatere monitor sau schimbare de rezoluție.
- Poziția cursorului: `screen.getCursorScreenPoint()` la ~120 Hz (funcționează pe toate OS-urile, fără permisiuni), convertită în coordonate locale fiecărui monitor.

### Control
- Tray: Pauză/Reluare, Intensitate (Low/Medium/High/Inferno), Paletă, comutatoare (cursor, click-uri, aplicații, ecran, scântei), FPS, pornire la login, Ieșire.
- Scurtături globale: `Ctrl/Cmd+Shift+F` pauză, `Ctrl/Cmd+Shift+Q` ieșire, `Ctrl/Cmd+Shift+↑/↓` intensitate.
- Setări persistate în `userData/prajeala-settings.json`, validate la citire.

### Testare
- `npm run typecheck`, `npm run lint`, `npm test` (module pure).
- `npm run smoke`: pornește aplicația sub Xvfb cu SwiftShader în mod `--smoke`; renderer-ul raportează dacă WebGL2 + shaderele s-au inițializat și câte cadre a randat; ieșire 0/1. Rulează și în CI.

## 3. Împărțirea pe sesiuni paralele

| Agent | Fișiere deținute | Livrabil |
|-------|------------------|----------|
| renderer | `src/renderer/**` | simulare, emițători, cursor, scântei, HUD debug |
| main | `src/main/**`, `src/preload/**` | overlay-uri, tracker cursor/fereastră, tray, shortcuts, setări, `--smoke` |
| tooling | `scripts/gen-icons.mjs`, `scripts/smoke.mjs`, `eslint.config.js`, `tests/**`, `.github/**`, `electron-builder.yml`, `README.md`, `LICENSE` | icoane, lint, teste, CI, packaging, documentație |

Contractul comun (`src/shared/*`) este scris înainte de pornirea agenților și nu se modifică fără sincronizare.

## 4. Etapa a doua: monetizare și funcții noi

Reguli: contractul din `src/shared` rămâne compatibil (doar adăugiri), nicio dependență nativă nouă fără
fallback, fiecare funcție nouă are comutator în tray și setare persistată, README + teste actualizate,
toate verificările (`typecheck`, `lint`, `test`, `build`, `smoke`) trec înainte de fiecare commit.

| # | Etapă | Design pe scurt |
|---|-------|-----------------|
| 1 | **Free / Pro cu licență Lemon Squeezy** | `src/shared/license.ts` (pur): nivel `free`/`pro`, limitele Free (`classic`, intensitate ≤ `medium`, fără foc pe ferestre), `applyTierLimits()` calculează setările *efective* trimise renderer-ului. Două formate de cheie: (a) **cheie semnată** `PRAJ1.<payload>.<semnătură Ed25519>` emisă de vânzător (`npm run license:sign`) și verificată **offline** cu cheia publică compilată în aplicație; (b) **cheie brută Lemon Squeezy** (UUID) care cere o activare online (`/v1/licenses/activate`) și se re-verifică periodic. Licența se salvează în `userData/prajeala-license.json`. Verificarea online e opțională (setare `licenseOnlineCheck`, comutator în tray); fără rețea se păstrează ultima stare. Introducerea cheii: fereastră mică `license.html`, clipboard sau `--license=KEY`. |
| 2 | **Reacție la sunet** | `getUserMedia` (microfon sau, unde există, loopback de sistem) în renderer → `AnalyserNode` → nivele bass/mid/high + detecție de beat → modulează căldura, flotabilitatea și scânteile. Permisiuni acordate din main (`setPermissionRequestHandler`, `askForMediaAccess` pe macOS). Setări `audioReactive`, `audioSource`; starea raportată către tray. Mock: `?audio=sim`. |
| 3 | **Teme noi + format JSON** | Palete `ice`, `electric`, `neon` + parametri de simulare per temă (flotabilitate, vârtej, răcire, glow, detaliu). `src/shared/theme.ts`: `ThemeDefinition` validat, export/import JSON (`prajeala-theme` v1). Temele importate stau în `userData/themes/`, se aleg din tray, iar renderer-ul primește tema rezolvată prin IPC. |
| 4 | **Foc la tastare** | `uiohook-napi` (deja opțional) livrează `keydown`; main trimite doar o *categorie* (literă/spațiu/enter/ștergere/modificator), niciodată codul tastei. Renderer: scântei + puf de căldură la cursor. Setare `typingFire`. |
| 5 | **Pagină web** | `web/` — landing de o pagină cu demo WebGL live (renderer-ul în mod mock), Free vs Pro și buton de cumpărare Lemon Squeezy; build în `dist/web`, publicabil pe GitHub Pages. |

Nivelul Pro deblochează tot; Free rămâne o demonstrație completă a focului clasic. Limitele stau într-un
singur loc (`FREE_LIMITS` în `src/shared/license.ts`), ca să poată fi schimbate fără să atingi restul codului.

## 5. Limitări cunoscute
- Cursorul de sistem nu poate fi ascuns/înlocuit global dintr-un overlay (ar necesita drivere sau setări de OS); focul se desenează **în jurul** cursorului, deasupra tuturor aplicațiilor.
- Pe macOS, `uiohook-napi` cere permisiunea Accessibility pentru click-uri globale; `get-windows` cere Screen Recording pentru titluri.
- Pe Linux e nevoie de un compositor (Wayland/X11 cu compoziție) pentru transparență.
