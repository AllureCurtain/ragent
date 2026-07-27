import * as React from "react";
import { Brain, Send, Square } from "lucide-react";

import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";

export function ChatInput() {
  const [value, setValue] = React.useState("");
  const [isFocused, setIsFocused] = React.useState(false);
  const isComposingRef = React.useRef(false);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const {
    sendMessage,
    isStreaming,
    cancelGeneration,
    deepThinkingEnabled,
    setDeepThinkingEnabled,
    inputFocusKey
  } = useChatStore();

  const focusInput = React.useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
  }, []);

  const adjustHeight = React.useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, 160);
    el.style.height = `${next}px`;
  }, []);

  React.useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  React.useEffect(() => {
    if (!inputFocusKey) return;
    focusInput();
  }, [inputFocusKey, focusInput]);

  const handleSubmit = async () => {
    if (isStreaming) {
      cancelGeneration();
      focusInput();
      return;
    }
    if (!value.trim()) return;
    const next = value;
    setValue("");
    focusInput();
    await sendMessage(next);
    focusInput();
  };

  const hasContent = value.trim().length > 0;

  return (
    <div className="space-y-2">
      <div
        className={cn(
          "relative flex flex-col rounded-[14px] border bg-[var(--bg-primary)] px-3 pb-2.5 pt-2.5 shadow-[var(--shadow-sm)] transition-[border-color,box-shadow] duration-200",
          isFocused
            ? "border-[var(--border-focus)] shadow-[0_0_0_3px_var(--accent-light),var(--shadow-md)]"
            : "border-[var(--border-default)] hover:border-[var(--border-focus)]"
        )}
      >
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={deepThinkingEnabled ? "输入需要深度分析的问题" : "输入问题，NexusQA 将检索知识库后回答"}
          className="max-h-40 min-h-[46px] w-full resize-none border-0 bg-transparent px-1.5 py-1.5 text-[15px] leading-6 text-[var(--text-primary)] shadow-none placeholder:text-[var(--text-muted)] focus-visible:border-0 focus-visible:ring-0"
          rows={1}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              const nativeEvent = event.nativeEvent as KeyboardEvent;
              if (nativeEvent.isComposing || isComposingRef.current || nativeEvent.keyCode === 229) {
                return;
              }
              event.preventDefault();
              handleSubmit();
            }
          }}
          aria-label="聊天输入框"
        />
        <div className="mt-2 flex items-center gap-2 border-t border-[var(--border-light)] pt-2">
          <button
            type="button"
            onClick={() => setDeepThinkingEnabled(!deepThinkingEnabled)}
            disabled={isStreaming}
            aria-pressed={deepThinkingEnabled}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition-colors",
              deepThinkingEnabled
                ? "border-[var(--border-accent)] bg-[var(--accent-light)] text-[var(--accent-primary)]"
                : "border-transparent bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]",
              isStreaming && "cursor-not-allowed opacity-60"
            )}
          >
            <Brain className="h-3.5 w-3.5" />
            深度思考
          </button>
          {deepThinkingEnabled ? (
            <span className="hidden text-[11px] text-[var(--text-tertiary)] sm:inline" aria-live="polite">
              将执行更完整的分析链路
            </span>
          ) : null}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!hasContent && !isStreaming}
            aria-label={isStreaming ? "停止生成" : "发送消息"}
            className={cn(
              "ml-auto flex h-9 w-9 items-center justify-center rounded-[10px] transition-colors duration-200",
              isStreaming
                ? "bg-destructive/10 text-destructive hover:bg-destructive/15"
                : hasContent
                  ? "bg-[var(--accent-primary)] text-[var(--text-on-accent)] hover:bg-[var(--accent-hover)]"
                  : "cursor-not-allowed bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
            )}
          >
            {isStreaming ? <Square className="h-4 w-4" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>
      {isStreaming ? (
        <p className="text-center text-[11px] text-[var(--text-tertiary)]" aria-live="polite">
          正在生成回答，可随时停止
        </p>
      ) : null}
    </div>
  );
}
