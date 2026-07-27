import * as React from "react";

import { cn } from "@/lib/utils";

export interface QuestionRailItem {
  id: string;
  flatIndex: number;
  text: string;
}

interface QuestionRailProps {
  items: QuestionRailItem[];
  activeId: string | null;
  onSelect: (flatIndex: number) => void;
}

export function QuestionRail({ items, activeId, onSelect }: QuestionRailProps) {
  const [expanded, setExpanded] = React.useState(false);
  const activeRef = React.useRef<HTMLLIElement | null>(null);

  React.useEffect(() => {
    if (!expanded) return;
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [expanded, activeId]);

  if (items.length < 2) return null;

  return (
    <div
      className="pointer-events-auto absolute right-3 top-1/2 z-30 -translate-y-1/2 hidden lg:block"
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
    >
      <div
        className={cn(
          "transition-[width,background-color,border-color,box-shadow] duration-200",
          expanded
            ? "w-[260px] rounded-[12px] border border-[var(--border-default)] bg-[var(--bg-primary)] px-1.5 py-2 shadow-[var(--shadow-lg)]"
            : "w-[28px] bg-transparent"
        )}
      >
        <ul
          className={cn(
            "flex max-h-[60vh] flex-col overflow-y-auto sidebar-scroll",
            expanded ? "items-stretch gap-0.5" : "items-end gap-[26px] py-2"
          )}
        >
          {items.map((item) => {
            const isActive = item.id === activeId;
            return (
              <li
                key={item.id}
                ref={isActive ? activeRef : null}
                className="list-none"
              >
                <button
                  type="button"
                  onClick={() => onSelect(item.flatIndex)}
                  className={cn(
                    "flex w-full items-center transition-colors",
                    expanded
                      ? "gap-3 rounded-lg px-3 py-2 hover:bg-[var(--bg-hover)]"
                      : "justify-end"
                  )}
                  aria-label={item.text}
                >
                  {expanded ? (
                    <span
                      className={cn(
                        "flex-1 truncate text-left text-[13px] transition-colors",
                        isActive
                          ? "font-semibold text-[var(--accent-primary)]"
                          : "text-[var(--text-secondary)]"
                      )}
                    >
                      {item.text}
                    </span>
                  ) : null}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "inline-block w-[14px] shrink-0 rounded-full transition-[height,background-color]",
                      isActive
                        ? "h-[3px] bg-[var(--accent-primary)]"
                        : "h-[1.5px] bg-[var(--border-focus)]"
                    )}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
