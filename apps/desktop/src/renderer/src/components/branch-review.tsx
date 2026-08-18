import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import type { Review, ReviewSubject } from "@overfactor/sdk";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DIFF_OPTIONS_BASE, fileLabel } from "@/components/session-diff.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useBranchReview, useGenerateReview, useMarkGroupReviewed } from "@/lib/daemon.ts";
import { collapseReason } from "@/lib/diff-noise.ts";
import { cn } from "@/lib/utils.ts";

interface ReviewStep {
  name: string;
  summary: string | null;
  files: FileDiffMetadata[];
  /** Persisted group steps can be marked; the synthetic stale step cannot. */
  markable: boolean;
  reviewed: boolean;
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/** "packages/daemon/src/review.ts" → ["review.ts", "packages/daemon/src"] */
function splitPath(path: string): [string, string | null] {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? [path, null] : [path.slice(slash + 1), path.slice(0, slash)];
}

function FileChip({ file }: { file: FileDiffMetadata }) {
  const path = fileLabel(file);
  const [name, dir] = splitPath(path);
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent"
      onClick={() =>
        document
          .getElementById(`review-diff-${path}`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" })
      }
    >
      <span className="min-w-0 flex-1 truncate font-mono text-xs">
        <span className="text-foreground">{name}</span>
        {dir !== null && <span className="text-muted-foreground"> {dir}</span>}
      </span>
      <span className="shrink-0 font-mono text-xs">
        <span className="text-emerald-600 dark:text-emerald-400">+{file.additionLines.length}</span>{" "}
        <span className="text-red-600 dark:text-red-400">−{file.deletionLines.length}</span>
      </span>
    </button>
  );
}

/**
 * One file's diff within a step. Low-signal files (lockfiles, generated
 * output, very large diffs) start collapsed to a summary bar so the step's
 * handwritten changes carry the visual weight; one click expands.
 */
function StepFileDiff({ file }: { file: FileDiffMetadata }) {
  const path = fileLabel(file);
  const reason = collapseReason(path, file.additionLines.length + file.deletionLines.length);
  const [expanded, setExpanded] = useState(false);
  const [name, dir] = splitPath(path);

  if (reason === null) {
    return <FileDiff fileDiff={file} options={{ ...DIFF_OPTIONS_BASE, diffStyle: "unified" }} />;
  }
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        title={expanded ? `Hide ${path}` : `Show ${path}`}
        className="flex w-full items-center gap-2 rounded-md border border-dashed px-3 py-2 text-left transition-colors hover:bg-accent"
        onClick={() => setExpanded((current) => !current)}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs">
          <span className="text-foreground">{name}</span>
          {dir !== null && <span className="text-muted-foreground"> {dir}</span>}
        </span>
        <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px] text-muted-foreground">
          {reason}
        </Badge>
        <span className="shrink-0 font-mono text-xs">
          <span className="text-emerald-600 dark:text-emerald-400">
            +{file.additionLines.length}
          </span>{" "}
          <span className="text-red-600 dark:text-red-400">−{file.deletionLines.length}</span>
        </span>
        {expanded ? (
          <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <FileDiff fileDiff={file} options={{ ...DIFF_OPTIONS_BASE, diffStyle: "unified" }} />
      )}
    </div>
  );
}

