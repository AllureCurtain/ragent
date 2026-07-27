import * as React from "react";
import { AlertTriangle } from "lucide-react";

import { Button } from "@/components/ui/button";

interface ErrorBoundaryState {
  hasError: boolean;
  message?: string;
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("App error", error, info);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div id="main-content" className="flex min-h-dvh items-center justify-center bg-[var(--page)] px-6">
        <div className="chat-surface max-w-md rounded-[18px] p-8 text-center">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-[10px] bg-destructive/10 text-destructive">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <p className="mt-5 font-display text-xl font-semibold">页面无法继续运行</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            请刷新页面后重试。若问题持续出现，请记录当前操作并联系管理员。
          </p>
          {this.state.message ? (
            <code className="mt-4 block rounded-lg bg-muted px-3 py-2 text-left text-xs text-muted-foreground">
              {this.state.message}
            </code>
          ) : null}
          <Button className="mt-6" onClick={this.handleReload}>
            刷新页面
          </Button>
        </div>
      </div>
    );
  }
}
