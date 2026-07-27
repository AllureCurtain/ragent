import { ChevronDown, Loader2, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import type { Message } from "@/types";

interface RecommendedQuestionsButtonProps {
  message: Message;
}

export function RecommendedQuestionsButton({ message }: RecommendedQuestionsButtonProps) {
  const toggleRecommended = useChatStore((state) => state.toggleRecommended);

  const open = Boolean(message.recommendedOpen);
  // 生成中转圈；手动触发即展开，loading 必然可见
  const spinning = message.recommendedState === "loading";

  return (
    <button
      type="button"
      onClick={() => toggleRecommended(message.id)}
      disabled={spinning}
      aria-expanded={open}
      className={cn(
        "inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors",
        open
          ? "bg-[var(--accent-light)] text-[var(--accent-primary)]"
          : "text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
        spinning && "cursor-wait opacity-80"
      )}
    >
      {spinning ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Sparkles className="h-3.5 w-3.5" />
      )}
      推荐问题
      <ChevronDown
        className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
        aria-hidden="true"
      />
    </button>
  );
}
