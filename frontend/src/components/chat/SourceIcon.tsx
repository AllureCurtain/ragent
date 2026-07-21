import * as React from "react";
import { File, FileText, Globe, Image as ImageIcon, Presentation, Sheet } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SourceRef } from "@/types";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "svg", "gif", "webp", "bmp"];

export function normalizeType(sourceType?: string) {
  return (sourceType || "").toLowerCase();
}

// 有外部链接的来源（url/飞书等）走 favicon 与新窗口跳转 本地文件走 docId 预览
export function isExternal(source: SourceRef) {
  return Boolean(source.url);
}

// 从 fileType 取扩展名 缺失时回退按 docName 扩展名兜底（兼容无 fileType 的历史数据）
export function fileExt(source: SourceRef): string {
  if (source.fileType) return source.fileType.toLowerCase();
  const match = (source.docName || "").match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : "";
}

// 来源基础文案：飞书文档 / 网页域名 / 本地文件
export function sourceLabel(source: SourceRef) {
  const type = normalizeType(source.sourceType);
  if (isExternal(source)) {
    if (type === "feishu") return "飞书文档";
    try {
      return new URL(source.url as string).hostname;
    } catch {
      return "网页";
    }
  }
  return "本地文件";
}

// favicon 取来源站点根目录的 /favicon.ico（浏览器标签页上的站点图标）失败回退地球
function faviconUrl(url?: string | null): string | null {
  if (!url) return null;
  try {
    return `${new URL(url).origin}/favicon.ico`;
  } catch {
    return null;
  }
}

// 本地文件按扩展名选类型图标与配色
function fileGlyph(ext: string): { Icon: typeof File; color: string } {
  if (ext === "pdf") return { Icon: FileText, color: "text-[#E5484D]" };
  if (ext === "xlsx" || ext === "xls" || ext === "csv") return { Icon: Sheet, color: "text-[#12A150]" };
  if (ext === "doc" || ext === "docx") return { Icon: FileText, color: "text-[#2563EB]" };
  if (ext === "ppt" || ext === "pptx") return { Icon: Presentation, color: "text-[#EA7B2C]" };
  if (ext === "md" || ext === "markdown") return { Icon: FileText, color: "text-[#2563EB]" };
  if (ext === "txt") return { Icon: FileText, color: "text-[#666666]" };
  if (IMAGE_EXTS.includes(ext)) return { Icon: ImageIcon, color: "text-[#8B5CF6]" };
  return { Icon: File, color: "text-[#9AA0A6]" };
}

interface SourceIconProps {
  source: SourceRef;
  /** 控制字形尺寸 如 "h-3.5 w-3.5" */
  className?: string;
}

/**
 * 来源字形：有链接的来源出真实站点 favicon（失败回退地球），本地文件出文件类型图标
 */
export function SourceIcon({ source, className }: SourceIconProps) {
  const [failed, setFailed] = React.useState(false);
  const external = isExternal(source);
  const favicon = external ? faviconUrl(source.url) : null;

  if (external && favicon && !failed) {
    return (
      <img
        src={favicon}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn("rounded-[3px] object-contain", className)}
      />
    );
  }
  if (external) {
    return <Globe className={cn("text-[#9AA0A6]", className)} />;
  }
  const { Icon, color } = fileGlyph(fileExt(source));
  return <Icon className={cn(color, className)} />;
}
