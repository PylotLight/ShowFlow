/**
 * App-wide toasts (sonner). The <Toaster /> host is mounted once in App.
 *
 *   toast.success("Saved")   toast.error("Failed to save")
 *   notify(ok, text)         // for the old { ok, text } status-line shape
 */
import { toast } from "sonner";

export { toast };

export function notify(ok: boolean, text: string, description?: string) {
  if (ok) toast.success(text, description ? { description } : undefined);
  else toast.error(text, description ? { description } : undefined);
}
