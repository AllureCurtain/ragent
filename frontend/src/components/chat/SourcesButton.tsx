import { SourceIcon } from "@/components/chat/SourceIcon";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import type { SourceRef } from "@/types";

interface SourcesButtonProps {
  messageId: string;
  sources: SourceRef[];
}

export function SourcesButton({ messageId, sources }: SourcesButtonProps) {
  const openedSourceMessageId = useChatStore((state) => state.openedSourceMessageId);
  const toggleSourcesPanel = useChatStore((state) => state.toggleSourcesPanel);

  if (!sources || sources.length === 0) {
    return null;
  }

  const active = openedSourceMessageId === messageId;
  const preview = sources.slice(0, 3);

  return (
    <button
      type="button"
      onClick={() => toggleSourcesPanel(messageId)}
      className={cn(
        "inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors",
        active
          ? "bg-[var(--accent-light)] text-[var(--accent-primary)]"
          : "text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      )}
    >
      <span className="flex items-center">
        {preview.map((source, idx) => (
          <span
            key={`${source.docId}-${idx}`}
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-md bg-[var(--bg-primary)] ring-1 ring-[var(--border-default)]",
              idx > 0 && "-ml-1.5"
            )}
          >
            <SourceIcon source={source} className="h-3 w-3" />
          </span>
        ))}
      </span>
      {sources.length} 篇来源
    </button>
  );
}
