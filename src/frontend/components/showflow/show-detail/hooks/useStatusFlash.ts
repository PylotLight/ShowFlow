import * as React from "react";

import { notify } from "@frontend/lib/toast";

/** Transient action result (grab, rename, …) shown as an app toast. */
export function useStatusFlash() {
  const flashStatus = React.useCallback((text: string, ok = true) => {
    notify(ok, text);
  }, []);
  return { flashStatus };
}
