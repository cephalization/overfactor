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
 * Same minimal scrollbar treatment as globals.css, injected into pierre's
 * shadow roots (diff panes scroll horizontally, the tree vertically) where
 * page CSS cannot reach. Theme tokens inherit across shadow boundaries.
 */
export const SCROLLBAR_CSS = `
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb {
  background-color: color-mix(in oklab, var(--foreground, #888) 18%, transparent);
  border-radius: 999px;
  border: 3px solid transparent;
  background-clip: padding-box;
}
::-webkit-scrollbar-thumb:hover {
  background-color: color-mix(in oklab, var(--foreground, #888) 30%, transparent);
}
::-webkit-scrollbar-button { display: none; }
`;

/**
 * Code surfaces are themed by pierre/shiki (never bridged onto shadcn
 * tokens); both follow the same OS color-scheme signal as the app shell.
 */
export const DIFF_OPTIONS_BASE = {
  theme: { dark: "github-dark-default", light: "github-light-default" },
  themeType: "system",
  stickyHeader: true,
  lineDiffType: "word-alt",
  unsafeCSS: SCROLLBAR_CSS,
} as const;

type DiffStyle = "unified" | "split";
type TreeStyle = React.CSSProperties & { "--trees-bg-override": string };

const TREE_STYLE: TreeStyle = {
  "--trees-bg-override": "var(--background)",
};

export function fileLabel(file: { name?: string; prevName?: string }): string {
  return file.name ?? file.prevName ?? "unknown file";
}

const GIT_STATUS_BY_CHANGE_TYPE = {
  new: "added",
  deleted: "deleted",
  change: "modified",
  "rename-pure": "renamed",
  "rename-changed": "renamed",
} satisfies Record<FileDiffMetadata["type"], GitStatusEntry["status"]>;

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
    unsafeCSS: SCROLLBAR_CSS,
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

/**
 * Shared diff data for both review experiences; callers share one query cache
 * entry per session, so All files and Curated review never double-fetch.
 */
export function useDiffFiles(baseUrl: string, session: Session) {
  const diff = useSessionDiff(baseUrl, session.id);
  const files = useMemo(() => {
    if (diff.data?.patch === undefined || diff.data.patch === null) return [];
    return parsePatchFiles(diff.data.patch, `session-${session.id}`).flatMap(
      (parsed) => parsed.files,
    );
  }, [diff.data, session.id]);
  return { diff, files };
}

export function SessionDiff({ baseUrl, session }: { baseUrl: string; session: Session }) {
  const { diff, files } = useDiffFiles(baseUrl, session);
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  const [treeOpen, setTreeOpen] = useState(true);

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
            className="sticky top-2 h-[calc(100svh-8rem)] w-60 shrink-0 self-start overflow-hidden"
            // Blend the tree into the page WITHOUT `transparent`: the tree's
            // middle-truncation masks clipped glyphs by painting --trees-bg
            // behind the "…" marker, so the value must be a real color.
            style={TREE_STYLE}
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
