import type { AgentKind, AgentSetupStatus } from "@overfactor/sdk";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  CircleCheck,
  GitBranch,
  GitPullRequest,
  Layers3,
  MessageSquareText,
  PlugZap,
  Radio,
  Sparkles,
  Terminal,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { AGENT_SETUP_OPTIONS } from "@/lib/agent-setup.ts";
import { cn } from "@/lib/utils.ts";
import { useAgentSetup, useInstallAgent, useSetOnboardingCompleted } from "@/lib/daemon.ts";

const STEPS = ["Meet Overfactor", "Connect agents", "Review with context"] as const;

export function Onboarding() {
  const [step, setStep] = useState(0);
  const [selectedAgents, setSelectedAgents] = useState<AgentKind[]>(["claude-code", "pi"]);
  const [installError, setInstallError] = useState<string | null>(null);
  const setup = useAgentSetup();
  const installAgent = useInstallAgent();
  const complete = useSetOnboardingCompleted();

  const statuses = setup.data ?? [];
  const isInstalled = (agent: AgentKind): boolean =>
    statuses.some((status) => status.agent === agent && status.installed);
  const selectedToInstall = selectedAgents.filter((agent) => !isInstalled(agent));

  const toggleAgent = (agent: AgentKind): void => {
    if (isInstalled(agent) || installAgent.isPending) return;
    setSelectedAgents((current) =>
      current.includes(agent) ? current.filter((item) => item !== agent) : [...current, agent],
    );
  };

  const finish = (): void => {
    if (!complete.isPending) complete.mutate(true);
  };

  const advance = async (): Promise<void> => {
    if (step !== 1) {
      if (step === STEPS.length - 1) finish();
      else setStep((current) => current + 1);
      return;
    }

    if (selectedToInstall.length === 0) {
      setStep(2);
      return;
    }

    setInstallError(null);
    try {
      for (const agent of selectedToInstall) await installAgent.mutateAsync(agent);
      await setup.refetch();
      setStep(2);
    } catch (raised) {
      setInstallError(raised instanceof Error ? raised.message : "Could not install integration");
    }
  };

  return (
    <div className="relative flex h-svh flex-col overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="onboarding-orb absolute -top-44 left-[12%] size-[30rem] rounded-full bg-foreground/[0.04] blur-3xl" />
        <div className="onboarding-orb onboarding-orb-delayed absolute -right-40 bottom-[-15rem] size-[34rem] rounded-full bg-foreground/[0.03] blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,color-mix(in_oklab,var(--foreground)_4%,transparent)_1px,transparent_1px)] bg-[size:28px_28px] [mask-image:linear-gradient(to_bottom,black,transparent_75%)]" />
      </div>

      <header className="relative z-10 flex h-14 shrink-0 items-center justify-between px-7">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg border bg-foreground text-background shadow-sm">
            <Layers3 className="size-4" />
          </div>
          <span className="text-sm font-semibold tracking-tight">Overfactor</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={finish}
          disabled={complete.isPending || installAgent.isPending}
        >
          Skip setup
        </Button>
      </header>

      <main className="relative z-10 flex min-h-0 flex-1 items-center px-7 py-2">
        <div className="mx-auto w-full max-w-6xl">
          <StepProgress current={step} />
          <div key={step} className="onboarding-step mt-5">
            {step === 0 ? (
              <WelcomeStep />
            ) : step === 1 ? (
              <AgentStep
                statuses={statuses}
                selected={selectedAgents}
                loading={setup.isLoading}
                installing={installAgent.isPending}
                error={installError ?? setup.error?.message ?? null}
                onToggle={toggleAgent}
              />
            ) : (
              <ReviewStep />
            )}
          </div>
        </div>
      </main>

      <footer className="relative z-10 flex h-16 shrink-0 items-center border-t border-border/60 bg-background/70 px-7 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between">
          <div className="min-w-36">
            {step > 0 ? (
              <Button variant="ghost" onClick={() => setStep((current) => current - 1)}>
                <ChevronLeft />
                Back
              </Button>
            ) : null}
          </div>
          <p
            className={cn(
              "hidden text-xs text-muted-foreground sm:block",
              complete.error !== null && "text-destructive",
            )}
          >
            {complete.error?.message ?? "Setup stays local to this machine."}
          </p>
          <div className="flex min-w-36 justify-end">
            <Button
              size="lg"
              onClick={() => void advance()}
              disabled={installAgent.isPending || complete.isPending}
            >
              {step === 1 && selectedToInstall.length > 0
                ? `Install ${selectedToInstall.length} selected`
                : step === STEPS.length - 1
                  ? "Open Overfactor"
                  : "Continue"}
              {installAgent.isPending ? (
                <span className="size-3.5 animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground" />
              ) : (
                <ArrowRight />
              )}
            </Button>
          </div>
        </div>
      </footer>
    </div>
  );
}

