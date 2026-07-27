import * as React from "react";
import axios from "axios";
import { AlertCircle, Bot, Eye, EyeOff, Lock, ShieldCheck, User } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuthStore } from "@/stores/authStore";

function getLoginErrorMessage(error: unknown) {
  if (axios.isAxiosError(error)) {
    if (error.code === "ERR_NETWORK" || !error.response) {
      return "无法连接登录服务，请确认后端服务已启动。";
    }
    if (error.response.status >= 500) {
      return "登录服务暂时不可用，请稍后重试。";
    }
    const responseMessage = error.response.data?.message;
    if (typeof responseMessage === "string" && responseMessage.trim()) {
      return responseMessage;
    }
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "登录失败，请稍后重试。";
}

export function LoginPage() {
  const navigate = useNavigate();
  const { login, isLoading } = useAuthStore();
  const [showPassword, setShowPassword] = React.useState(false);
  const [remember, setRemember] = React.useState(true);
  const [form, setForm] = React.useState({ username: "admin", password: "" });
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!form.username.trim() || !form.password.trim()) {
      setError("请输入用户名和密码。");
      return;
    }
    try {
      await login(form.username.trim(), form.password.trim());
      if (!remember) {
        // 如需仅在内存中保存登录态，可在此扩展。
      }
      navigate("/chat");
    } catch (err) {
      setError(getLoginErrorMessage(err));
    }
  };

  return (
    <div
      id="main-content"
      className="grid min-h-dvh bg-[var(--page)] lg:grid-cols-[minmax(320px,0.9fr)_minmax(520px,1.1fr)]"
    >
      <aside className="relative hidden min-h-dvh overflow-hidden bg-[var(--rail)] p-10 text-[var(--rail-ink)] lg:flex lg:flex-col">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-[11px] bg-[var(--rail-accent)] text-[var(--rail)]">
            <Bot className="h-5 w-5" />
          </span>
          <div>
            <p className="text-base font-bold">NexusQA</p>
            <p className="text-xs text-[var(--rail-ink-muted)]">Knowledge Workspace</p>
          </div>
        </div>

        <div className="my-auto max-w-md">
          <ShieldCheck className="h-7 w-7 text-[var(--rail-accent)]" />
          <p className="mt-6 text-balance text-[32px] font-bold leading-[1.2]">
            答案有依据，过程可追溯
          </p>
          <p className="mt-4 max-w-sm text-pretty text-sm leading-7 text-[var(--rail-ink-muted)]">
            在同一个工作区完成知识检索、来源核验与 RAG 运行诊断。
          </p>
        </div>

        <p className="text-xs text-[var(--rail-ink-dim)]">Agentic RAG Operations Console</p>
      </aside>

      <main className="flex min-h-dvh items-center justify-center bg-[var(--bg-primary)] px-5 py-10 sm:px-8">
        <div className="w-full max-w-[400px]">
          <div className="mb-10 flex items-center gap-3 lg:hidden">
            <span className="flex h-10 w-10 items-center justify-center rounded-[11px] bg-[var(--accent-primary)] text-[var(--text-on-accent)]">
              <Bot className="h-5 w-5" />
            </span>
            <div>
              <p className="font-bold text-[var(--text-primary)]">NexusQA</p>
              <p className="text-xs text-[var(--text-tertiary)]">知识检索工作区</p>
            </div>
          </div>

          <div className="mb-7">
            <h1 className="text-balance font-display text-2xl font-bold text-[var(--text-primary)]">
              登录 NexusQA
            </h1>
            <p className="mt-2 text-sm leading-6 text-[var(--text-tertiary)]">
              使用管理员分配的账号继续工作。
            </p>
          </div>

          <form className="space-y-5" onSubmit={handleSubmit} noValidate>
            <div className="space-y-2">
              <label
                htmlFor="username"
                className="text-sm font-semibold text-[var(--text-secondary)]"
              >
                用户名
              </label>
              <div className="relative">
                <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
                <Input
                  id="username"
                  placeholder="请输入用户名"
                  value={form.username}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, username: event.target.value }))
                  }
                  className="h-11 pl-10"
                  autoComplete="username"
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? "login-error" : undefined}
                />
              </div>
            </div>

            <div className="space-y-2">
              <label
                htmlFor="password"
                className="text-sm font-semibold text-[var(--text-secondary)]"
              >
                密码
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  placeholder="请输入密码"
                  value={form.password}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, password: event.target.value }))
                  }
                  className="h-11 pl-10 pr-12"
                  autoComplete="current-password"
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? "login-error" : undefined}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  title={showPassword ? "隐藏密码" : "显示密码"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 text-sm">
              <label className="flex min-h-10 cursor-pointer items-center gap-2 text-[var(--text-secondary)]">
                <Checkbox
                  checked={remember}
                  onCheckedChange={(value) => setRemember(Boolean(value))}
                />
                记住登录状态
              </label>
              <span className="text-xs text-[var(--text-tertiary)]">账号由管理员初始化</span>
            </div>

            {error ? (
              <div
                id="login-error"
                role="alert"
                className="flex items-start gap-2 rounded-[10px] bg-destructive/8 px-3 py-2.5 text-sm text-destructive"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}

            <Button type="submit" className="h-11 w-full" disabled={isLoading}>
              {isLoading ? "正在登录" : "登录"}
            </Button>
          </form>
        </div>
      </main>
    </div>
  );
}
