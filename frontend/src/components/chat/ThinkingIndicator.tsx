import { Brain, Loader2 } from "lucide-react";

interface ThinkingIndicatorProps {
  content?: string;
  duration?: number;
}

export function ThinkingIndicator({ content, duration }: ThinkingIndicatorProps) {
  return (
    <div className="rounded-[10px] border border-[var(--border-accent)] bg-[var(--accent-light)] p-4">
      <div className="flex items-center gap-2 text-[var(--accent-primary)]">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm font-semibold">正在执行深度分析</span>
        {duration ? (
          <span className="rounded-md bg-[var(--bg-primary)] px-2 py-0.5 text-xs text-[var(--text-tertiary)]">
            {duration}秒
          </span>
        ) : null}
      </div>
      <div className="mt-3 flex items-start gap-2 text-sm text-[var(--text-secondary)]">
        <Brain className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-primary)]" />
        <p className="whitespace-pre-wrap leading-6">
          {content || ""}
          <span className="ml-1 inline-block h-4 w-1 animate-pulse bg-[var(--accent-primary)] align-middle" />
        </p>
      </div>
    </div>
  );
}
