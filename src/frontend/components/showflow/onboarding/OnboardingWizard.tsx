import * as React from "react";
import { CheckIcon, ArrowLeftIcon, XCircleIcon } from "lucide-react";
import { Button } from "@frontend/components/ui/button";
import { cn } from "@frontend/lib/utils";
import { STEPS, TOTAL_STEPS, DEFAULT_WIZARD_DATA } from "./types";
import type { WizardData, StepProps } from "./types";
import { SonarrImportProgress } from "@frontend/components/showflow/SonarrImportProgress";

import { StepWelcome } from "./steps/StepWelcome";
import { StepRootFolders } from "./steps/StepRootFolders";
import { StepLibraryType } from "./steps/StepLibraryType";
import { StepIntegrations } from "./steps/StepIntegrations";
import { StepTheme } from "./steps/StepTheme";
import { StepHealthCheck } from "./steps/StepHealthCheck";
import { StepDone } from "./steps/StepDone";

const STORAGE_KEY = "showflow-onboarding";

function loadData(): WizardData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_WIZARD_DATA, ...parsed };
    }
  } catch {}
  return { ...DEFAULT_WIZARD_DATA };
}

function saveData(data: WizardData) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
  fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "onboarding.wizard", value: JSON.stringify(data) }),
  }).catch(() => {});
}