function StepProgress({ current }: { current: number }) {
  return (
    <div className="flex items-center justify-center gap-2" aria-label={`Step ${current + 1} of 3`}>
      {STEPS.map((label, index) => (
        <div key={label} className="flex items-center gap-2">
          <div
            className={cn(
              "flex h-7 items-center gap-2 rounded-full border px-2.5 text-xs transition-all duration-500",
              index === current
                ? "border-foreground/15 bg-foreground text-background shadow-sm"
                : index < current
                  ? "border-foreground/10 bg-foreground/5 text-foreground"
                  : "border-transparent text-muted-foreground",
            )}
          >
            <span className="flex size-4 items-center justify-center">
              {index < current ? <Check className="size-3" /> : index + 1}
            </span>
            <span className={cn("hidden sm:inline", index !== current && "lg:hidden")}>
              {label}
            </span>
          </div>
          {index < STEPS.length - 1 ? <div className="h-px w-6 bg-border" /> : null}
        </div>
      ))}
    </div>
  );
}

function WelcomeStep() {
  return (
    <div className="grid items-center gap-8 md:grid-cols-[0.82fr_1.18fr] md:gap-10">
      <section className="max-w-xl">
        <Badge variant="outline" className="mb-4 bg-background/60 backdrop-blur">
          <Radio />
          Local-first agent workspace
        </Badge>
        <h1 className="text-4xl font-semibold tracking-[-0.04em] text-balance">
          See the work behind every agent session.
        </h1>
        <p className="mt-3 max-w-lg text-sm leading-6 text-muted-foreground">
          Overfactor gathers coding-agent sessions, transcripts, branches, and diffs into one quiet
          place—then turns a branch into a guided review you can actually follow.
        </p>
        <div className="mt-5 grid gap-2 text-sm">
          <Prerequisite
            icon={<GitBranch />}
            title="A Git repo"
            detail="Work stays in your checkout."
          />
          <Prerequisite
            icon={<Terminal />}
            title="An agent CLI"
            detail="Claude Code, Pi, or both."
          />
          <Prerequisite
            icon={<GitPullRequest />}
            title="GitHub optional"
            detail="gh unlocks PR detection."
          />
        </div>
      </section>
      <SystemMock />
    </div>
  );
}

