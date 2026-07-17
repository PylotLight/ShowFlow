import * as React from "react";
import { createPortal } from "react-dom";

/**
 * Lets the active page render its own content into the global top-bar's
 * action slot (the right-hand side of the header), without the header
 * itself needing to know what every page wants to put there.
 *
 * App.tsx owns the slot element and provides it via HeaderActionsProvider.
 * Any page can then render <HeaderActions>...</HeaderActions> and its
 * children will be portaled into that slot. This keeps the header's
 * placement and layout identical across pages while letting the content
 * vary per page.
 */
const HeaderActionsContext = React.createContext<HTMLDivElement | null>(null);

export function HeaderActionsProvider({
  container,
  children,
}: {
  container: HTMLDivElement | null;
  children: React.ReactNode;
}) {
  return (
    <HeaderActionsContext.Provider value={container}>
      {children}
    </HeaderActionsContext.Provider>
  );
}

export function HeaderActions({ children }: { children: React.ReactNode }) {
  const container = React.useContext(HeaderActionsContext);
  if (!container) return null;
  return createPortal(children, container);
}
