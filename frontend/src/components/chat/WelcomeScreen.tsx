import * as React from "react";
import { ArrowUpRight, BookOpen, Bot, Brain, Check, Lightbulb, Send, Square } from "lucide-react";

import { cn } from "@/lib/utils";
import { listSampleQuestions } from "@/services/sampleQuestionService";
import { useChatStore } from "@/stores/chatStore";

type PromptPreset = {
  id?: string;
  title: string;
  description: string;
  prompt: string;
  icon: React.ComponentType<{ className?: string }>;
};

const PRESET_ICONS = [BookOpen, Check, Lightbulb];

const DEFAULT_PRESETS: PromptPreset[] = [
  {
    title: "内容总结",
    description: "提炼 3-5 条关键信息与行动点",
    prompt: "请帮我总结以下内容，并列出3-5条要点：",
    icon: BookOpen
  },
  {
    title: "任务拆解",
    description: "把目标拆成可执行步骤与优先级",
    prompt: "请把下面需求拆解为步骤，并给出优先级和里程碑：",
    icon: Check
  },
  {
    title: "灵感扩展",
    description: "给出多个方案并比较优缺点",
    prompt: "围绕以下主题给出5-8个方案，并注明优缺点：",
    icon: Lightbulb
  }
];

export function WelcomeScreen() {
  const [value, setValue] = React.useState("");
  const [isFocused, setIsFocused] = React.useState(false);
  const [promptPresets, setPromptPresets] = React.useState<PromptPreset[]>(DEFAULT_PRESETS);
  const isComposingRef = React.useRef(false);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const { sendMessage, isStreaming, cancelGeneration, deepThinkingEnabled, setDeepThinkingEnabled } =
    useChatStore();

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
    let active = true;

    const loadPresets = async () => {
      const data = await listSampleQuestions().catch(() => null);
      if (!active || !data || data.length === 0) {
        return;
      }
      const mapped = data
        .filter((item) => item.question && item.question.trim())
        .slice(0, 3)
        .map((item, index) => {
          const question = item.question.trim();
          const title =
            item.title?.trim() ||
            (question.length > 12 ? `${question.slice(0, 12)}...` : question) ||
            `推荐问法 ${index + 1}`;
          const description = item.description?.trim() || "直接点选即可开始对话";
          return {
            id: item.id,
            title,
            description,
            prompt: question,
            icon: PRESET_ICONS[index % PRESET_ICONS.length]
          };
        });
      if (mapped.length > 0) {
        setPromptPresets(mapped);
      }
    };

    loadPresets();
    return () => {
      active = false;
    };
  }, []);

  const applyPreset = React.useCallback(
    (prompt: string) => {
      if (isStreaming) return;
      setValue(prompt);
      focusInput();
    },
    [isStreaming, focusInput]
  );

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
    <div className="flex min-h-full items-center justify-center bg-[var(--bg-primary)] px-4 py-10 sm:px-6 sm:py-14">
      <div className="w-full max-w-[880px]">
        <div
          className="text-center opacity-0 animate-fade-up"
          style={{ animationFillMode: "both" }}
        >
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-[12px] bg-[var(--accent-primary)] text-[var(--text-on-accent)] shadow-[var(--shadow-md)]">
            <Bot className="h-5 w-5" />
          </span>
          <h1 className="mt-5 text-balance font-display text-2xl font-bold leading-tight text-[var(--text-primary)] sm:text-[28px]">
            今天想从知识库中查什么？
          </h1>
          <p className="mx-auto mt-2 max-w-xl text-pretty text-sm leading-6 text-[var(--text-tertiary)]">
            NexusQA 会结合检索结果组织回答，并保留可核验的文档来源。
          </p>
        </div>

        <div
          className="mt-8 opacity-0 animate-fade-up"
          style={{ animationDelay: "80ms", animationFillMode: "both" }}
        >
          <div
            className={cn(
              "relative flex flex-col rounded-[16px] border bg-[var(--bg-primary)] px-4 pb-3 pt-3 shadow-[var(--shadow-lg)] transition-[border-color,box-shadow] duration-200",
              isFocused
                ? "border-[var(--border-focus)] shadow-[0_0_0_3px_var(--accent-light),var(--shadow-lg)]"
                : "border-[var(--border-default)] hover:border-[var(--border-focus)]"
            )}
          >
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={deepThinkingEnabled ? "输入需要完整分析的问题" : "输入问题"}
              className="max-h-40 min-h-[64px] w-full resize-none border-0 bg-transparent px-1.5 py-1.5 text-[15px] leading-6 text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none sm:text-base"
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
              aria-label="发送消息"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--border-light)] pt-2">
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
                <span className="hidden text-[11px] text-[var(--text-tertiary)] sm:inline">
                  将执行更完整的分析链路
                </span>
              ) : null}
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!hasContent && !isStreaming}
                aria-label={isStreaming ? "停止生成" : "发送消息"}
                className={cn(
                  "ml-auto inline-flex h-9 w-9 items-center justify-center rounded-[10px] transition-colors duration-200",
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
            <p className="mt-2 text-center text-[11px] text-[var(--text-tertiary)]" aria-live="polite">
              正在生成回答，可随时停止
            </p>
          ) : null}
        </div>

        <div
          className="mt-8 opacity-0 animate-fade-up"
          style={{ animationDelay: "160ms", animationFillMode: "both" }}
        >
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-[var(--text-secondary)]">推荐问题</p>
            <p className="text-[11px] text-[var(--text-tertiary)]">选择后可继续编辑</p>
          </div>
          <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
            {promptPresets.map((preset) => {
              const Icon = preset.icon;
              return (
                <button
                  key={preset.id ?? preset.title}
                  type="button"
                  onClick={() => applyPreset(preset.prompt)}
                  disabled={isStreaming}
                  className={cn(
                    "group flex min-h-[108px] flex-col rounded-[12px] border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3.5 text-left shadow-[var(--shadow-xs)] transition-[border-color,background-color,box-shadow] duration-200 hover:border-[var(--border-accent)] hover:bg-[var(--bg-primary)] hover:shadow-[var(--shadow-md)]",
                    isStreaming && "cursor-not-allowed opacity-60"
                  )}
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-[var(--accent-light)] text-[var(--accent-primary)]">
                      <Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[var(--text-primary)]">{preset.title}</p>
                      <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-[var(--text-tertiary)]">{preset.description}</p>
                    </div>
                  </div>
                  <div className="mt-auto flex items-center gap-2 pt-3 text-[11px] text-[var(--text-muted)]">
                    <span className="min-w-0 flex-1 truncate">{preset.prompt}</span>
                    <ArrowUpRight className="h-3.5 w-3.5 text-[var(--text-muted)] transition-colors group-hover:text-[var(--accent-primary)]" />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
