import * as React from "react";
import { CheckIcon, ArrowLeftIcon } from "lucide-react";
import { Button } from "@frontend/components/ui/button";
import { cn } from "@frontend/lib/utils";
import { STEPS, TOTAL_STEPS, DEFAULT_WIZARD_DATA } from "./types";
import type { WizardData, StepProps } from "./types";

import { StepWelcome } from "./steps/StepWelcome";
import { StepRootFolders } from "./steps/StepRootFolders";
import { StepLibraryType } from "./steps/StepLibraryType";
import { StepProviderKeys } from "./steps/StepProviderKeys";
import { StepSonarrConnect } from "./steps/StepSonarrConnect";
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
  };

  const renderStep = () => {
    switch (step) {
      case 0: return <StepWelcome {...stepProps} />;
      case 1: return <StepRootFolders {...stepProps} />;
      case 2: return <StepLibraryType {...stepProps} />;
      case 3: return <StepProviderKeys {...stepProps} />;
      case 4: return <StepSonarrConnect {...stepProps} />;
      case 5: return <StepTheme {...stepProps} />;
      case 6: return <StepHealthCheck {...stepProps} />;
      case 7: return <StepDone {...stepProps} />;
      default: return null;
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-background">
      <div className="flex-1 flex flex-col items-center justify-center px-6 py-12">
        <div className="w-full max-w-2xl">
          <StepIndicator current={step} onGoTo={goTo} />

          <div key={animKey} className={cn(
            "transition-all duration-500 ease-out",
            direction === 'forward' ? "animate-slide-in-right" : "animate-slide-in-left"
          )}>
            {renderStep()}
          </div>

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
                  className="text-sm text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                >
                  Skip and set up manually
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepIndicator({ current, onGoTo }: { current: number; onGoTo: (i: number) => void }) {
  return (
    <div className="mb-12">
      <div className="flex items-center justify-between">
        {STEPS.map((s, i) => (
          <React.Fragment key={s.id}>
            <button
              onClick={() => i < current ? onGoTo(i) : null}
              className={cn(
                "flex flex-col items-center gap-1.5 group",
                i < current && "cursor-pointer",
                i >= current && "cursor-default"
              )}
            >
              <div className={cn(
                "flex items-center justify-center size-8 rounded-full border-2 text-xs font-mono font-bold transition-all duration-300",
                i === current && "border-signal bg-signal/10 text-signal scale-110 shadow-lg shadow-signal/20",
                i < current && "border-green-500/60 bg-green-500/10 text-green-400",
                i > current && "border-white/10 text-muted-foreground/30"
              )}>
                {i < current ? <CheckIcon className="size-3.5" /> : i + 1}
              </div>
              <span className={cn(
                "text-[10px] font-mono font-bold uppercase tracking-widest transition-all",
                i === current && "text-signal",
                i < current && "text-green-400/80",
                i > current && "text-muted-foreground/20"
              )}>
                {s.short}
              </span>
            </button>
            {i < TOTAL_STEPS - 1 && (
              <div className={cn(
                "flex-1 h-px mx-1 transition-colors duration-300",
                i < current ? "bg-green-500/40" : "bg-white/5"
              )} />
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
