// Tiny history-API router.
const routes = [];
let current = null;

export function route(pattern, load) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/\/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
  routes.push({ re, keys, load });
}

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState({}, '', path); else history.pushState({}, '', path);
  render();
}

export async function render() {
  const path = location.pathname;
  for (const r of routes) {
    const m = path.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const prev = current;
    const token = (current = {});
    const mod = await r.load();
    if (token !== current) return;
    if (prev && typeof prev.cleanup === 'function') prev.cleanup();
    // A fresh container per page so delegated listeners never pile up across navigations
    const view = document.createElement('div');
    document.getElementById('app').replaceChildren(view);
    await mod.default(view, params, token);
    return;
  }
  document.getElementById('app').innerHTML = '<div class="loading">Page not found. <a href="/">Go home</a></div>';
}

export function start() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target || a.hasAttribute('download')) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || a.dataset.external !== undefined) return;
    if (url.pathname === location.pathname && url.hash && url.search === location.search) return;
    e.preventDefault();
    navigate(url.pathname + url.search + url.hash);
    window.scrollTo(0, 0);
  });
  window.addEventListener('popstate', render);
  render();
}
