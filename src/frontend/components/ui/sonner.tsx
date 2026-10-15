import * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * The one toast host. Mounted once in App; anything can call `toast(...)`
 * from "@frontend/lib/toast". Sits above the mobile bottom nav.
 */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      closeButton
      richColors
      offset={16}
      // Clear the 56px mobile bottom nav (+ safe area).
      mobileOffset={{ bottom: "calc(4.5rem + env(safe-area-inset-bottom, 0px))" }}
      toastOptions={{
        classNames: {
          toast: "!bg-[#1c2028] !border !border-white/10 !text-foreground font-sans !text-sm shadow-2xl",
          description: "!text-muted-foreground !text-xs",
          actionButton: "!bg-signal !text-signal-foreground",
          closeButton: "!bg-[#1c2028] !border-white/10 !text-muted-foreground hover:!text-white",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
