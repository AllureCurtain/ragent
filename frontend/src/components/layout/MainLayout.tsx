import * as React from "react";

import { Header } from "@/components/layout/Header";
import { Sidebar } from "@/components/layout/Sidebar";

interface MainLayoutProps {
  children: React.ReactNode;
}

export function MainLayout({ children }: MainLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  return (
    <div className="flex h-dvh bg-[var(--page)]">
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col bg-[var(--bg-primary)]">
        <Header onToggleSidebar={() => setSidebarOpen((prev) => !prev)} />
        <main id="main-content" className="min-h-0 flex-1 overflow-hidden bg-[var(--bg-primary)]">
          {children}
        </main>
      </div>
    </div>
  );
}
