// Landing-page glue: drives the embedded mock renderer (same origin iframe)
// through window.prajealaDemo, which src/renderer/main.ts exposes when no
// Electron preload bridge is present. Plain ES module, no dependencies.
const frame = document.getElementById('demo');
const controls = document.getElementById('controls');
const langButton = document.getElementById('lang');

const BASE_QUERY = 'synthetic=1&bottom=1&intensity=high&warmup=60';
const state = { audio: false, typing: false, palette: 'classic', intensity: 'high', screenBottomFire: true, burnActiveWindow: false };

function api() {
  try {
    return frame.contentWindow && frame.contentWindow.prajealaDemo;
  } catch {
    return null;
  }
}

/** Applies a settings patch without reloading the fire. */
function update(patch) {
  const a = api();
  if (a && typeof a.updateSettings === 'function') a.updateSettings(patch);
}

/** Simulated sound / typing are start-up options of the mock → reload with the matching query. */
function reload() {
  const q = [BASE_QUERY];
  q.push(`palette=${state.palette}`, `intensity=${state.intensity}`, `bottom=${state.screenBottomFire ? 1 : 0}`, `window=${state.burnActiveWindow ? 1 : 0}`);
  if (state.audio) q.push('audio=sim');
  if (state.typing) q.push('typing=sim');
  frame.src = `renderer/index.html?${q.join('&')}`;
}

function setPressed(selector, value, attr) {
  for (const b of controls.querySelectorAll(selector)) b.setAttribute('aria-pressed', String(b.dataset[attr] === value));
}

controls.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const d = btn.dataset;
  if (d.palette) {
    state.palette = d.palette;
    setPressed('[data-palette]', d.palette, 'palette');
    update({ palette: d.palette, themeId: '' });
  } else if (d.intensity) {
    state.intensity = d.intensity;
    setPressed('[data-intensity]', d.intensity, 'intensity');
    update({ intensity: d.intensity });
  } else if (d.toggle) {
    state[d.toggle] = !state[d.toggle];
    btn.setAttribute('aria-pressed', String(state[d.toggle]));
    update({ [d.toggle]: state[d.toggle] });
  } else if (d.sim) {
    state[d.sim] = !state[d.sim];
    btn.setAttribute('aria-pressed', String(state[d.sim]));
    reload();
  } else if ('burst' in d) {
    const w = frame.contentWindow;
    if (w) w.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
  }
});

// Language toggle (remembered per browser).
function setLang(lang) {
  document.body.dataset.lang = lang;
  document.documentElement.lang = lang;
  langButton.textContent = lang === 'ro' ? 'EN' : 'RO';
  try {
    localStorage.setItem('prajeala-lang', lang);
  } catch {
    /* private mode */
  }
}
langButton.addEventListener('click', () => setLang(document.body.dataset.lang === 'ro' ? 'en' : 'ro'));
try {
  const saved = localStorage.getItem('prajeala-lang');
  setLang(saved === 'en' || saved === 'ro' ? saved : navigator.language && navigator.language.toLowerCase().startsWith('ro') ? 'ro' : 'en');
} catch {
  setLang('ro');
}

// Pause the demo while the hero is scrolled away (saves the GPU).
if ('IntersectionObserver' in window) {
  new IntersectionObserver(([entry]) => update({ enabled: !!entry?.isIntersecting }), { threshold: 0.05 }).observe(frame);
}
