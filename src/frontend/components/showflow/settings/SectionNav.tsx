import * as React from "react";

import { cn } from "../SettingsShared";
import { scrollParent, scrollToSettingElement } from "./focus";

export interface SectionNavItem {
  /** DOM id of the section heading. */
  id: string;
  label: string;
}

/**
 * Sticky jump chips for a long settings tab, with scroll-spy.
 *
 * Layout: the bar is exactly the content column (no negative margins), so its
 * edges line up with the cards below. At rest it's a quiet row of chips; once
 * it sticks it becomes a glass tray hanging off the page header. The scroll
 * container has top padding (sm:p-6 on desktop, none in the mobile sheet), and
 * sticky offsets are measured inside that padding, so `top` is set to minus
 * the padding: the tray then sits flush under the header instead of leaving a
 * strip where cards scroll past above it.
 */
export function SectionNav({ items, label }: { items: SectionNavItem[]; label: string }) {
  const ref = React.useRef<HTMLElement>(null);
  const [active, setActive] = React.useState(items[0]?.id ?? "");
  const [stuck, setStuck] = React.useState(false);
  const [top, setTop] = React.useState(0);
  // While a chip-initiated smooth scroll runs, keep the clicked chip active
  // instead of flickering through the sections it passes.
  const lockUntil = React.useRef(0);

  React.useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    const scroller = scrollParent(bar);
    const isDoc = scroller === document.scrollingElement || scroller === document.documentElement;
    const target: HTMLElement | Window = isDoc ? window : scroller;
    setTop(isDoc ? 0 : -parseFloat(getComputedStyle(scroller).paddingTop || "0"));

    let raf = 0;
    const measure = () => {
      raf = 0;
      const viewTop = isDoc ? 0 : scroller.getBoundingClientRect().top;
      const viewBottom = isDoc ? window.innerHeight : scroller.getBoundingClientRect().bottom;
      const barRect = bar.getBoundingClientRect();
      setStuck(scroller.scrollTop > 0 && barRect.top <= viewTop + 0.5);
      if (performance.now() < lockUntil.current) return;
      // Active = last section whose heading has crossed a reading line a bit
      // below the bar (so a heading just under the bar counts as "in view").
      // At the very bottom the last visible section wins even if its heading
      // can never scroll that high.
      const line = barRect.bottom + Math.max(64, (viewBottom - barRect.bottom) * 0.2);
      let current = items[0]?.id ?? "";
      for (const it of items) {
        const el = document.getElementById(it.id);
        if (el && el.getBoundingClientRect().top <= line) current = it.id;
      }
      const atBottom = scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      if (atBottom) {
        for (const it of items) {
          const el = document.getElementById(it.id);
          if (el && el.getBoundingClientRect().top < viewBottom) current = it.id;
        }
      }
      setActive(current);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [items]);

  const go = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    setActive(id);
    lockUntil.current = performance.now() + 800;
    scrollToSettingElement(el);
  };

  return (
    <nav
      ref={ref}
      data-settings-subnav
      data-stuck={stuck || undefined}
      aria-label={label}
      style={{ top }}
      className={cn(
        "sticky z-20 rounded-xl border px-3 py-2 transition-[background-color,border-color,border-radius,box-shadow] duration-150",
        stuck
          // Cheap glass: a high-opacity fill + small blur instead of the 18px
          // card blur, since this layer repaints on every scroll frame.
          ? "rounded-t-none border-white/[0.08] border-t-transparent bg-[rgb(22_26_33/0.9)] shadow-[0_10px_24px_-14px_rgb(0_0_0/0.7)] backdrop-blur-sm"
          : "border-white/[0.06] bg-white/[0.02]",
      )}
    >
      <ul className="flex flex-wrap gap-1.5">
        {items.map(it => {
          const on = it.id === active;
          return (
            <li key={it.id}>
              <a
                href={`#${it.id}`}
                aria-current={on ? "location" : undefined}
                onClick={(e) => { e.preventDefault(); go(it.id); }}
                className={cn(
                  "block rounded-full px-3 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors outline-none focus-visible:ring-2 focus-visible:ring-signal/70",
                  on
                    ? "bg-signal/15 text-signal shadow-[inset_0_0_0_0.5px_var(--signal)]"
                    : "bg-white/[0.06] text-muted-foreground hover:bg-white/[0.09] hover:text-foreground",
                )}
              >
                {it.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