function GuidedSteps({
  baseUrl,
  review,
  files,
  onStepChange,
}: {
  baseUrl: string;
  review: Review;
  files: FileDiffMetadata[];
  /** Fired when the visible step changes; the owner resets the pane scroll. */
  onStepChange: () => void;
}) {
  const markReviewed = useMarkGroupReviewed(baseUrl);
  const [stepIndex, setStepIndex] = useState(0);
  // Latest callback through a ref so the reset effect keys on the step alone.
  const onStepChangeRef = useRef(onStepChange);
  onStepChangeRef.current = onStepChange;

  const byPath = useMemo(() => new Map(files.map((file) => [fileLabel(file), file])), [files]);
  const steps = useMemo<ReviewStep[]>(() => {
    const grouped = review.groups
      .map((group) => ({
        name: group.name,
        summary: group.summary,
        files: group.files.flatMap((path) => byPath.get(path) ?? []),
        markable: true,
        reviewed: review.reviewedGroups.includes(group.name),
      }))
      .filter((step) => step.files.length > 0);
    // Files added to the diff after generation land nowhere; surface them as
    // a final step instead of hiding them so the walkthrough never silently
    // under-covers.
    const groupedPaths = new Set(review.groups.flatMap((group) => group.files));
    const stale = files.filter((file) => !groupedPaths.has(fileLabel(file)));
    if (stale.length > 0) {
      grouped.push({
        name: "New changes since generation",
        summary: "These files changed after the review was generated. Regenerate to fold them in.",
        files: stale,
        markable: false,
        reviewed: false,
      });
    }
    return grouped;
  }, [review, files, byPath]);

  // Regeneration can shrink the step list while an index is held.
  const current = Math.min(stepIndex, steps.length - 1);
  useEffect(() => {
    onStepChangeRef.current();
  }, [current]);
  const step = steps[current];
  if (step === undefined) return null;

  const markAndAdvance = () => {
    if (step.markable) {
      markReviewed.mutate({ reviewId: review.id, group: step.name, reviewed: !step.reviewed });
    }
    if (!step.reviewed && current < steps.length - 1) setStepIndex(current + 1);
  };

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(19rem,24rem)_minmax(0,1fr)]">
      {/* Viewport-bound and internally scrollable: a step with many files
          would otherwise grow the sticky aside past the window, leaving the
          nav and step list unreachable while the diffs scroll. */}
      <aside className="flex flex-col gap-5 self-start lg:sticky lg:top-6 lg:max-h-[calc(100svh-9rem)] lg:overflow-y-auto lg:pr-1">
        <p className="font-mono text-xs text-muted-foreground">
          {String(current + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}
        </p>
        <h2 className="text-xl font-semibold tracking-tight text-balance">{step.name}</h2>
        {step.summary !== null && step.summary !== "" && (
          <p className="text-sm leading-7 text-pretty text-foreground/75">{step.summary}</p>
        )}
        {/* Capped so a many-file step never pushes the nav and step list out
            of reach; the chip list scrolls on its own. */}
        <div className="flex max-h-[38svh] shrink-0 flex-col gap-1.5 overflow-y-auto">
          {step.files.map((file) => (
            <FileChip key={fileLabel(file)} file={file} />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label="Previous step"
            disabled={current === 0}
            onClick={() => setStepIndex(current - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Next step"
            disabled={current === steps.length - 1}
            onClick={() => setStepIndex(current + 1)}
          >
            <ChevronRight />
          </Button>
          {step.markable && (
            <Button
              variant={step.reviewed ? "secondary" : "default"}
              size="sm"
              className="flex-1"
              onClick={markAndAdvance}
            >
              <Check className={cn(!step.reviewed && "opacity-40")} />
              {step.reviewed ? "Reviewed" : "Mark reviewed"}
            </Button>
          )}
        </div>
        <nav className="flex flex-col gap-0.5 border-t pt-3">
          {steps.map((candidate, index) => (
            <button
              key={candidate.name}
              type="button"
              className={cn(
                "flex items-center gap-2 rounded px-2 py-1 text-left text-xs transition-colors hover:bg-accent",
                index === current ? "text-foreground" : "text-muted-foreground",
              )}
              onClick={() => setStepIndex(index)}
            >
              <span className="w-5 shrink-0 font-mono">{String(index + 1).padStart(2, "0")}</span>
              <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
              {candidate.reviewed && <Check className="size-3.5 shrink-0 text-emerald-500" />}
            </button>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-col gap-4">
        {step.files.map((file) => (
          <div key={fileLabel(file)} id={`review-diff-${fileLabel(file)}`} className="scroll-mt-4">
            <StepFileDiff file={file} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The branch-level guided review: the main-pane view opened from a sidebar
 * branch/CR row or a session's "View review" link. One review per
 * (repo, branch), shared by every session working on it.
 */
export function BranchReview({
  baseUrl,
  subject,
  crTitle,
}: {
  baseUrl: string;
  subject: ReviewSubject;
  crTitle: string | null;
}) {
  const reviewQuery = useBranchReview(baseUrl, subject);
  const generate = useGenerateReview(baseUrl);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Model alias for the next generation; empty means the engine's default.
  const [modelDraft, setModelDraft] = useState("");
  const modelOverride = modelDraft.trim() === "" ? null : modelDraft.trim();

  const patch = reviewQuery.data?.patch ?? null;
  const files = useMemo(() => {
    if (patch === null || patch.trim() === "") return [];
    return parsePatchFiles(patch, `review-${subject.repoPath}-${subject.branch}`).flatMap(
      (parsed) => parsed.files,
    );
  }, [patch, subject]);

  const review = reviewQuery.data?.review ?? null;
  const generating = review?.status === "generating";
  const insertions = files.reduce((sum, file) => sum + file.additionLines.length, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletionLines.length, 0);
  const reviewedCount =
    review === null
      ? 0
      : review.groups.filter((group) => review.reviewedGroups.includes(group.name)).length;

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[110rem] flex-col gap-4 p-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <GitBranch className="size-5 shrink-0 text-muted-foreground" />
            <h1 className="truncate text-xl font-semibold tracking-tight">
              {crTitle ?? subject.branch}
            </h1>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {crTitle !== null && (
              <span className="font-mono text-xs text-muted-foreground">{subject.branch}</span>
            )}
            <span className="font-mono text-xs text-muted-foreground">{subject.repoPath}</span>
          </div>
        </div>
        <Separator />
        {reviewQuery.isPending ? (
          <LoadingSkeleton />
        ) : reviewQuery.isError ? (
          <p className="text-sm text-muted-foreground">The review could not be loaded.</p>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-24 text-center">
            <div className="flex size-12 items-center justify-center rounded-full border">
              <CircleCheck className="size-5 text-muted-foreground" />
            </div>
            <h2 className="text-base font-semibold">Nothing to review</h2>
            <p className="max-w-md text-sm text-muted-foreground">
              This branch has no committed changes against the default branch and no uncommitted
              work in its worktree.
            </p>
          </div>
        ) : review === null || review.groups.length === 0 ? (
          <div className="flex flex-col items-center gap-4 py-24 text-center">
            <div className="flex size-12 items-center justify-center rounded-full border">
              {generating ? (
                <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
              ) : (
                <Sparkles className="size-5 text-muted-foreground" />
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <h2 className="text-base font-semibold">
                {generating ? "Generating the guided review…" : "No guided review yet"}
              </h2>
              <p className="max-w-md text-sm text-muted-foreground">
                {generating
                  ? "The engine is reading the diff and ordering it into a walkthrough. This usually takes under a minute."
                  : "Order this branch's changes into a review walkthrough — core changes first, supporting churn last — generated with the agent installed on this machine."}
              </p>
            </div>
            <p className="font-mono text-xs text-muted-foreground">
              {files.length} {files.length === 1 ? "file" : "files"} ·{" "}
              <span className="text-emerald-600 dark:text-emerald-400">+{insertions}</span>{" "}
              <span className="text-red-600 dark:text-red-400">−{deletions}</span>
            </p>
            {!generating && (
              <div className="flex flex-col items-center gap-2">
                <div className="flex items-center gap-2">
                  <Input
                    value={modelDraft}
                    onChange={(event) => setModelDraft(event.target.value)}
                    placeholder="sonnet"
                    aria-label="Model alias"
                    className="h-9 w-36 text-center font-mono text-xs md:text-xs"
                  />
                  <Button
                    onClick={() => generate.mutate({ subject, model: modelOverride })}
                    disabled={generate.isPending}
                  >
                    <Sparkles />
                    Generate review
                  </Button>
                </div>
                {/* Approximate — the real invocation pipes the prompt via stdin. */}
                <p className="font-mono text-[11px] text-muted-foreground/70">
                  $ claude -p --output-format json --model {modelOverride ?? "sonnet"} &lt;
                  review-prompt
                </p>
              </div>
            )}
            {review?.status === "failed" && review.error !== null && (
              <p className="max-w-md text-xs text-destructive">
                Last attempt failed: {review.error}
              </p>
            )}
            {generate.isError && (
              <p className="max-w-md text-xs text-destructive">{generate.error.message}</p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {reviewedCount}/{review.groups.length} steps reviewed ·{" "}
                <span className="font-mono">
                  {review.engine}
                  {review.model !== null && ` (${review.model})`}
                </span>
                {review.status === "failed" && review.error !== null && (
                  <span className="text-destructive"> · regeneration failed: {review.error}</span>
                )}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => generate.mutate({ subject, model: review.model })}
                disabled={generating || generate.isPending}
              >
                {generating ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                {generating ? "Regenerating…" : "Regenerate"}
              </Button>
            </div>
            {generate.isError && (
              <p className="text-xs text-destructive">{generate.error.message}</p>
            )}
            <div className={cn(generating && "pointer-events-none opacity-60")}>
              <GuidedSteps
                baseUrl={baseUrl}
                review={review}
                files={files}
                onStepChange={() => scrollRef.current?.scrollTo({ top: 0 })}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
