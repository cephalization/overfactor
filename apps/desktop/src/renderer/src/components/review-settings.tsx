import type { AgentKind, ReviewSettings } from "@overfactor/sdk";
import { Bot, Check, RotateCcw, Settings2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import {
  usePiReviewModels,
  useReviewSettings,
  useSetOnboardingCompleted,
  useUpdateReviewSettings,
} from "@/lib/daemon.ts";
import { cn } from "@/lib/utils.ts";

const AGENT_OPTIONS = [
  {
    agent: "claude-code" as const,
    label: "Claude Code",
    description: "Use the installed Claude Code CLI and its existing login.",
  },
  {
    agent: "pi" as const,
    label: "Pi",
    description: "Use Pi print mode with an authenticated provider and model.",
  },
];

/** Global defaults used by automatic PR reviews and the Generate/Regenerate actions. */
export function ReviewSettingsPage({ baseUrl }: { baseUrl: string }) {
  const settings = useReviewSettings(baseUrl);
  const update = useUpdateReviewSettings(baseUrl);
  const restartOnboarding = useSetOnboardingCompleted();
  const [agent, setAgent] = useState<AgentKind>("claude-code");
  const [claudeModel, setClaudeModel] = useState("sonnet");
  const [piProvider, setPiProvider] = useState("");
  const [piModel, setPiModel] = useState("");
  const piModels = usePiReviewModels(baseUrl, agent === "pi");

  useEffect(() => {
    if (settings.data === undefined) return;
    setAgent(settings.data.agent);
    if (settings.data.agent === "claude-code") {
      setClaudeModel(settings.data.model);
    } else {
      setPiProvider(settings.data.provider);
      setPiModel(settings.data.model);
    }
  }, [settings.data]);

  useEffect(() => {
    const first = piModels.data?.[0];
    if (agent !== "pi" || first === undefined || piProvider !== "" || piModel !== "") return;
    setPiProvider(first.provider);
    setPiModel(first.model);
  }, [agent, piModel, piModels.data, piProvider]);

  const providers = useMemo(
    () => [...new Set((piModels.data ?? []).map((option) => option.provider))],
    [piModels.data],
  );
  const models = useMemo(
    () =>
      (piModels.data ?? []).filter((option) => piProvider === "" || option.provider === piProvider),
    [piModels.data, piProvider],
  );

  const draft: ReviewSettings | null =
    agent === "claude-code"
      ? claudeModel.trim() === ""
        ? null
        : { agent, provider: null, model: claudeModel.trim() }
      : piProvider.trim() === "" || piModel.trim() === ""
        ? null
        : { agent, provider: piProvider.trim(), model: piModel.trim() };

  const save = () => {
    if (draft !== null) update.mutate(draft);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6 md:p-10">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg border bg-muted/40">
            <Settings2 className="size-5 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
            <p className="text-sm text-muted-foreground">
              Configure guided reviews and revisit app setup.
            </p>
          </div>
        </div>
        <Separator />

        <section className="flex flex-col gap-4">
          <div>
            <h2 className="text-base font-semibold">Default review agent</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Automatic PR reviews and manual generations use this agent. The selected model is
              always explicit, so Overfactor never inherits a harness&apos;s potentially expensive
              default.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {AGENT_OPTIONS.map((option) => (
              <button
                key={option.agent}
                type="button"
                aria-pressed={agent === option.agent}
                onClick={() => setAgent(option.agent)}
                className={cn(
                  "flex min-h-24 items-start gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  agent === option.agent && "border-primary bg-muted/50",
                )}
              >
                <Bot className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex items-center gap-2 font-medium">
                    {option.label}
                    {agent === option.agent && <Check className="size-4 text-primary" />}
                  </span>
                  <span className="text-sm text-muted-foreground">{option.description}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        <Separator />

        <section className="flex flex-col gap-4">
          <div>
            <h2 className="text-base font-semibold">Provider and model</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {agent === "claude-code"
                ? "Claude Code manages the provider and authentication; choose the model alias or ID passed to its CLI."
                : "Choose any provider/model pair Pi can authenticate to, including providers configured in models.json."}
            </p>
          </div>

          {settings.isPending ? (
            <p className="text-sm text-muted-foreground">Loading settings…</p>
          ) : settings.isError ? (
            <p className="text-sm text-destructive">Review settings could not be loaded.</p>
          ) : agent === "claude-code" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Provider">
                <Input value="Claude Code account" disabled />
              </Field>
              <Field label="Model">
                <Input
                  value={claudeModel}
                  onChange={(event) => setClaudeModel(event.target.value)}
                  placeholder="sonnet"
                  className="font-mono"
                />
              </Field>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Provider">
                <Input
                  value={piProvider}
                  onChange={(event) => setPiProvider(event.target.value)}
                  placeholder="openai-codex"
                  list="pi-review-providers"
                  className="font-mono"
                />
                <datalist id="pi-review-providers">
                  {providers.map((provider) => (
                    <option key={provider} value={provider} />
                  ))}
                </datalist>
              </Field>
              <Field label="Model">
                <Input
                  value={piModel}
                  onChange={(event) => setPiModel(event.target.value)}
                  placeholder="gpt-5.6-sol"
                  list="pi-review-models"
                  className="font-mono"
                />
                <datalist id="pi-review-models">
                  {models.map((option) => (
                    <option key={`${option.provider}/${option.model}`} value={option.model}>
                      {option.name}
                    </option>
                  ))}
                </datalist>
              </Field>
              {piModels.isPending && (
                <p className="sm:col-span-2 text-xs text-muted-foreground">
                  Loading authenticated Pi models…
                </p>
              )}
              {piModels.isError && (
                <p className="sm:col-span-2 text-xs text-muted-foreground">
                  Pi&apos;s model catalog could not be loaded. You can still enter a provider and
                  model manually.
                </p>
              )}
            </div>
          )}
        </section>

        <Separator />

        <section className="flex items-center justify-between gap-6 rounded-lg border bg-muted/20 p-4">
          <div>
            <h2 className="text-sm font-semibold">Onboarding</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Replay the product tour or reconsider which agent plugins to install.
            </p>
          </div>
          <Button
            variant="outline"
            className="shrink-0"
            disabled={restartOnboarding.isPending}
            onClick={() => restartOnboarding.mutate(false)}
          >
            <RotateCcw />
            Run onboarding again
          </Button>
        </section>

        <div className="flex items-center gap-3 border-t pt-5">
          <Button
            onClick={save}
            disabled={draft === null || settings.isPending || settings.isError || update.isPending}
          >
            {update.isPending ? "Saving…" : "Save review defaults"}
          </Button>
          {update.isSuccess && <p className="text-sm text-emerald-600">Saved</p>}
          {update.isError && <p className="text-sm text-destructive">{update.error.message}</p>}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-2 text-sm font-medium">
      {label}
      {children}
    </label>
  );
}
