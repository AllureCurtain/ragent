import { ArrowLeft, MessageSquare } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";

export function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <main id="main-content" className="not-found-page">
      <div className="not-found-mark" aria-hidden="true">
        404
      </div>
      <h1>页面不存在</h1>
      <p>地址可能已变更，或你没有从当前入口进入该页面。</p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button variant="outline" onClick={() => navigate(-1)}>
          <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
          返回上一页
        </Button>
        <Button asChild>
          <Link to="/chat">
            <MessageSquare className="mr-2 h-4 w-4" aria-hidden="true" />
            进入对话
          </Link>
        </Button>
      </div>
    </main>
  );
}
