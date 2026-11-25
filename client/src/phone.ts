import { useEffect, useState } from "react";

/** Narrow screens (phones) get the one-panel-at-a-time layout. Matches the CSS breakpoint. */
export const PHONE_QUERY = "(max-width: 760px)";

export function isPhone() {
  return typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches;
}

export function useIsPhone() {
  const [phone, setPhone] = useState(isPhone);
  useEffect(() => {
    const m = matchMedia(PHONE_QUERY);
    const f = () => setPhone(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return phone;
}

/** Things a sideways swipe belongs to (sliders, scrolling strips, the video's seek bar...). */
function ownsSideways(el: Element | null): boolean {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n instanceof HTMLInputElement && n.type === "range") return true;
    if (n.closest?.("[data-noswipe], .watch-split.full, .call-screen, .modal, .ctx-menu, .dial-sheet-back")) return true;
    const s = getComputedStyle(n);
    if ((s.overflowX === "auto" || s.overflowX === "scroll") && n.scrollWidth > n.clientWidth + 2) return true;
  }
  return false;
}

/**
 * Phones show one panel at a time. Swiping right brings the menu (servers and channels) back
 * over whatever page is open; swiping left goes back to the page.
 */
export function wireSwipe(onRight: () => void, onLeft: () => void) {
  let x0 = 0, y0 = 0, t0 = 0, ok = false;
  const start = (e: TouchEvent) => {
    if (e.touches.length !== 1 || !isPhone()) return (ok = false);
    const t = e.touches[0];
    x0 = t.clientX;
    y0 = t.clientY;
    t0 = Date.now();
    ok = !ownsSideways(e.target as Element);
  };
  const end = (e: TouchEvent) => {
    if (!ok) return;
    ok = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    // a quick, clearly sideways swipe (not a scroll, not a slow drag to select text)
    if (Date.now() - t0 > 600 || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    if (window.getSelection()?.toString()) return;
    if (dx > 0) onRight();
    else onLeft();
  };
  window.addEventListener("touchstart", start, { passive: true });
  window.addEventListener("touchend", end, { passive: true });
  return () => {
    window.removeEventListener("touchstart", start);
    window.removeEventListener("touchend", end);
  };
}
