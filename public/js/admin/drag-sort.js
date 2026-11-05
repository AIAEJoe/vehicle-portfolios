// Drag-and-drop reordering for photo lists and grids. Works with a mouse (press and drag) and on phones
// (press and hold a photo for a moment, then drag; a quick swipe still scrolls the page).
// Built on pointer events because the browser's own drag-and-drop doesn't work on iPhone.
//
//   makeSortable(container, { item: '.photo-tile', idOf: (el) => el.dataset.id, onDrop: (ids) => save(ids) })
//
// The arrow buttons stay for keyboard users. Returns a function that removes the listeners.
const HOLD_MS = 300;       // touch: hold this long before dragging starts
const MOVE_PX = 6;         // mouse: move this far before dragging starts
const SLOP_PX = 10;        // touch: moving more than this before the hold ends means the person is scrolling
const EDGE_PX = 70;        // auto-scroll when the finger is this close to the top or bottom of the screen

export function makeSortable(container, { item, idOf, onDrop, handleSkip = 'button, input, textarea, select, a, label' }) {
  let press = null;        // { el, pointerId, x, y, type, timer }
  let drag = null;         // { el, ghost, dx, dy, startIds, lastX, lastY, raf }
  let swallowClick = false;

  const items = () => [...container.querySelectorAll(item)];
  const ids = () => items().map(idOf);

  function start(e) {
    const el = press.el;
    const r = el.getBoundingClientRect();
    const ghost = el.cloneNode(true);
    ghost.classList.add('sort-ghost');
    ghost.removeAttribute('id');
    Object.assign(ghost.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, margin: '0', zIndex: '1000', pointerEvents: 'none' });
    document.body.appendChild(ghost);
    el.classList.add('sort-placeholder');
    container.classList.add('sorting');
    drag = { el, ghost, dx: e.clientX - r.left, dy: e.clientY - r.top, startIds: ids(), lastX: e.clientX, lastY: e.clientY, raf: 0 };
    try { container.setPointerCapture(press.pointerId); } catch { /* pointer already gone */ }
    if (navigator.vibrate && press.type === 'touch') navigator.vibrate(15);
    tick();
  }

  // keep auto-scrolling while the finger rests near an edge
  function tick() {
    if (!drag) return;
    const h = window.innerHeight;
    const y = drag.lastY;
    const speed = y < EDGE_PX ? -Math.ceil((EDGE_PX - y) / 5) : y > h - EDGE_PX ? Math.ceil((y - (h - EDGE_PX)) / 5) : 0;
    if (speed) { window.scrollBy(0, speed); place(drag.lastX, drag.lastY); }
    drag.raf = requestAnimationFrame(tick);
  }

  function place(x, y) {
    const { el, ghost } = drag;
    ghost.style.left = `${x - drag.dx}px`;
    ghost.style.top = `${y - drag.dy}px`;
    const over = document.elementFromPoint(x, y);
    const target = over && over.closest(item);
    if (!target || target === el || !container.contains(target)) return;
    const r = target.getBoundingClientRect();
    const all = items();
    const after = all.indexOf(target) > all.indexOf(el);
    // in a grid row compare across, in a list compare down
    const sameRow = Math.abs(r.top - el.getBoundingClientRect().top) < r.height / 2;
    const past = sameRow ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
    if (after && past) target.after(el);
    else if (!after && !past) target.before(el);
  }

  function finish(cancelled) {
    clearTimeout(press && press.timer);
    if (drag) {
      cancelAnimationFrame(drag.raf);
      drag.ghost.remove();
      drag.el.classList.remove('sort-placeholder');
      container.classList.remove('sorting');
      const now = ids();
      const startIds = drag.startIds;
      drag = null;
      swallowClick = true;
      setTimeout(() => { swallowClick = false; }, 50);
      if (cancelled) { const byId = new Map(items().map((x) => [idOf(x), x])); startIds.forEach((id) => container.appendChild(byId.get(id))); }
      else if (now.join() !== startIds.join()) onDrop(now);
    }
    press = null;
  }

  function down(e) {
    if (e.button !== 0 || press || drag) return;
    const el = e.target.closest(item);
    if (!el || !container.contains(el) || e.target.closest(handleSkip)) return;
    press = { el, pointerId: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType, timer: 0 };
    if (e.pointerType !== 'mouse') press.timer = setTimeout(() => { if (press && !drag) start({ clientX: press.x, clientY: press.y }); }, HOLD_MS);
    else e.preventDefault(); // no text selection while dragging with a mouse
  }
  function move(e) {
    if (!press || e.pointerId !== press.pointerId) return;
    if (!drag) {
      const d = Math.hypot(e.clientX - press.x, e.clientY - press.y);
      if (press.type === 'mouse') { if (d >= MOVE_PX) start(e); else return; }
      else { if (d > SLOP_PX) { clearTimeout(press.timer); press = null; } else { press.x = e.clientX; press.y = e.clientY; } return; }
    }
    drag.lastX = e.clientX; drag.lastY = e.clientY;
    place(e.clientX, e.clientY);
  }
  const up = (e) => { if (press && e.pointerId === press.pointerId) finish(false); };
  const cancel = (e) => { if (press && e.pointerId === press.pointerId) finish(!drag ? false : true); };
  // once a touch drag has started, stop the page from scrolling under the finger
  const touchMove = (e) => { if (drag) e.preventDefault(); };
  const click = (e) => { if (swallowClick) { e.stopPropagation(); e.preventDefault(); } };
  const menu = (e) => { if (press || drag) e.preventDefault(); }; // no "Save image" menu on a long press
  const key = (e) => { if (e.key === 'Escape' && drag) finish(true); };

  container.addEventListener('pointerdown', down);
  container.addEventListener('pointermove', move);
  container.addEventListener('pointerup', up);
  container.addEventListener('pointercancel', cancel);
  container.addEventListener('touchmove', touchMove, { passive: false });
  container.addEventListener('click', click, true);
  container.addEventListener('contextmenu', menu);
  document.addEventListener('keydown', key);
  return () => {
    finish(true);
    container.removeEventListener('pointerdown', down);
    container.removeEventListener('pointermove', move);
    container.removeEventListener('pointerup', up);
    container.removeEventListener('pointercancel', cancel);
    container.removeEventListener('touchmove', touchMove);
    container.removeEventListener('click', click, true);
    container.removeEventListener('contextmenu', menu);
    document.removeEventListener('keydown', key);
  };
}
