import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// text-caption / text-sub are our own font-size tokens (globals.css). Without
// this twMerge thinks they're colours and keeps e.g. both text-sm and text-sub.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["caption", "sub"] } },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
