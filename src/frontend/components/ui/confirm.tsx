import * as React from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@frontend/components/ui/alert-dialog";
import { buttonVariants } from "@frontend/components/ui/button";
import { cn } from "@frontend/lib/utils";

export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button for deletes / irreversible stuff. */
  destructive?: boolean;
}

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

let push: ((p: Pending) => void) | null = null;

/**
 * Promise-based replacement for window.confirm(), rendered as an
 * AlertDialog by the single <ConfirmHost /> mounted in App.
 *
 *   if (!(await confirmDialog({ title: "Remove 3 shows?", destructive: true }))) return;
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!push) {
      // Host not mounted (tests / detached render): fail safe, don't act.
      resolve(false);
      return;
    }
    push({ ...opts, resolve });
  });
}

export function ConfirmHost() {
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    push = (p) => {
      setPending((prev) => {
        prev?.resolve(false); // a newer prompt supersedes an unanswered one
        return p;
      });
      setOpen(true);
    };
    return () => { push = null; };
  }, []);

  const settle = (ok: boolean) => {
    pending?.resolve(ok);
    setPending((p) => (p ? { ...p, resolve: () => {} } : p));
    setOpen(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={(v) => { if (!v) settle(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="text-white">{pending?.title}</AlertDialogTitle>
          {pending?.description && (
            <AlertDialogDescription className="whitespace-pre-line">{pending.description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>{pending?.cancelLabel ?? "Cancel"}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => settle(true)}
            className={cn(pending?.destructive && buttonVariants({ variant: "destructive" }))}
          >
            {pending?.confirmLabel ?? "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
