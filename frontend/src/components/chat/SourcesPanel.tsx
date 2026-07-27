import * as React from "react";
import { X } from "lucide-react";

import { fileExt, isExternal, SourceIcon, sourceLabel } from "@/components/chat/SourceIcon";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import type { SourceRef } from "@/types";

function openSource(source: SourceRef) {
  if (isExternal(source) && source.url) {
    window.open(source.url, "_blank", "noopener,noreferrer");
    return;
  }
  // 本地文件：新标签页打开预览 预览页按 docId 自取元数据与原文件
  window.open(`/preview/doc/${source.docId}`, "_blank", "noopener,noreferrer");
}

// 元信息文案：本地文件补上扩展名（本地文件 · xlsx），网页/飞书用域名或类型
function metaLabel(source: SourceRef) {
  const base = sourceLabel(source);
  if (!isExternal(source)) {
    const ext = fileExt(source);
    return ext ? `${base} · ${ext}` : base;
  }
  return base;
}

/**
 * 参考来源面板：作为 flex 兄弟项从右侧推挤入场（非模态 不压暗主页）
 * 打开状态由 chatStore.openedSourceMessageId 驱动 关闭时保留内容随宽度收起
 */
export function SourcesPanel() {
  const openedSourceMessageId = useChatStore((state) => state.openedSourceMessageId);
  const messages = useChatStore((state) => state.messages);
  const closeSourcesPanel = useChatStore((state) => state.closeSourcesPanel);

  const open = openedSourceMessageId != null;
  // 来源以 messages 为唯一数据源 按打开的消息 ID 派生 不再单独存一份副本
  const sources =
    messages.find((message) => message.id === openedSourceMessageId)?.sources ?? [];

  // 收起动画期间保留上一次内容 避免瞬间清空闪烁
  const lastSourcesRef = React.useRef(sources);
  if (open && sources.length > 0) {
    lastSourcesRef.current = sources;
  }
  const shownSources = open ? sources : lastSourcesRef.current;

  // 面板打开时按 Esc 关闭
  React.useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeSourcesPanel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, closeSourcesPanel]);

  return (
    <aside
      className={cn(
        "fixed bottom-0 right-0 top-[60px] z-30 h-auto w-[min(380px,100vw)] shrink-0 overflow-hidden border-l border-[var(--border-default)] bg-[var(--bg-primary)] shadow-[var(--shadow-xl)] transition-transform duration-300 xl:static xl:h-full xl:shadow-none xl:transition-[width]",
        open
          ? "translate-x-0 xl:w-[360px] xl:translate-x-0"
          : "pointer-events-none translate-x-full xl:w-0 xl:translate-x-0"
      )}
      aria-hidden={!open}
    >
      <div className="flex h-full w-[min(380px,100vw)] flex-col bg-[var(--bg-primary)] xl:w-[360px]">
        <div className="flex h-[60px] items-center justify-between border-b border-[var(--border-light)] px-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[var(--text-primary)]">参考来源</span>
            <span className="rounded-md bg-[var(--accent-light)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--accent-primary)]">
              {shownSources.length}
            </span>
          </div>
          <button
            type="button"
            onClick={closeSourcesPanel}
            className="flex h-9 w-9 items-center justify-center rounded-[10px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            aria-label="关闭参考来源"
            title="关闭参考来源"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 sidebar-scroll">
          <ul className="space-y-2">
            {shownSources.map((source, idx) => (
              <li key={`${source.docId}-${idx}`}>
                <button
                  type="button"
                  onClick={() => openSource(source)}
                  title={source.docName || "查看来源"}
                  className="w-full rounded-[10px] border border-transparent bg-[var(--bg-tertiary)] p-3 text-left transition-[border-color,background-color,box-shadow] hover:border-[var(--border-accent)] hover:bg-[var(--bg-primary)] hover:shadow-[var(--shadow-md)]"
                >
                  <div className="flex items-start gap-2.5">
                    <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--accent-light)] text-[11px] font-semibold text-[var(--accent-primary)]">
                      {source.index ?? idx + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-[var(--text-primary)]">
                        {source.docName || "未命名文档"}
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-xs text-[var(--text-tertiary)]">
                        <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                          <SourceIcon source={source} className="h-3.5 w-3.5" />
                        </span>
                        <span className="truncate">{metaLabel(source)}</span>
                      </div>
                      {source.excerpt ? (
                        <p className="mt-2 line-clamp-3 text-xs leading-5 text-[var(--text-tertiary)]">
                          {source.excerpt}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </aside>
  );
}
