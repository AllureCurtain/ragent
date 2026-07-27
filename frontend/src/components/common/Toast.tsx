import { Toaster } from "sonner";

export function Toast() {
  return (
    <Toaster
      richColors
      position="top-right"
      closeButton
      duration={4000}
      toastOptions={{
        style: {
          borderRadius: "10px",
          border: "1px solid var(--border-default)",
          background: "var(--bg-primary)",
          color: "var(--text-primary)",
          boxShadow: "var(--shadow-lg)"
        }
      }}
    />
  );
}
