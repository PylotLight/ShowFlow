/**
 * Shared pill / icon-button styles.
 *
 * Desktop keeps the mono, uppercase "control room" pill. Below the `md`
 * breakpoint (phones and the mini window, the same switch as useCompact and
 * the bottom tab bar) pills drop to normal-case sans text at a fixed 36px
 * height so a row of them stays tidy instead of wrapping into big shouty
 * blocks. On touch screens (pointer: coarse) every pill / icon button grows
 * to a 40px hit target whatever the width.
 */

/** Focus ring for bare (non-<Button>) buttons. */
export const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-signal/70 focus-visible:ring-offset-1 focus-visible:ring-offset-transparent";

const pillBase =
  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full transition-colors disabled:opacity-60 " +
  // desktop: compact mono caps
  "px-3 py-1.5 font-mono text-caption uppercase tracking-wider " +
  // compact (< md): normal-case, readable, fixed height
  "max-md:h-9 max-md:py-0 max-md:font-sans max-md:text-[13px] max-md:font-medium max-md:normal-case max-md:tracking-normal " +
  // touch: 40px hit target
  "pointer-coarse:min-h-10 " +
  focusRing;

/** Neutral action pill (Organise, Fix match, Browse releases…). */
export const pillButton = `${pillBase} bg-white/[0.04] text-muted-foreground hover:bg-white/[0.08] hover:text-foreground`;

/** Primary (signal-tinted) action pill. */
export const pillButtonPrimary = `${pillBase} bg-signal/15 text-signal hover:bg-signal/25 active:bg-signal/30`;

/** Destructive action pill. */
export const pillButtonDanger = `${pillBase} bg-white/[0.04] text-red-400 hover:bg-red-400/10 hover:text-red-300`;

/**
 * Grows a small icon button's hit area to ~40px on touch screens with an
 * invisible ::after, without changing the layout (dense rows keep their
 * look; fingers still land).
 */
export const touchHit =
  "relative pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-1 pointer-coarse:after:content-['']";

/** Round icon-only button matching the pills (36px, 40px on touch). */
export const pillIconButton =
  "flex size-9 shrink-0 items-center justify-center rounded-full bg-white/[0.05] text-muted-foreground transition-colors hover:bg-white/[0.09] hover:text-foreground active:bg-white/[0.12] disabled:opacity-60 pointer-coarse:size-10 " +
  focusRing;
