import type { AgentKind } from "@overfactor/sdk";
import { Check, PlugZap } from "lucide-react";
import { useEffect } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { AGENT_SETUP_OPTIONS } from "@/lib/agent-setup.ts";
import { useAgentSetup, useInstallAgent } from "@/lib/daemon.ts";

export function PluginManagerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const setup = useAgentSetup();
  const install = useInstallAgent();

  useEffect(() => {
    if (open) void setup.refetch();
  }, [open, setup.refetch]);

  const installed = (agent: AgentKind): boolean =>
    setup.data?.some((status) => status.agent === agent && status.installed) ?? false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-lg border bg-muted/40">
            <PlugZap className="size-4.5 text-muted-foreground" />
          </div>
          <DialogTitle>Agent plugins</DialogTitle>
          <DialogDescription>
            Connect another coding agent at any time. Plugins use each agent&apos;s native
            user-level hook or extension system.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          {AGENT_SETUP_OPTIONS.map((option) => {
            const isInstalled = installed(option.agent);
            const isInstalling = install.isPending && install.variables === option.agent;
            return (
              <div
                key={option.agent}
                className="flex min-h-60 flex-col rounded-xl border bg-card p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex size-10 items-center justify-center rounded-lg border bg-background text-lg font-semibold">
                    {option.monogram}
                  </div>
                  {isInstalled ? (
                    <Badge variant="secondary" className="text-emerald-700 dark:text-emerald-300">
                      <Check /> Installed
                    </Badge>
                  ) : null}
                </div>
                <h3 className="mt-4 font-semibold">{option.name}</h3>
                <p className="mt-2 text-sm leading-5 text-muted-foreground">
                  {option.description} {option.benefit}
                </p>
                <p className="mt-3 text-xs leading-5 text-muted-foreground">{option.reload}</p>
                <div className="mt-auto pt-4">
                  <Button
                    className="w-full"
                    variant={isInstalled ? "secondary" : "default"}
                    disabled={isInstalled || setup.isLoading || install.isPending}
                    onClick={() => install.mutate(option.agent)}
                  >
                    {isInstalled
                      ? "Installed"
                      : isInstalling
                        ? "Installing…"
                        : `Install ${option.name}`}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        {setup.isLoading ? (
          <p className="text-xs text-muted-foreground">Checking your user settings…</p>
        ) : null}
        {setup.isError ? (
          <p className="text-xs text-destructive">Plugin status could not be loaded.</p>
        ) : null}
        {install.isError ? (
          <p className="text-xs text-destructive">{install.error.message}</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
