// @ts-nocheck
/* eslint-disable */

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { Check, Copy, ImageIcon } from "lucide-react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/themeStore";

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const theme = useThemeStore((state) => state.theme);

  return (
    <ReactMarkdown
      remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkCjkFriendly]}
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
      components={{
        code({ inline, className, children, node, ...props }) {
          const match = /language-(\w+)/.exec(className || "");
          const language = match?.[1] || "text";
          const value = String(children).replace(/\n$/, "");

          // 判断是否为内联代码：inline 为 true 或者没有换行符
          if (inline || !value.includes('\n')) {
            return (
              <code
                className={cn(
                  "mx-0.5 rounded-md bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-[13px] text-[var(--text-secondary)]",
                  className
                )}
                {...props}
              >
                {children}
              </code>
            );
          }

          return (
            <div className="my-4 overflow-hidden rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-tertiary)]">
              <div className="flex min-h-9 items-center justify-between border-b border-[var(--border-light)] bg-[var(--surface-elevated)] px-3 py-1.5">
                <span className="font-mono text-[11px] font-semibold text-[var(--text-tertiary)]">
                  {language}
                </span>
                <CopyButton value={value} />
              </div>
              <div className="overflow-x-auto">
                <SyntaxHighlighter
                  language={language}
                  style={theme === "dark" ? oneDark : oneLight}
                  PreTag="div"
                  customStyle={{
                    margin: 0,
                    padding: "0.75rem 1rem",
                    background: "transparent",
                    fontSize: "13px",
                    lineHeight: "1.5"
                  }}
                  showLineNumbers={false}
                  wrapLines={true}
                >
                  {value}
                </SyntaxHighlighter>
              </div>
            </div>
          );
        },
        img({ src, alt, ...props }) {
          const [hasError, setHasError] = React.useState(false);

          if (hasError) {
            return (
              <div className="my-3 flex items-center gap-2 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-tertiary)]">
                <ImageIcon className="h-4 w-4" />
                <span>图片加载失败</span>
              </div>
            );
          }

          return (
            <img
              src={src}
              alt=""
              className="my-3 max-w-full rounded-lg"
              onError={() => setHasError(true)}
              loading="lazy"
              {...props}
            />
          );
        },
        a({ children, ...props }) {
          return (
            <a
              className="font-medium text-[var(--accent-primary)] underline-offset-4 hover:underline"
              target="_blank"
              rel="noreferrer"
              {...props}
            >
              {children}
            </a>
          );
        },
        h1({ children, ...props }) {
          return (
            <h1
              className="mb-3 mt-6 text-2xl font-bold leading-tight text-[var(--text-primary)] first:mt-0"
              {...props}
            >
              {children}
            </h1>
          );
        },
        h2({ children, ...props }) {
          return (
            <h2
              className="mb-3 mt-6 text-xl font-bold leading-tight text-[var(--text-primary)] first:mt-0"
              {...props}
            >
              {children}
            </h2>
          );
        },
        h3({ children, ...props }) {
          return (
            <h3 className="mb-2 mt-5 text-lg font-bold leading-snug text-[var(--text-primary)] first:mt-0" {...props}>
              {children}
            </h3>
          );
        },
        h4({ children, ...props }) {
          return (
            <h4 className="mt-4 mb-2 text-base font-bold leading-snug first:mt-0" {...props}>
              {children}
            </h4>
          );
        },
        table({ children, ...props }) {
          return (
            <div className="my-6 w-full min-w-0 overflow-x-auto">
              <table
                className="w-full overflow-hidden rounded-[10px] border border-[var(--border-default)] text-sm [&_tr:last-child>td]:border-b-0"
                {...props}
              >
                {children}
              </table>
            </div>
          );
        },
        thead({ children, ...props }) {
          return (
            <thead className="bg-[var(--bg-tertiary)]" {...props}>
              {children}
            </thead>
          );
        },
        tr({ children, ...props }) {
          return (
            <tr
              className="transition-colors hover:bg-[var(--bg-tertiary)]"
              {...props}
            >
              {children}
            </tr>
          );
        },
        th({ children, ...props }) {
          return (
            <th
              className="break-words border-b border-r border-[var(--border-light)] px-3 py-2.5 text-left align-middle text-xs font-semibold text-[var(--text-secondary)] last:border-r-0"
              {...props}
            >
              {children}
            </th>
          );
        },
        td({ children, ...props }) {
          return (
            <td
              className="break-words border-b border-r border-[var(--border-light)] px-3 py-2.5 align-middle text-sm text-[var(--text-secondary)] last:border-r-0"
              {...props}
            >
              {children}
            </td>
          );
        },
        blockquote({ children, ...props }) {
          return (
            <blockquote
              className="my-5 rounded-[10px] border border-[var(--border-accent)] bg-[var(--accent-light)] px-5 py-4 text-[var(--text-secondary)] [&_p:first-of-type]:before:content-none [&_p:last-of-type]:after:content-none"
              {...props}
            >
              {children}
            </blockquote>
          );
        },
        ul({ children, ...props }) {
          return (
            <ul
              className="my-4 list-disc space-y-2 pl-6 marker:text-[var(--accent-primary)] [&_ul]:my-2 [&_ol]:my-2"
              {...props}
            >
              {children}
            </ul>
          );
        },
        ol({ children, ...props }) {
          return (
            <ol
              className="my-4 list-decimal space-y-2 pl-6 marker:font-semibold marker:text-[var(--accent-primary)] [&_ul]:my-2 [&_ol]:my-2"
              {...props}
            >
              {children}
            </ol>
          );
        },
        hr({ ...props }) {
          return <hr className="my-6 border-0 border-t border-[var(--border-default)]" {...props} />;
        }
      }}
      className="prose max-w-none break-words text-[15px] leading-[1.68] prose-headings:text-[var(--text-primary)] prose-p:text-[var(--text-secondary)] prose-p:leading-7 prose-li:text-[var(--text-secondary)] prose-strong:text-[var(--text-primary)]"
    >
      {content}
    </ReactMarkdown>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleCopy}
      aria-label="复制代码"
      className="h-7 w-7 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-[var(--success)]" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}
