import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import type { Session } from "@overfactor/sdk";
import { Check } from "lucide-react";
import { useMemo, useState } from "react";
import { DIFF_OPTIONS_BASE, fileLabel, useDiffFiles } from "@/components/session-diff.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/utils.ts";

interface ChangeGroup {
  name: string;
  files: FileDiffMetadata[];
  insertions: number;
  deletions: number;
}

/**
 * Groups files by their top directory. A structural stand-in: the Guided
 * Review slice replaces this with generated intent groups (grouped by what
 * the change does, regenerated diff-aware), keeping this component's shape.
 */
function heuristicGroups(files: FileDiffMetadata[]): ChangeGroup[] {
  const byDir = new Map<string, FileDiffMetadata[]>();
  for (const file of files) {
    const label = fileLabel(file);
    const dir = label.includes("/") ? label.split("/").slice(0, 2).join("/") : "(root)";
    byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
  }
  return [...byDir.entries()].map(([name, groupFiles]) => ({
    name,
    files: groupFiles,
    insertions: groupFiles.reduce((sum, f) => sum + f.additionLines.length, 0),
    deletions: groupFiles.reduce((sum, f) => sum + f.deletionLines.length, 0),
  }));
}

export function CuratedReview({ baseUrl, session }: { baseUrl: string; session: Session }) {
  const { diff, files } = useDiffFiles(baseUrl, session);
  const groups = useMemo(() => heuristicGroups(files), [files]);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());

  if (diff.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (diff.isError || diff.data.patch === null) {
    return <p className="text-sm text-muted-foreground">The diff could not be loaded.</p>;
  }
  if (files.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">The worktree is clean — nothing to review.</p>
    );
  }

  const reviewedCount = groups.filter((g) => reviewed.has(g.name)).length;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-muted-foreground">
        Heuristic grouping by directory — generated intent groups arrive with Guided Review.{" "}
        {reviewedCount}/{groups.length} groups reviewed.
      </p>
      {groups.map((group) => {
        const isReviewed = reviewed.has(group.name);
        return (
          <section key={group.name} className={cn(isReviewed && "opacity-50")}>
            <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-background py-2">
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-sm font-semibold">{group.name}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {group.files.length} {group.files.length === 1 ? "file" : "files"} ·{" "}
                  <span className="text-emerald-600 dark:text-emerald-400">
                    +{group.insertions}
                  </span>{" "}
                  <span className="text-red-600 dark:text-red-400">−{group.deletions}</span>
                </span>
              </div>
              <Button
                variant={isReviewed ? "secondary" : "outline"}
                size="sm"
                onClick={() =>
                  setReviewed((current) => {
                    const next = new Set(current);
                    if (next.has(group.name)) next.delete(group.name);
                    else next.add(group.name);
                    return next;
                  })
                }
              >
                <Check className={cn(!isReviewed && "opacity-30")} />
                {isReviewed ? "Reviewed" : "Mark reviewed"}
              </Button>
            </div>
            <div className="flex flex-col gap-4 pt-3">
              {group.files.map((file) => (
                <FileDiff
                  key={fileLabel(file)}
                  fileDiff={file}
                  options={{ ...DIFF_OPTIONS_BASE, diffStyle: "unified" }}
                />
              ))}
            </div>
            <Separator className="mt-5" />
          </section>
        );
      })}
    </div>
  );
}
