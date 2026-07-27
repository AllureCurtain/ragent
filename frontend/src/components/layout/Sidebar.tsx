import * as React from "react";
import { differenceInCalendarDays, isValid } from "date-fns";
import {
  BookOpen,
  Bot,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  PlayCircle,
  Plus,
  Search,
  Settings,
  Trash2
} from "lucide-react";
import { useNavigate } from "react-router-dom";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Loading } from "@/components/common/Loading";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/authStore";
import { useChatStore } from "@/stores/chatStore";

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({ isOpen, onClose }: SidebarProps) {
  const {
    sessions,
    currentSessionId,
    isLoading,
    sessionsLoaded,
    createSession,
    deleteSession,
    renameSession,
    selectSession,
    fetchSessions
  } = useChatStore();
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const [query, setQuery] = React.useState("");
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [deleteTarget, setDeleteTarget] = React.useState<{
    id: string;
    title: string;
  } | null>(null);
  const [avatarFailed, setAvatarFailed] = React.useState(false);
  const renameInputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (sessions.length === 0) {
      fetchSessions().catch(() => null);
    }
  }, [fetchSessions, sessions.length]);

  const filteredSessions = React.useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return sessions;
    return sessions.filter((session) => {
      const title = (session.title || "新对话").toLowerCase();
      return title.includes(keyword) || session.id.toLowerCase().includes(keyword);
    });
  }, [query, sessions]);

  const groupedSessions = React.useMemo(() => {
    const now = new Date();
    const groups = new Map<string, typeof filteredSessions>();
    const order: string[] = [];

    const resolveLabel = (value?: string) => {
      const parsed = value ? new Date(value) : now;
      const date = isValid(parsed) ? parsed : now;
      const diff = Math.max(0, differenceInCalendarDays(now, date));
      if (diff === 0) return "今天";
      if (diff <= 7) return "7天内";
      if (diff <= 30) return "30天内";
      return "更早";
    };

    filteredSessions.forEach((session) => {
      const label = resolveLabel(session.lastTime);
      if (!groups.has(label)) {
        groups.set(label, []);
        order.push(label);
      }
      groups.get(label)?.push(session);
    });

    return order.map((label) => ({
      label,
      items: groups.get(label) || []
    }));
  }, [filteredSessions]);

  React.useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingId]);

  React.useEffect(() => {
    setAvatarFailed(false);
  }, [user?.avatar, user?.userId]);

  const avatarUrl = user?.avatar?.trim();
  const showAvatar = Boolean(avatarUrl) && !avatarFailed;
  const avatarFallback = (user?.username || user?.userId || "用户").slice(0, 1).toUpperCase();
  const startRename = (id: string, title: string) => {
    setRenamingId(id);
    setRenameValue(title || "新对话");
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue("");
  };

  const commitRename = async () => {
    if (!renamingId) return;
    const nextTitle = renameValue.trim();
    if (!nextTitle) {
      cancelRename();
      return;
    }
    const currentTitle = sessions.find((session) => session.id === renamingId)?.title || "新对话";
    if (nextTitle === currentTitle) {
      cancelRename();
      return;
    }
    await renameSession(renamingId, nextTitle);
    cancelRename();
  };

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-30 bg-[var(--overlay)] backdrop-blur-[2px] transition-opacity lg:hidden",
          isOpen ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={onClose}
      />
      <aside
        className={cn(
          "fixed left-0 top-0 z-40 flex h-dvh w-[288px] flex-shrink-0 flex-col border-r border-[var(--border-default)] bg-[var(--bg-tertiary)] p-3 transition-transform duration-300 lg:static lg:translate-x-0",
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex h-12 items-center gap-3 px-1">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--accent-primary)] text-[var(--text-on-accent)] shadow-[var(--shadow-sm)]">
            <Bot className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold text-[var(--text-primary)]">NexusQA</p>
            <p className="truncate text-[11px] text-[var(--text-tertiary)]">知识检索工作区</p>
          </div>
          {user?.role === "admin" ? (
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-[10px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              onClick={() => {
                window.open("/admin", "_blank");
                onClose();
              }}
              aria-label="打开管理后台"
              title="管理后台"
            >
              <Settings className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        <div className="space-y-2 py-3">
          <button
            type="button"
            className="flex h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-[var(--accent-primary)] px-4 text-sm font-semibold text-[var(--text-on-accent)] shadow-[0_1px_2px_rgba(15,48,45,0.14)] transition-colors hover:bg-[var(--accent-hover)]"
            onClick={() => {
              createSession().catch(() => null);
              navigate("/chat");
              onClose();
            }}
          >
            <Plus className="h-4 w-4" />
            新建对话
          </button>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索会话"
              aria-label="搜索会话"
              className="h-10 w-full rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-primary)] pl-9 pr-3 text-sm text-[var(--text-primary)] shadow-[var(--shadow-xs)] transition-[border-color,box-shadow] placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-light)]"
            />
          </div>
        </div>
        <nav className="relative min-h-0 flex-1" aria-label="会话历史">
          <div className="h-full overflow-y-auto pr-1 sidebar-scroll">
            {sessions.length === 0 && (!sessionsLoaded || isLoading) ? (
              <div className="flex h-full items-center justify-center text-[var(--text-tertiary)]">
                <Loading label="加载会话中" />
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center text-[var(--text-tertiary)]">
                <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[var(--bg-hover)]">
                  <MessageSquare className="h-4 w-4" />
                </span>
                <p className="mt-3 text-sm font-medium text-[var(--text-secondary)]">没有匹配的会话</p>
                <p className="mt-1 text-xs">调整搜索词，或新建一个对话。</p>
              </div>
            ) : (
              <div>
                {groupedSessions.map((group, index) => (
                  <div key={group.label} className={cn("flex flex-col", index === 0 ? "mt-1" : "mt-4")}>
                    <p className="mb-1.5 px-2 text-[11px] font-semibold text-[var(--text-tertiary)]">
                      {group.label}
                    </p>
                    {group.items.map((session) => (
                      <div
                        key={session.id}
                        className={cn(
                          "group relative my-px flex min-h-10 cursor-pointer items-center justify-between gap-2 rounded-[9px] px-3 py-2 text-sm transition-colors duration-200",
                          currentSessionId === session.id
                            ? "bg-[var(--accent-light)] font-semibold text-[var(--accent-primary)]"
                            : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                        )}
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          if (renamingId === session.id) return;
                          if (renamingId) {
                            cancelRename();
                          }
                          selectSession(session.id).catch(() => null);
                          navigate(`/chat/${session.id}`);
                          onClose();
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            selectSession(session.id).catch(() => null);
                            navigate(`/chat/${session.id}`);
                            onClose();
                          }
                        }}
                      >
                        {renamingId === session.id ? (
                          <input
                            ref={renameInputRef}
                            value={renameValue}
                            onChange={(event) => setRenameValue(event.target.value)}
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                commitRename().catch(() => null);
                              }
                              if (event.key === "Escape") {
                                event.preventDefault();
                                cancelRename();
                              }
                            }}
                            onBlur={() => {
                              commitRename().catch(() => null);
                            }}
                            className="h-7 min-w-0 flex-1 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] px-2 text-sm text-[var(--text-primary)] focus:border-[var(--border-focus)] focus:outline-none"
                          />
                        ) : (
                          <span className="min-w-0 flex-1 truncate font-normal">
                            {session.title || "新对话"}
                          </span>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              className={cn(
                                "flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-[opacity,background-color] duration-150 hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)] focus-visible:opacity-100",
                                currentSessionId === session.id
                                  ? "pointer-events-auto opacity-100 text-[var(--accent-primary)]"
                                  : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
                              )}
                              onClick={(event) => event.stopPropagation()}
                              aria-label="会话操作"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="start"
                            className="min-w-[132px]"
                          >
                            <DropdownMenuItem
                              onClick={(event) => {
                                event.stopPropagation();
                                startRename(session.id, session.title || "新对话");
                              }}
                              className="text-[var(--text-secondary)]"
                            >
                              <Pencil className="mr-2 h-4 w-4" />
                              重命名
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={(event) => {
                                event.stopPropagation();
                                setDeleteTarget({
                                  id: session.id,
                                  title: session.title || "新对话"
                                });
                              }}
                              className="text-[var(--error)] focus:text-[var(--error)]"
                            >
                              <Trash2 className="mr-2 h-4 w-4" />
                              删除
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-5 bg-gradient-to-b from-transparent to-[var(--bg-tertiary)]"
          />
        </nav>
        <div className="mt-2 border-t border-[var(--border-light)] pt-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex min-h-11 w-full items-center gap-2.5 rounded-[10px] p-2 text-left transition-colors hover:bg-[var(--bg-hover)] data-[state=open]:bg-[var(--bg-hover)]"
                aria-label="用户菜单"
              >
                <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-[9px] bg-[var(--accent-primary)] text-[var(--text-on-accent)]">
                  {showAvatar ? (
                    <img
                      src={avatarUrl}
                      alt={user?.username || user?.userId || "用户"}
                      className="h-full w-full object-cover"
                      onError={() => setAvatarFailed(true)}
                    />
                  ) : (
                    <span className="text-sm font-medium">{avatarFallback}</span>
                  )}
                </div>
                <span className="flex-1 truncate text-sm font-semibold text-[var(--text-primary)]">
                  {(() => {
                    const fallback = user?.username || user?.userId || "用户";
                    return /^\d+$/.test(fallback) ? "用户" : fallback;
                  })()}
                </span>
                <MoreHorizontal className="h-4 w-4 text-[var(--text-tertiary)]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-48">
              <DropdownMenuItem asChild>
                <a
                  href="https://nageoffer.com/ragent"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center"
                >
                  <BookOpen className="mr-2 h-4 w-4" />
                  官方文档
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a
                  href="https://space.bilibili.com/352177376"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center"
                >
                  <PlayCircle className="mr-2 h-4 w-4" />
                  哔哩哔哩
                </a>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => logout()} className="text-rose-600 focus:text-rose-600">
                <LogOut className="mr-2 h-4 w-4" />
                退出登录
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => {
        if (!open) {
          setDeleteTarget(null);
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除该会话？</AlertDialogTitle>
            <AlertDialogDescription>
              [{deleteTarget?.title || "该会话"}] 将被永久删除，无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!deleteTarget) return;
                const target = deleteTarget;
                const isCurrent = currentSessionId === target.id;
                setDeleteTarget(null);
                deleteSession(target.id)
                  .then(() => {
                    if (isCurrent) {
                      navigate("/chat");
                    }
                  })
                  .catch(() => null);
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
