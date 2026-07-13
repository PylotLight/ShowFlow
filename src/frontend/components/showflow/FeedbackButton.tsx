import * as React from "react";
import { MessageSquareTextIcon, CameraIcon, BugIcon, LoaderIcon, CheckIcon } from "lucide-react";
import { Button } from "@frontend/components/ui/button";
import { Textarea } from "@frontend/components/ui/textarea";
import { Label } from "@frontend/components/ui/label";
import { Switch } from "@frontend/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@frontend/components/ui/dialog";
import { cn } from "@frontend/lib/utils";

type FeedbackState = "idle" | "capturing" | "sending" | "done" | "error";

export function FeedbackButton() {
  const [open, setOpen] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [screenshot, setScreenshot] = React.useState<string | null>(null);
  const [includeLogs, setIncludeLogs] = React.useState(true);
  const [state, setState] = React.useState<FeedbackState>("idle");
  const [result, setResult] = React.useState("");

  async function captureScreenshot() {
    setState("capturing");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ preferCurrentTab: true });
      const track = stream.getVideoTracks()[0];

      const video = document.createElement("video");
      video.srcObject = stream;
      await video.play();

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(video, 0, 0);

      track.stop();
      stream.getTracks().forEach((t) => t.stop());
      video.remove();

      setScreenshot(canvas.toDataURL("image/png").split(",")[1]);
    } catch {
      // User cancelled or not supported — ignore
    }
    setState("idle");
  }

  async function submit() {
    if (!message.trim()) return;
    setState("sending");
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message.trim(),
          screenshot,
          url: window.location.href,
          includeDebugLogs: includeLogs,
          userAgent: navigator.userAgent,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Unknown error");
      }
      const data = await res.json();
      setResult(data.url);
      setState("done");
    } catch (err) {
      setState("error");
      setResult(err instanceof Error ? err.message : "Submission failed");
    }
  }

  function reset() {
    setMessage("");
    setScreenshot(null);
    setIncludeLogs(true);
    setState("idle");
    setResult("");
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); else setOpen(true) }}>
      <DialogTrigger asChild>
        <Button
          size="icon-sm"
          variant="outline"
          className="fixed bottom-24 right-4 z-50 size-10 rounded-full border-signal/30 bg-signal/10 shadow-lg backdrop-blur-sm hover:bg-signal/20 md:bottom-6"
          title="Send feedback"
        >
          <MessageSquareTextIcon className="size-4 text-signal" />
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        {state === "done" ? (
          <>
            <DialogHeader>
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-full bg-emerald-500/20">
                  <CheckIcon className="size-5 text-emerald-400" />
                </div>
                <DialogTitle>Feedback submitted</DialogTitle>
              </div>
              <DialogDescription>
                Thank you! You can track the issue here:
              </DialogDescription>
            </DialogHeader>
            <a
              href={result}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate rounded-md bg-white/5 px-3 py-2 text-sm text-signal hover:underline"
            >
              {result}
            </a>
            <Button onClick={reset} variant="outline" className="mt-2">
              Close
            </Button>
          </>
        ) : state === "error" ? (
          <>
            <DialogHeader>
              <DialogTitle>Submission failed</DialogTitle>
              <DialogDescription>{result}</DialogDescription>
            </DialogHeader>
            <div className="flex gap-2">
              <Button onClick={() => setState("idle")} variant="outline">
                Try again
              </Button>
              <Button onClick={reset} variant="ghost">
                Dismiss
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Send feedback</DialogTitle>
              <DialogDescription>
                Help improve ShowFlow — report a bug, request a feature, or share your thoughts.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="feedback-message">Your message</Label>
                <Textarea
                  id="feedback-message"
                  placeholder="Describe what happened or what you'd like to see…"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={4}
                />
              </div>

              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={captureScreenshot}
                    disabled={state === "capturing"}
                    className={cn(screenshot && "border-signal/50 text-signal")}
                  >
                    {state === "capturing" ? (
                      <LoaderIcon className="size-3.5 animate-spin" />
                    ) : (
                      <CameraIcon className="size-3.5" />
                    )}
                    {screenshot ? "Re-capture" : "Screenshot"}
                  </Button>
                  {screenshot && (
                    <button
                      type="button"
                      onClick={() => setScreenshot(null)}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      Remove
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <BugIcon className="size-3.5 text-muted-foreground" />
                  <Switch
                    id="include-logs"
                    checked={includeLogs}
                    onCheckedChange={setIncludeLogs}
                  />
                  <Label htmlFor="include-logs" className="text-xs text-muted-foreground cursor-pointer">
                    Attach logs
                  </Label>
                </div>
              </div>

              {screenshot && (
                <div className="relative overflow-hidden rounded-md bg-black/40">
                  <img
                    src={`data:image/png;base64,${screenshot}`}
                    alt="Screenshot preview"
                    className="max-h-32 w-full object-contain"
                  />
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <DialogTrigger asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogTrigger>
              <Button onClick={submit} disabled={!message.trim() || state === "sending"}>
                {state === "sending" ? (
                  <>
                    <LoaderIcon className="size-4 animate-spin" />
                    Sending…
                  </>
                ) : (
                  "Submit"
                )}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
