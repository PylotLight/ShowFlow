import { Loader2Icon } from "lucide-react";
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

/** Replaces the old native confirm() for removing a show from the library. */
export function RemoveShowDialog({ open, onOpenChange, title, removing, onConfirm }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  removing: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {title}?</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to remove {title} from your library? Files on disk are left where they are.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={removing}
            onClick={(e) => { e.preventDefault(); onConfirm(); }}
            className="bg-red-500/80 text-white hover:bg-red-500"
          >
            {removing && <Loader2Icon className="size-4 animate-spin" />}
            Remove show
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