export function OnboardingWizard({ onFinish }: { onFinish: () => void }) {
  const [data, setData] = React.useState<WizardData>(loadData);
  const [step, setStep] = React.useState(data.step);
  const [direction, setDirection] = React.useState<'forward' | 'backward'>('forward');
  const [animKey, setAnimKey] = React.useState(0);
  const [sonarrPanelOpen, setSonarrPanelOpen] = React.useState(false);

  React.useEffect(() => { saveData({ ...data, step }); }, [data, step]);

  const setPartial = React.useCallback((updates: Partial<WizardData>) => {
    setData(prev => ({ ...prev, ...updates }));
  }, []);

  const goNext = React.useCallback(() => {
    if (step < TOTAL_STEPS - 1) {
      setDirection('forward');
      setStep(step + 1);
      setAnimKey(k => k + 1);
    }
  }, [step]);

  const goBack = React.useCallback(() => {
    if (step > 0) {
      setDirection('backward');
      setStep(step - 1);
      setAnimKey(k => k + 1);
    }
  }, [step]);

  const goTo = React.useCallback((s: number) => {
    setDirection(s > step ? 'forward' : 'backward');
    setStep(s);
    setAnimKey(k => k + 1);
  }, [step]);

  const skipToEnd = React.useCallback(() => {
    const at = TOTAL_STEPS - 2;
    setDirection('forward');
    setStep(at);
    setAnimKey(k => k + 1);
  }, []);

  const finish = React.useCallback(() => {
    setData(prev => ({ ...prev, completed: true, step: TOTAL_STEPS - 1 }));
    onFinish();
  }, [onFinish]);

  const stepProps: StepProps = {
    data,
    setData: setPartial,
    onNext: step === TOTAL_STEPS - 1 ? finish : goNext,
    onBack: goBack,
    onSkip: skipToEnd,
    isFirst: step === 0,
    isLast: step === TOTAL_STEPS - 1,
    sonarrPanelOpen,
    setSonarrPanelOpen,
  };

  const renderStep = () => {
    switch (step) {
      case 0: return <StepWelcome {...stepProps} />;
      case 1: return <StepRootFolders {...stepProps} />;
      case 2: return <StepLibraryType {...stepProps} />;
      case 3: return <StepIntegrations {...stepProps} />;
      case 4: return <StepTheme {...stepProps} />;
      case 5: return <StepHealthCheck {...stepProps} />;
      case 6: return <StepDone {...stepProps} />;
      default: return null;
    }
  };

  const HAS_OWN_NAV = new Set([1, 2, 3, 4, 5, 6]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col animate-fade-in">
      <div className="absolute inset-0" style={{
        background: `
          radial-gradient(circle at 22% 8%, rgba(80, 180, 110, 0.14), transparent 40%),
          radial-gradient(circle at 85% 14%, rgba(220, 195, 50, 0.11), transparent 36%),
          rgba(0, 0, 0, 0.55)
        `
      }} />
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 py-12">
        <div className={cn(
          "w-full max-w-2xl glass-panel rounded-2xl p-8 shadow-2xl animate-page-enter transition-transform duration-300 ease-out",
          step === 3 && sonarrPanelOpen && "-translate-x-[218px]"
        )}>
          <StepIndicator current={step} onGoTo={goTo} />

          <div key={animKey} className={cn(
            "transition-all duration-500 ease-out",
            direction === 'forward' ? "animate-slide-in-right" : "animate-slide-in-left"
          )}>
            {step > 3 && data.sonarr.importJobId && data.sonarr.importForkMode === 'background' && (
              <div className="mb-6">
                <SonarrImportProgress jobId={data.sonarr.importJobId} compact silent>
                  {({ job, done }) => job ? (
                    <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-white/[0.03] border border-white/5">
                      {job.status === 'running' ? (
                        <div className="size-2 rounded-full bg-signal animate-pulse shrink-0" />
                      ) : job.status === 'done' ? (
                        <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />
                      ) : (
                        <XCircleIcon className="size-3.5 shrink-0 text-red-400" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">
                          {job.status === 'running' ? "Importing series in background..." : job.status === 'done' ? "Import complete" : "Import failed"}
                        </p>
                        {job.progress.detail && (
                          <p className="text-[11px] text-muted-foreground truncate">{job.progress.detail}</p>
                        )}
                      </div>
                      {job.status === 'running' && job.progress.total && job.progress.total > 0 && (
                        <div className="w-16 h-1 rounded-full bg-white/10 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-signal transition-all duration-500"
                            style={{ width: `${Math.round((job.progress.completed / job.progress.total) * 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  ) : null}
                </SonarrImportProgress>
              </div>
            )}
            {renderStep()}
          </div>

          {!HAS_OWN_NAV.has(step) && (
            <div className="mt-10 flex items-center justify-between">
              <div>
                {!stepProps.isFirst && (
                  <Button variant="ghost" onClick={goBack} className="gap-2">
                    <ArrowLeftIcon className="size-4" />
                    Back
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-3">
                {!stepProps.isLast && step < TOTAL_STEPS - 1 && (
                   <button
                     onClick={stepProps.onSkip}
                     className="text-xs text-muted-foreground/40 hover:text-muted-foreground/70 transition-colors italic"
                   >
                     Skip and set up manually
                   </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StepIndicator({ current, onGoTo }: { current: number; onGoTo: (i: number) => void }) {
  return (
    <div className="mb-10 px-6">
      <div className="flex items-center justify-between gap-1">
        {STEPS.map((s, i) => (
          <React.Fragment key={s.id}>
            <button
              onClick={() => i < current ? onGoTo(i) : null}
              className={cn(
                "flex flex-col items-center gap-2 group",
                i < current && "cursor-pointer",
                i >= current && "cursor-default"
              )}
            >
              <div className={cn(
                "flex items-center justify-center size-10 rounded-full border-2 text-sm font-mono font-bold transition-all duration-300",
                i === current && "border-signal bg-signal/10 text-signal scale-110 shadow-lg shadow-signal/20",
                i < current && "border-green-500/60 bg-green-500/10 text-green-400",
                i > current && "border-white/10 text-muted-foreground/30"
              )}>
                {i < current ? <CheckIcon className="size-4" /> : i + 1}
              </div>
              <span className={cn(
                "text-xs font-medium uppercase tracking-wide transition-all whitespace-nowrap",
                i === current && "text-signal",
                i < current && "text-green-400/80",
                i > current && "text-muted-foreground/30"
              )}>
                {s.short}
              </span>
            </button>
            {i < TOTAL_STEPS - 1 && (
              <div className={cn(
                "flex-1 h-px transition-colors duration-300",
                i < current ? "bg-green-500/40" : "bg-white/5"
              )} />
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
