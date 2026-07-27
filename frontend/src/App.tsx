import { RouterProvider } from "react-router-dom";

import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { Toast } from "@/components/common/Toast";
import { router } from "@/router";

export default function App() {
  return (
    <ErrorBoundary>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <RouterProvider router={router} />
      <Toast />
    </ErrorBoundary>
  );
}
