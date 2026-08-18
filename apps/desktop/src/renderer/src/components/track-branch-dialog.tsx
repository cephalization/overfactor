import type { ReviewSubject } from "@overfactor/sdk";
import { GitBranch, GitPullRequestArrow, LoaderCircle } from "lucide-react";
import { useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.tsx";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { useRepoBranches, useTrackBranch, useTrackPr } from "@/lib/daemon.ts";

const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

/**
 * Track work no local session produced: fuzzy-pick any local/remote branch,
 * or paste a GitHub PR URL (fetched into a local worktree). Either way a
 * Change Request appears in the sidebar and its guided review opens.
 */
export function TrackBranchDialog({
  baseUrl,
  repoPath,
  onOpenChange,
  onTracked,
}: {
  baseUrl: string;
  /** The repo to track a branch in; null keeps the dialog closed. */
  repoPath: string | null;
  onOpenChange: (open: boolean) => void;
  onTracked: (subject: ReviewSubject) => void;
}) {
  const [query, setQuery] = useState("");
  const branches = useRepoBranches(baseUrl, repoPath ?? "", repoPath !== null);
  const trackBranch = useTrackBranch(baseUrl);
  const trackPr = useTrackPr(baseUrl);

  const busy = trackBranch.isPending || trackPr.isPending;
  const error = trackBranch.error?.message ?? trackPr.error?.message ?? null;
  const isPrUrl = PR_URL.test(query.trim());

  const finish = (repo: string, branch: string): void => {
    onTracked({ repoPath: repo, branch });
    onOpenChange(false);
    setQuery("");
    trackBranch.reset();
    trackPr.reset();
  };

  return (
    <Dialog open={repoPath !== null} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 p-0 sm:max-w-md" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Track a branch or pull request</DialogTitle>
        </DialogHeader>
        <Command shouldFilter={!isPrUrl}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search branches or paste a GitHub PR URL…"
            disabled={busy}
          />
          <CommandList>
            {busy ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                {trackPr.isPending ? "Fetching PR and creating a worktree…" : "Tracking branch…"}
              </div>
            ) : isPrUrl ? (
              <CommandGroup heading="Pull request">
                <CommandItem
                  value={query}
                  onSelect={() => {
                    if (repoPath === null) return;
                    trackPr.mutate(
                      { repoPath, url: query.trim() },
                      { onSuccess: (cr) => finish(cr.repoPath, cr.branch) },
                    );
                  }}
                >
                  <GitPullRequestArrow />
                  <span className="truncate">Fetch {query.trim()} into a worktree</span>
                </CommandItem>
              </CommandGroup>
            ) : (
              <>
                <CommandEmpty>No branches match.</CommandEmpty>
                <CommandGroup heading="Branches">
                  {(branches.data?.branches ?? [])
                    .filter((branch) => branch !== branches.data?.defaultBranch)
                    .map((branch) => (
                      <CommandItem
                        key={branch}
                        value={branch}
                        onSelect={() => {
                          if (repoPath === null) return;
                          trackBranch.mutate(
                            { repoPath, branch },
                            { onSuccess: (cr) => finish(cr.repoPath, cr.branch) },
                          );
                        }}
                      >
                        <GitBranch />
                        <span className="truncate">{branch}</span>
                      </CommandItem>
                    ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
          {error !== null && !busy && (
            <p className="border-t px-3 py-2 text-xs text-destructive">{error}</p>
          )}
        </Command>
      </DialogContent>
    </Dialog>
  );
}
