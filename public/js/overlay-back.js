// Full-screen overlays (camera, video recorder, 360 viewers) close on the phone's Back button / swipe instead of
// leaving the page. Opening adds one history entry; Back pops it and closes the overlay. Closing with a button
// removes that entry again. While an overlay is open the router ignores the history change.
export function closeOnBack(close) {
  window.__vpOverlay = (window.__vpOverlay || 0) + 1;
  history.pushState({ vpOverlay: true }, '', location.href);
  let done = false;
  const onPop = () => {
    if (done) return;
    done = true;
    window.removeEventListener('popstate', onPop);
    setTimeout(() => { window.__vpOverlay = Math.max(0, window.__vpOverlay - 1); }, 0);
    close();
  };
  window.addEventListener('popstate', onPop);
  // call when the overlay closes by itself (Done, Cancel, ✕): drop our history entry without re-rendering the page
  return function release() {
    if (done) return;
    done = true;
    window.removeEventListener('popstate', onPop);
    const clear = () => { window.removeEventListener('popstate', clear); setTimeout(() => { window.__vpOverlay = Math.max(0, window.__vpOverlay - 1); }, 0); };
    if (history.state && history.state.vpOverlay) { window.addEventListener('popstate', clear); history.back(); } else clear();
  };
}