function Prerequisite({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex gap-3 rounded-xl border border-border/70 bg-background/55 px-3 py-2.5 shadow-sm backdrop-blur">
      <div className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</div>
      <div>
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function SystemMock() {
  return (
    <div className="relative mx-auto w-full max-w-2xl">
      <div className="absolute -inset-8 rounded-[2rem] bg-foreground/[0.04] blur-2xl" />
      <div className="relative overflow-hidden rounded-2xl border border-foreground/10 bg-card/85 shadow-2xl shadow-foreground/5 backdrop-blur-xl">
        <div className="flex h-9 items-center gap-1.5 border-b px-4">
          <span className="size-2 rounded-full bg-foreground/15" />
          <span className="size-2 rounded-full bg-foreground/10" />
          <span className="size-2 rounded-full bg-foreground/10" />
          <span className="ml-3 font-mono text-[10px] text-muted-foreground">agent-workspace</span>
        </div>
        <div className="grid min-h-72 grid-cols-[10.5rem_1fr]">
          <div className="border-r bg-muted/25 p-3">
            <p className="px-2 text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
              Repositories
            </p>
            <div className="mt-3 rounded-lg bg-foreground/[0.055] p-2.5">
              <div className="flex items-center gap-2 text-xs font-medium">
                <GitBranch className="size-3.5" /> acme/web
              </div>
              <div className="mt-3 space-y-2 pl-2">
                <MockSession state="bg-emerald-500" label="Improve checkout flow" />
                <MockSession state="bg-amber-500" label="Fix flaky payment test" />
                <MockSession state="bg-foreground/25" label="Refine account settings" />
              </div>
            </div>
          </div>
          <div className="p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-muted-foreground">feat/checkout</p>
                <p className="mt-1 text-sm font-semibold">Improve checkout flow</p>
              </div>
              <Badge variant="secondary" className="text-[10px]">
                working
              </Badge>
            </div>
            <div className="mt-7 space-y-4">
              <div className="ml-auto w-3/4 rounded-xl rounded-br-sm bg-muted px-3 py-2 text-[11px] leading-5">
                Make the checkout recovery path easier to understand.
              </div>
              <div className="space-y-2">
                <div className="h-2 w-4/5 rounded-full bg-foreground/10" />
                <div className="h-2 w-full rounded-full bg-foreground/[0.07]" />
                <div className="h-2 w-2/3 rounded-full bg-foreground/[0.07]" />
              </div>
              <div className="rounded-lg border bg-background/70 p-3 font-mono text-[10px]">
                <p className="text-muted-foreground">src/checkout/recovery.ts</p>
                <p className="mt-2 text-emerald-600 dark:text-emerald-400">
                  + return retryPayment(order)
                </p>
                <p className="text-rose-600 dark:text-rose-400">- throw new Error("failed")</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MockSession({ state, label }: { state: string; label: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", state)} />
      <span className="truncate">{label}</span>
    </div>
  );
}

function AgentStep({
  statuses,
  selected,
  loading,
  installing,
  error,
  onToggle,
}: {
  statuses: AgentSetupStatus[];
  selected: AgentKind[];
  loading: boolean;
  installing: boolean;
  error: string | null;
  onToggle: (agent: AgentKind) => void;
}) {
  const installed = (agent: AgentKind): boolean =>
    statuses.some((status) => status.agent === agent && status.installed);

  return (
    <div className="mx-auto max-w-5xl">
      <section className="mx-auto max-w-2xl text-center">
        <Badge variant="outline" className="mb-3 bg-background/60 backdrop-blur">
          <PlugZap />
          Native integrations
        </Badge>
        <h1 className="text-3xl font-semibold tracking-[-0.04em] text-balance">
          Connect the agents you use.
        </h1>
        <p className="mt-2 text-[13px] leading-5 text-muted-foreground">
          Integrations run through each agent&apos;s own hook system. No terminal capture, screen
          scraping, or cloud account is involved.
        </p>
      </section>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {AGENT_SETUP_OPTIONS.map((agent) => {
          const isInstalled = installed(agent.agent);
          const isSelected = selected.includes(agent.agent);
          return (
            <button
              key={agent.agent}
              type="button"
              aria-pressed={isSelected || isInstalled}
              disabled={loading || installing || isInstalled}
              onClick={() => onToggle(agent.agent)}
              className={cn(
                "group relative h-52 overflow-hidden rounded-2xl border bg-card/75 p-4 text-left shadow-sm backdrop-blur transition-all duration-300 outline-none",
                "hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-lg focus-visible:ring-4 focus-visible:ring-ring/30",
                (isSelected || isInstalled) && "border-foreground/25 ring-1 ring-foreground/10",
                isInstalled && "cursor-default",
              )}
            >
              <div className="flex items-start justify-between">
                <div className="flex size-10 items-center justify-center rounded-xl border bg-background text-lg font-semibold shadow-sm">
                  {agent.monogram}
                </div>
                <div
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border transition-colors",
                    isInstalled
                      ? "border-emerald-500 bg-emerald-500 text-white"
                      : isSelected
                        ? "border-foreground bg-foreground text-background"
                        : "bg-background text-transparent",
                  )}
                >
                  <Check className="size-3.5" />
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <h2 className="text-base font-semibold">{agent.name}</h2>
                {isInstalled ? (
                  <Badge
                    variant="secondary"
                    className="text-[10px] text-emerald-700 dark:text-emerald-300"
                  >
                    Installed
                  </Badge>
                ) : null}
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                {agent.description} {agent.benefit}
              </p>
              <div className="mt-3 flex items-center gap-2 border-t pt-2.5 text-[10px] text-muted-foreground">
                <CircleCheck className="size-3.5" />
                {agent.reload}
              </div>
            </button>
          );
        })}
      </div>
      <div className="mt-3 min-h-5 text-center text-xs text-muted-foreground">
        {loading ? "Checking your user settings…" : null}
        {!loading && error === null
          ? "Choose either integration, both, or continue without installing one yet."
          : null}
        {error !== null ? <span className="text-destructive">{error}</span> : null}
      </div>
    </div>
  );
}

function ReviewStep() {
  return (
    <div className="grid items-center gap-8 md:grid-cols-[0.76fr_1.24fr] md:gap-10">
      <section className="max-w-xl">
        <Badge variant="outline" className="mb-4 bg-background/60 backdrop-blur">
          <Sparkles />
          Curated review
        </Badge>
        <h1 className="text-3xl font-semibold tracking-[-0.04em] text-balance">
          Review intent, not a wall of files.
        </h1>
        <p className="mt-2 max-w-lg text-[13px] leading-5 text-muted-foreground">
          Overfactor groups sessions by repository and branch. A curated review then arranges the
          branch diff into a guided sequence: core behavior first, wiring and tests next, mechanical
          changes last.
        </p>
        <div className="mt-4 space-y-2.5">
          <Explanation icon={<GitBranch />} title="Repository + branch">
            Sessions working on the same branch share one change request and one review.
          </Explanation>
          <Explanation icon={<MessageSquareText />} title="Sessions preserve the why">
            Titles and transcripts stay attached so review generation has intent, not just a patch.
          </Explanation>
          <Explanation icon={<Sparkles />} title="Review steps stay durable">
            Mark steps reviewed; unchanged groups keep their state when the diff is regenerated.
          </Explanation>
        </div>
      </section>
      <ReviewMock />
    </div>
  );
}

function Explanation({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border bg-background/70 text-muted-foreground shadow-sm [&_svg]:size-3.5">
        {icon}
      </div>
      <div>
        <p className="text-[13px] font-medium">{title}</p>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{children}</p>
      </div>
    </div>
  );
}

function ReviewMock() {
  return (
    <div className="relative mx-auto w-full max-w-2xl">
      <div className="absolute -inset-8 rounded-[2rem] bg-foreground/[0.04] blur-2xl" />
      <div className="relative overflow-hidden rounded-2xl border border-foreground/10 bg-card/90 shadow-2xl shadow-foreground/5 backdrop-blur-xl">
        <div className="flex h-10 items-center justify-between border-b px-4">
          <div className="flex items-center gap-2 text-xs font-medium">
            <GitPullRequest className="size-3.5 text-muted-foreground" />
            feat/checkout-recovery
          </div>
          <Badge variant="outline" className="text-[9px]">
            claude-code · sonnet
          </Badge>
        </div>
        <div className="grid min-h-72 grid-cols-[11rem_1fr]">
          <div className="border-r bg-muted/20 p-3">
            <p className="px-1 text-[9px] font-semibold tracking-widest text-muted-foreground uppercase">
              Review path
            </p>
            <div className="mt-3 space-y-1.5">
              <ReviewNavItem number="1" title="Recovery state model" active />
              <ReviewNavItem number="2" title="Checkout wiring" />
              <ReviewNavItem number="3" title="Failure-path tests" reviewed />
              <ReviewNavItem number="4" title="Supporting changes" />
            </div>
            <div className="mt-6 rounded-lg border bg-background/60 p-2.5">
              <p className="text-[9px] text-muted-foreground">Contributing sessions</p>
              <p className="mt-1.5 text-[10px] font-medium">Improve checkout flow</p>
              <p className="mt-1 text-[10px] font-medium">Fix payment retry test</p>
            </div>
          </div>
          <div className="p-5">
            <div className="flex items-center gap-2 text-[10px] font-medium text-muted-foreground">
              <span className="flex size-5 items-center justify-center rounded-full bg-muted">
                1
              </span>
              CORE BEHAVIOR
            </div>
            <h3 className="mt-3 text-base font-semibold">Recovery state model</h3>
            <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
              Start here to verify how a failed payment becomes recoverable and which states may
              retry safely.
            </p>
            <div className="mt-5 overflow-hidden rounded-lg border bg-background/70">
              <div className="flex h-8 items-center justify-between border-b px-3 font-mono text-[9px]">
                <span>src/checkout/recovery.ts</span>
                <span className="text-muted-foreground">+32 −8</span>
              </div>
              <div className="space-y-1.5 p-3 font-mono text-[9px]">
                <p className="text-muted-foreground">@@ recoverPayment(order)</p>
                <p className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                  + if (order.canRetry) return retry(order)
                </p>
                <p className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                  + return requireNewMethod(order)
                </p>
                <p className="bg-rose-500/10 text-rose-700 dark:text-rose-300">
                  - throw paymentError
                </p>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span className="text-[10px] text-muted-foreground">1 of 4 steps · 2 files</span>
              <div className="rounded-md bg-foreground px-2.5 py-1.5 text-[10px] font-medium text-background">
                Mark reviewed
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewNavItem({
  number,
  title,
  active = false,
  reviewed = false,
}: {
  number: string;
  title: string;
  active?: boolean;
  reviewed?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg px-2 py-2 text-[10px] text-muted-foreground",
        active && "bg-foreground text-background shadow-sm",
      )}
    >
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border text-[9px]",
          active && "border-background/20",
          reviewed && "border-emerald-500 bg-emerald-500 text-white",
        )}
      >
        {reviewed ? <Check className="size-3" /> : number}
      </span>
      <span className="truncate">{title}</span>
    </div>
  );
}
