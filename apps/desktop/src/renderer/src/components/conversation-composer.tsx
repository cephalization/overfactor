import type { Session } from "@overfactor/sdk";
import { ArrowUp, File as FileIcon, Paperclip, X } from "lucide-react";
import { type DragEvent, type FormEvent, type KeyboardEvent, useRef, useState } from "react";
import { z } from "zod";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group.tsx";
import { buildContinuationPrompt } from "@/lib/conversation.ts";
import { useContinueConversation } from "@/lib/daemon.ts";
import { cn } from "@/lib/utils.ts";

interface PendingAttachment {
  name: string;
  path: string;
}

const droppedPathSchema = z.string().min(1);

function fileName(file: File, path: string): string {
  return file.name || path.split(/[\\/]/).at(-1) || path;
}

export function ConversationComposer({ baseUrl, session }: { baseUrl: string; session: Session }) {
  const send = useContinueConversation(baseUrl);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);

  const addFiles = (files: FileList | readonly File[]): void => {
    const next: PendingAttachment[] = [];
    for (const file of files) {
      const parsed = droppedPathSchema.safeParse(window.overfactor.getPathForFile(file));
      if (!parsed.success) continue;
      next.push({ name: fileName(file, parsed.data), path: parsed.data });
    }
    if (next.length === 0) return;
    setAttachments((current) => {
      const paths = new Set(current.map((attachment) => attachment.path));
      return [...current, ...next.filter((attachment) => !paths.has(attachment.path))];
    });
  };

  const submit = async (): Promise<void> => {
    const prompt = buildContinuationPrompt(
      draft,
      attachments.map((attachment) => attachment.path),
    );
    if (prompt === "" || send.isPending) return;
    try {
      await send.mutateAsync({ sessionId: session.id, prompt });
      setDraft("");
      setAttachments([]);
    } catch {
      // The mutation exposes the daemon's validated error below the composer.
    }
  };

  const onDrop = (event: DragEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  };

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void submit();
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget;
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setDragging(false);
        }
      }}
      onDrop={onDrop}
      className={cn(
        "shrink-0 border-t bg-background px-4 py-3 transition-colors",
        dragging && "bg-accent/50",
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {attachments.length > 0 && (
          <AttachmentGroup aria-label="Files included with this message" className="gap-2 py-0">
            {attachments.map((attachment) => (
              <Attachment key={attachment.path} size="xs" className="max-w-72">
                <AttachmentMedia>
                  <FileIcon />
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle>{attachment.name}</AttachmentTitle>
                  <AttachmentDescription title={attachment.path}>
                    {attachment.path}
                  </AttachmentDescription>
                </AttachmentContent>
                <AttachmentActions>
                  <AttachmentAction
                    type="button"
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() =>
                      setAttachments((current) =>
                        current.filter((candidate) => candidate.path !== attachment.path),
                      )
                    }
                  >
                    <X />
                  </AttachmentAction>
                </AttachmentActions>
              </Attachment>
            ))}
          </AttachmentGroup>
        )}
        <InputGroup className={cn(dragging && "border-ring ring-3 ring-ring/30")}>
          <InputGroupTextarea
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              if (send.isError) send.reset();
            }}
            onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            placeholder={
              session.state === "working" ? "Queue a follow-up…" : "Continue the conversation…"
            }
            aria-label="Continue conversation"
            className="max-h-40 min-h-20"
            disabled={send.isPending}
          />
          <InputGroupAddon align="block-end" className="justify-between">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.currentTarget.files !== null) addFiles(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
            <InputGroupButton
              type="button"
              size="icon-xs"
              aria-label="Add files"
              title="Add files"
              onClick={() => fileInputRef.current?.click()}
              disabled={send.isPending}
            >
              <Paperclip />
            </InputGroupButton>
            <InputGroupButton
              type="submit"
              variant="default"
              size="icon-xs"
              aria-label="Send message"
              title="Send message"
              disabled={send.isPending || (draft.trim() === "" && attachments.length === 0)}
            >
              <ArrowUp />
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        {send.isError && <p className="text-xs text-destructive">{send.error.message}</p>}
        {dragging && <p className="text-xs text-muted-foreground">Drop to include file paths.</p>}
      </div>
    </form>
  );
}
