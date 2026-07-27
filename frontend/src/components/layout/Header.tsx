import * as React from "react";
import { Menu, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useChatStore } from "@/stores/chatStore";

interface HeaderProps {
  onToggleSidebar: () => void;
}

export function Header({ onToggleSidebar }: HeaderProps) {
  const { currentSessionId, sessions } = useChatStore();
  const currentSession = React.useMemo(
    () => sessions.find((session) => session.id === currentSessionId),
    [sessions, currentSessionId]
  );

  return (
    <header className="sticky top-0 z-20 border-b border-[var(--border-light)] bg-[color-mix(in_srgb,var(--bg-primary)_94%,transparent)] backdrop-blur-md">
      <div className="flex h-[60px] items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleSidebar}
            aria-label="切换侧边栏"
            className="shrink-0 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] lg:hidden"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-[var(--text-primary)]">
              {currentSession?.title || "新对话"}
            </p>
            <p className="hidden truncate text-[11px] text-[var(--text-tertiary)] sm:block">
              {currentSessionId ? "会话内容已自动保存" : "输入问题以开始检索"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden h-8 items-center gap-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-2.5 text-xs font-medium text-[var(--text-secondary)] md:inline-flex">
            <ShieldCheck className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
            知识增强
          </span>
        </div>
      </div>
    </header>
  );
}
