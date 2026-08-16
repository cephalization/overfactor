import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { Session } from "@overfactor/sdk";
import { Columns2, FolderTree, Rows3 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useSessionDiff } from "@/lib/daemon.ts";

/**
 * Code surfaces are themed by pierre/shiki (never bridged onto shadcn
 * tokens); both follow the same OS color-scheme signal as the app shell.
 */
const DIFF_OPTIONS_BASE = {
  theme: { dark: "github-dark-default", light: "github-light-default" },
  themeType: "system",
  stickyHeader: true,
  lineDiffType: "word-alt",
} as const;

type DiffStyle = "unified" | "split";

function fileLabel(file: { name?: string; prevName?: string }): string {
  return file.name ?? file.prevName ?? "unknown file";
}

const GIT_STATUS_BY_CHANGE_TYPE: Record<FileDiffMetadata["type"], GitStatusEntry["status"]> = {
  new: "added",
  deleted: "deleted",
  change: "modified",
  "rename-pure": "renamed",
  "rename-changed": "renamed",
};

function ChangedFilesTree({ files }: { files: FileDiffMetadata[] }) {
  const paths = useMemo(() => files.map(fileLabel), [files]);
  const gitStatus = useMemo<GitStatusEntry[]>(
    () =>
      files.map((file) => ({
        path: fileLabel(file),
        status: GIT_STATUS_BY_CHANGE_TYPE[file.type],
      })),
    [files],
  );
  // The selection handler is registered once at model construction; read the
  // current paths through a ref so it never goes stale across refetches.
  const pathsRef = useRef(paths);
  pathsRef.current = paths;

  const { model } = useFileTree({
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    paths,
    gitStatus,
    onSelectionChange: (selected) => {
      const path = selected[0];
      if (path === undefined || !pathsRef.current.includes(path)) return;
      document.getElementById(`diff-${path}`)?.scrollIntoView({ behavior: "smooth" });
    },
  });

  // Live diffs change the file set between renders; the model is imperative.
  useEffect(() => {
    model.resetPaths(paths);
    model.setGitStatus(gitStatus);
  }, [model, paths, gitStatus]);

  return <FileTree model={model} style={{ height: "100%" }} />;
}

export function SessionDiff({ baseUrl, session }: { baseUrl: string; session: Session }) {
  const diff = useSessionDiff(baseUrl, session.id);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  const [treeOpen, setTreeOpen] = useState(true);

  const files = useMemo(() => {
    if (diff.data?.patch === undefined || diff.data.patch === null) return [];
    return parsePatchFiles(diff.data.patch, `session-${session.id}`).flatMap(
      (parsed) => parsed.files,
    );
  }, [diff.data, session.id]);

  if (diff.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (diff.isError) {
    return (
      <p className="text-sm text-destructive">Could not load the diff: {diff.error.message}</p>
    );
  }

  if (diff.data.patch === null) {
    return (
      <p className="text-sm text-muted-foreground">
        The diff for this worktree could not be computed.
      </p>
    );
  }

  if (files.length === 0) {
    return <p className="text-sm text-muted-foreground">The worktree is clean — no changes yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <Button
          variant={treeOpen ? "secondary" : "ghost"}
          size="sm"
          onClick={() => setTreeOpen((open) => !open)}
          title="Toggle file tree"
        >
          <FolderTree />
          <span className="text-xs">
            {files.length} {files.length === 1 ? "file" : "files"}
          </span>
        </Button>
        <div className="flex shrink-0 gap-1">
          <Button
            variant={diffStyle === "unified" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setDiffStyle("unified")}
            title="Unified"
          >
            <Rows3 />
            <span className="sr-only">Unified</span>
          </Button>
          <Button
            variant={diffStyle === "split" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setDiffStyle("split")}
            title="Split"
          >
            <Columns2 />
            <span className="sr-only">Split</span>
          </Button>
        </div>
      </div>
      <div className="flex items-start gap-4">
        {treeOpen && (
          <aside
            className="sticky top-2 h-[calc(100svh-1rem)] w-60 shrink-0 self-start overflow-hidden"
            // Blend the tree into the page WITHOUT `transparent`: the tree's
            // middle-truncation masks clipped glyphs by painting --trees-bg
            // behind the "…" marker, so the value must be a real color.
            style={{ "--trees-bg-override": "var(--background)" } as React.CSSProperties}
          >
            <ChangedFilesTree files={files} />
          </aside>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {files.map((file) => (
            <div key={fileLabel(file)} id={`diff-${fileLabel(file)}`} className="scroll-mt-14">
              <FileDiff fileDiff={file} options={{ ...DIFF_OPTIONS_BASE, diffStyle }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
