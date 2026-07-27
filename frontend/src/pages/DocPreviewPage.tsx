import * as React from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, FileText, Loader2, RefreshCw } from "lucide-react";

import { DocumentPreview } from "@/components/document/DocumentPreview";
import { Button } from "@/components/ui/button";
import { getDocument } from "@/services/knowledgeService";

type DocMeta = Awaited<ReturnType<typeof getDocument>>;

export function DocPreviewPage() {
  const { docId } = useParams<{ docId: string }>();
  const navigate = useNavigate();
  const [doc, setDoc] = React.useState<DocMeta | null>(null);
  const [status, setStatus] = React.useState<"loading" | "done" | "error">("loading");
  const [retryKey, setRetryKey] = React.useState(0);

  React.useEffect(() => {
    if (!docId) {
      setStatus("error");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    getDocument(docId)
      .then((data) => {
        if (cancelled) return;
        setDoc(data);
        setStatus("done");
        document.title = `${data.docName || "文档"} - 来源预览`;
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [docId, retryKey]);

  return (
    <div className="document-preview-page">
      <header className="document-preview-header">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label="返回上一页">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <div className="document-preview-icon" aria-hidden="true">
          <FileText className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <h1 title={doc?.docName || ""}>{doc?.docName || "文档预览"}</h1>
          <p>来源原文</p>
        </div>
      </header>
      <main id="main-content" className="flex flex-1 flex-col overflow-hidden">
        {status === "loading" ? (
          <div className="document-preview-state" role="status">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            <div>
              <p>正在加载文档</p>
              <span>内容准备完成后会在此处显示。</span>
            </div>
          </div>
        ) : status === "error" || !doc || !docId ? (
          <div className="document-preview-state" role="alert">
            <FileText className="h-5 w-5" aria-hidden="true" />
            <div>
              <p>无法加载文档</p>
              <span>文档可能已被删除，或当前连接暂时不可用。</span>
            </div>
            {docId ? (
              <Button variant="outline" size="sm" onClick={() => setRetryKey((value) => value + 1)}>
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                重试
              </Button>
            ) : null}
          </div>
        ) : (
          <DocumentPreview docId={docId} fileType={doc.fileType} docName={doc.docName} />
        )}
      </main>
    </div>
  );
}
