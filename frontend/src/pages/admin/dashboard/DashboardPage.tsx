import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode
} from "react";
import {
  Activity,
  AlertCircle,
  BarChart3,
  Clock,
  Info,
  Lightbulb,
  MessageSquare,
  RefreshCw,
  Timer,
  TrendingDown,
  TrendingUp,
  Zap
} from "lucide-react";
import { toast } from "sonner";

import {
  SimpleLineChart,
  type ChartThreshold,
  type ChartXAxisMode,
  type ChartYAxisType,
  type TrendSeries
} from "@/components/admin/SimpleLineChart";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  getDashboardOverview,
  getDashboardPerformance,
  getDashboardTrends,
  type DashboardOverview,
  type DashboardPerformance,
  type DashboardTrends
} from "@/services/dashboardService";

// ============================================================================
// Types
// ============================================================================

type DashboardTimeWindow = "24h" | "7d" | "30d";

type DashboardTrendBundle = {
  sessions: DashboardTrends | null;
  messages: DashboardTrends | null;
  activeUsers: DashboardTrends | null;
  latency: DashboardTrends | null;
  quality: DashboardTrends | null;
};

type HealthStatus = "healthy" | "attention" | "critical" | "unknown";
type MetricTone = "good" | "warning" | "bad";

type MetricStatusView = {
  success: MetricTone;
  latency: MetricTone;
  error: MetricTone;
  noDoc: MetricTone;
};

type KPIChange = {
  value: number;
  trend: "up" | "down" | "flat";
  isPositive: boolean;
};

type InsightCardData = {
  type: "anomaly" | "trend" | "recommendation";
  severity: "info" | "warning" | "critical";
  title: string;
  metric: string;
  change: string;
  context: string;
  action?: string;
  timestamp: string;
};

// ============================================================================
// Constants
// ============================================================================

const WINDOW_OPTIONS: Array<{ value: DashboardTimeWindow; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" }
];

const WINDOW_LABEL_MAP: Record<DashboardTimeWindow, string> = {
  "24h": "滚动 24h",
  "7d": "近 7 天",
  "30d": "近 30 天"
};

const DASHBOARD_THRESHOLDS = {
  latency: { good: 10000, warning: 15000 },
  successRate: { good: 99, warning: 95 },
  errorRate: { good: 1, warning: 5 },
  noDocRate: { good: 10, warning: 30 }
} as const;

const EMPTY_TRENDS: DashboardTrendBundle = {
  sessions: null,
  messages: null,
  activeUsers: null,
  latency: null,
  quality: null
};

// ============================================================================
// Utils
// ============================================================================

const getMetricStatus = (
  metric: "latency" | "successRate" | "errorRate" | "noDocRate",
  value?: number | null
): MetricTone => {
  if (value === null || value === undefined) return "warning";

  if (metric === "latency") {
    if (value < DASHBOARD_THRESHOLDS.latency.good) return "good";
    if (value < DASHBOARD_THRESHOLDS.latency.warning) return "warning";
    return "bad";
  }

  if (metric === "successRate") {
    if (value >= DASHBOARD_THRESHOLDS.successRate.good) return "good";
    if (value >= DASHBOARD_THRESHOLDS.successRate.warning) return "warning";
    return "bad";
  }

  if (metric === "errorRate") {
    if (value <= DASHBOARD_THRESHOLDS.errorRate.good) return "good";
    if (value <= DASHBOARD_THRESHOLDS.errorRate.warning) return "warning";
    return "bad";
  }

  if (value <= DASHBOARD_THRESHOLDS.noDocRate.good) return "good";
  if (value <= DASHBOARD_THRESHOLDS.noDocRate.warning) return "warning";
  return "bad";
};

const getHealthStatus = (
  performance?: {
    successRate?: number | null;
    errorRate?: number | null;
    noDocRate?: number | null;
  } | null,
  windowMessages?: number
): HealthStatus => {
  if (!performance || !windowMessages) return "unknown";
  if ((performance.errorRate ?? 0) > DASHBOARD_THRESHOLDS.errorRate.warning) return "critical";
  if ((performance.successRate ?? 0) < DASHBOARD_THRESHOLDS.successRate.warning) return "critical";
  if ((performance.noDocRate ?? 0) > 20) return "attention";
  return "healthy";
};

const getLatencyStatus = (value?: number | null): MetricTone => {
  if (value === null || value === undefined) return "warning";
  if (value <= DASHBOARD_THRESHOLDS.latency.good) return "good";
  if (value <= DASHBOARD_THRESHOLDS.latency.warning) return "warning";
  return "bad";
};

const formatLastUpdated = (timestamp: number | null) => {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
};

const formatTime = (timestamp: number | null) => {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
};

const formatPercent = (value?: number | null) => {
  if (value === null || value === undefined) return "-";
  return `${value.toFixed(1)}%`;
};

const formatDuration = (value?: number | null) => {
  if (value === null || value === undefined) return "-";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(2)}s`;
};

const formatNumber = (value?: number | null) => {
  if (value === null || value === undefined) return "-";
  return value.toLocaleString("zh-CN");
};

const clampPercent = (value?: number | null) => {
  if (value === null || value === undefined || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
};

const formatRatio = (value?: number | null) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value.toFixed(2);
};

const formatCompactNumber = (value: number): string => {
  if (value >= 10000) return `${(value / 1000).toFixed(0)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return Math.round(value).toString();
};

// ============================================================================
// Hooks
// ============================================================================

const useDashboardData = () => {
  const [timeWindow, setTimeWindow] = useState<DashboardTimeWindow>("7d");
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [performance, setPerformance] = useState<DashboardPerformance | null>(null);
  const [trends, setTrends] = useState<DashboardTrendBundle>(EMPTY_TRENDS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const requestIdRef = useRef(0);

  const loadData = useCallback(async (windowValue: DashboardTimeWindow) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    const granularity = windowValue === "24h" ? "hour" : "day";

    try {
      const [overviewData, performanceData] = await Promise.all([
        getDashboardOverview(windowValue),
        getDashboardPerformance(windowValue)
      ]);
      if (requestIdRef.current !== requestId) return;
      setOverview(overviewData);
      setPerformance(performanceData);
      setLastUpdated(Date.now());

      try {
        const [sessions, messages, activeUsers, latency, quality] = await Promise.all([
          getDashboardTrends("sessions", windowValue, granularity),
          getDashboardTrends("messages", windowValue, granularity),
          getDashboardTrends("activeUsers", windowValue, granularity),
          getDashboardTrends("avgLatency", windowValue, granularity),
          getDashboardTrends("quality", windowValue, granularity)
        ]);
        if (requestIdRef.current !== requestId) return;
        setTrends({ sessions, messages, activeUsers, latency, quality });
      } catch (trendErr) {
        if (requestIdRef.current !== requestId) return;
        console.error(trendErr);
        setTrends(EMPTY_TRENDS);
        setError("趋势数据加载失败");
      }
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      console.error(err);
      setError("数据加载失败");
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadData(timeWindow);
  }, [loadData, timeWindow]);

  const refresh = useCallback(async () => {
    await loadData(timeWindow);
  }, [loadData, timeWindow]);

  return {
    timeWindow,
    setTimeWindow,
    loading,
    error,
    lastUpdated,
    overview,
    performance,
    trends,
    refresh
  };
};

const useHealthStatus = (
  performance: DashboardPerformance | null,
  overview: DashboardOverview | null
) => {
  const windowMessages = overview?.kpis?.messages24h?.value;
  const health = useMemo(
    () => getHealthStatus(performance, windowMessages),
    [performance, windowMessages]
  );

  const metricStatus = useMemo<MetricStatusView>(
    () => ({
      success: getMetricStatus("successRate", performance?.successRate),
      latency: getMetricStatus("latency", performance?.avgLatencyMs),
      error: getMetricStatus("errorRate", performance?.errorRate),
      noDoc: getMetricStatus("noDocRate", performance?.noDocRate)
    }),
    [performance]
  );

  return { health, metricStatus };
};

// ============================================================================
// Base Components
// ============================================================================

const DashCard = ({ children, className }: { children: ReactNode; className?: string }) => (
  <section className={cn("dashboard-card", className)}>{children}</section>
);

const CardTitle = ({ children }: { children: ReactNode }) => (
  <h2 className="dashboard-section-title">{children}</h2>
);

const LoadingBlock = ({ className }: { className?: string }) => (
  <div className={cn("dashboard-skeleton animate-pulse", className)} aria-hidden="true" />
);

// ============================================================================
// Header
// ============================================================================

const HEALTH_CONFIG: Record<HealthStatus, { className: string; label: string }> = {
  healthy: { className: "dashboard-status--healthy", label: "运行正常" },
  attention: { className: "dashboard-status--attention", label: "需要关注" },
  critical: { className: "dashboard-status--critical", label: "风险偏高" },
  unknown: { className: "dashboard-status--unknown", label: "暂无数据" }
};

const DashboardHeader = ({
  timeWindow,
  lastUpdated,
  loading,
  onRefresh,
  onTimeWindowChange
}: {
  timeWindow: DashboardTimeWindow;
  lastUpdated: number | null;
  loading?: boolean;
  onRefresh: () => void;
  onTimeWindowChange: (window: DashboardTimeWindow) => void;
}) => (
  <header className="dashboard-header">
    <div className="min-w-0">
      <h1 className="admin-page-title">运行概览</h1>
      <p className="admin-page-subtitle">会话流量、响应质量与知识命中状态</p>
    </div>

    <div className="dashboard-header-controls">
      <div className="dashboard-window-control" role="group" aria-label="统计时间范围">
        {WINDOW_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onTimeWindowChange(opt.value)}
            disabled={loading}
            aria-pressed={timeWindow === opt.value}
            className={cn(
              "dashboard-window-option",
              timeWindow === opt.value && "dashboard-window-option--active"
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="dashboard-sync-state" aria-live="polite">
        <span className="dashboard-sync-dot" aria-hidden="true" />
        <span>{lastUpdated ? formatLastUpdated(lastUpdated) : "等待首次同步"}</span>
      </div>

      <Button
        variant="outline"
        size="icon"
        onClick={onRefresh}
        disabled={loading}
        aria-label={loading ? "正在刷新运行概览" : "刷新运行概览"}
        title="刷新"
        className="dashboard-refresh"
      >
        <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
      </Button>
    </div>
  </header>
);

// ============================================================================
// KPI Cards
// ============================================================================

type KPICardProps = {
  value: string | number;
  label: string;
  change?: KPIChange;
  supportingText?: string;
  icon: ReactNode;
  iconTone: "primary" | "secondary" | "neutral";
};

const KPICardItem = ({ value, label, change, supportingText, icon, iconTone }: KPICardProps) => {
  const showChange = change && change.trend !== "flat";
  const isUp = change?.trend === "up";
  const changePositive = change?.isPositive;

  const changeColor = changePositive ? "dashboard-change--positive" : "dashboard-change--negative";

  return (
    <div className="dashboard-kpi-item">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="dashboard-kpi-value">{value}</p>
          <p className="dashboard-kpi-label">{label}</p>
        </div>
        <div className={cn("dashboard-kpi-icon", `dashboard-kpi-icon--${iconTone}`)}>{icon}</div>
      </div>

      <div className="dashboard-kpi-change">
        {supportingText ? (
          <span>{supportingText}</span>
        ) : showChange ? (
          <>
            {isUp ? (
              <TrendingUp className={cn("h-4 w-4", changeColor)} aria-hidden="true" />
            ) : (
              <TrendingDown className={cn("h-4 w-4", changeColor)} aria-hidden="true" />
            )}
            <span className={cn("font-semibold tabular-nums", changeColor)}>
              {change!.value > 0 ? "+" : ""}
              {change!.value.toFixed(1)}%
            </span>
            <span>较上周期</span>
          </>
        ) : (
          <span>暂无周期变化</span>
        )}
      </div>
    </div>
  );
};

const toChange = (deltaPct?: number | null): KPIChange => {
  if (deltaPct === null || deltaPct === undefined) {
    return { value: 0, trend: "flat", isPositive: true };
  }
  if (deltaPct > 0) return { value: deltaPct, trend: "up", isPositive: true };
  if (deltaPct < 0) return { value: deltaPct, trend: "down", isPositive: false };
  return { value: 0, trend: "flat", isPositive: true };
};

const KPISection = ({
  overview,
  timeWindow
}: {
  overview: DashboardOverview | null;
  timeWindow: DashboardTimeWindow;
}) => {
  const kpis = overview?.kpis;
  const windowLabel = WINDOW_LABEL_MAP[timeWindow];
  const sessionDepth =
    (kpis?.sessions24h.value ?? 0) > 0
      ? (kpis?.messages24h.value ?? 0) / (kpis?.sessions24h.value ?? 1)
      : null;

  const items: KPICardProps[] = [
    {
      value: formatNumber(kpis?.activeUsers.value),
      label: `活跃用户 · ${windowLabel}`,
      change: toChange(kpis?.activeUsers.deltaPct),
      icon: <Activity className="h-5 w-5" />,
      iconTone: "primary"
    },
    {
      value: formatNumber(kpis?.totalSessions.value),
      label: "累计会话",
      supportingText: `${windowLabel}新增 ${formatNumber(kpis?.sessions24h.value)} 个`,
      icon: <MessageSquare className="h-5 w-5" />,
      iconTone: "primary"
    },
    {
      value: formatNumber(kpis?.totalMessages.value),
      label: "累计消息",
      supportingText: `${windowLabel}新增 ${formatNumber(kpis?.messages24h.value)} 条`,
      icon: <Zap className="h-5 w-5" />,
      iconTone: "secondary"
    },
    {
      value: sessionDepth === null ? "-" : formatRatio(sessionDepth),
      label: `会话深度 · ${windowLabel}`,
      change: undefined,
      icon: <BarChart3 className="h-5 w-5" />,
      iconTone: "neutral"
    }
  ];

  return (
    <DashCard>
      <CardTitle>核心指标</CardTitle>
      <div className="dashboard-kpi-grid">
        {items.map((item) => (
          <KPICardItem key={item.label} {...item} />
        ))}
      </div>
    </DashCard>
  );
};

// ============================================================================
// Area Chart Component (优化版 - 使用 HTML 布局坐标轴)
// ============================================================================

type AreaChartPoint = { ts: number; value: number };

const SimpleAreaChart = ({
  data,
  height = 160,
  timeWindow,
  valueLabel = "消息数"
}: {
  data: AreaChartPoint[];
  height?: number;
  timeWindow: DashboardTimeWindow;
  valueLabel?: string;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [, setDimensions] = useState({ width: 0, height: 0 });
  const [tooltip, setTooltip] = useState<{
    show: boolean;
    index: number;
    x: number;
    y: number;
    value: number;
    label: string;
  } | null>(null);

  // 监听容器尺寸
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height
        });
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const maxValue = useMemo(() => Math.max(1, ...data.map((d) => d.value)), [data]);

  // Y轴刻度
  const yTicks = useMemo(() => {
    const tickCount = 4;
    const step = maxValue / (tickCount - 1);
    return Array.from({ length: tickCount }, (_, i) => Math.round(step * (tickCount - 1 - i)));
  }, [maxValue]);

  // X轴标签
  const xLabels = useMemo(() => {
    if (data.length === 0) return [];
    const count = timeWindow === "24h" ? 6 : 5;
    const step = Math.max(1, Math.floor((data.length - 1) / (count - 1)));

    return Array.from({ length: count }, (_, i) => {
      const idx = Math.min(i * step, data.length - 1);
      const point = data[idx];
      if (!point) return null;

      const date = new Date(point.ts);
      const label =
        timeWindow === "24h"
          ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
          : date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });

      return { position: i / (count - 1), label };
    }).filter(Boolean) as Array<{ position: number; label: string }>;
  }, [data, timeWindow]);

  // 生成 SVG 路径 (归一化坐标 0-1)
  const { linePath, areaPath, points } = useMemo(() => {
    if (data.length === 0) return { linePath: "", areaPath: "", points: [] };

    const pts = data.map((d, i) => ({
      x: i / Math.max(1, data.length - 1),
      y: 1 - d.value / maxValue,
      ts: d.ts,
      value: d.value
    }));

    if (pts.length === 1) {
      return {
        linePath: `M ${pts[0].x} ${pts[0].y}`,
        areaPath: `M ${pts[0].x} 1 L ${pts[0].x} ${pts[0].y} L ${pts[0].x} 1 Z`,
        points: pts
      };
    }

    let line = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const cpx1 = prev.x + (curr.x - prev.x) * 0.4;
      const cpx2 = prev.x + (curr.x - prev.x) * 0.6;
      line += ` C ${cpx1} ${prev.y}, ${cpx2} ${curr.y}, ${curr.x} ${curr.y}`;
    }

    const area = `${line} L ${pts[pts.length - 1].x} 1 L ${pts[0].x} 1 Z`;
    return { linePath: line, areaPath: area, points: pts };
  }, [data, maxValue]);

  const formatLabel = (ts: number) => {
    const date = new Date(ts);
    if (timeWindow === "24h") {
      return date.toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      });
    }
    return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const chartArea = e.currentTarget;
    const rect = chartArea.getBoundingClientRect();
    const relativeX = (e.clientX - rect.left) / rect.width;

    if (relativeX < 0 || relativeX > 1 || points.length === 0) {
      setTooltip(null);
      return;
    }

    let closestIdx = 0;
    let minDist = Infinity;
    points.forEach((pt, i) => {
      const dist = Math.abs(pt.x - relativeX);
      if (dist < minDist) {
        minDist = dist;
        closestIdx = i;
      }
    });

    const pt = points[closestIdx];
    setTooltip({
      show: true,
      index: closestIdx,
      x: pt.x * rect.width,
      y: pt.y * rect.height,
      value: pt.value,
      label: formatLabel(pt.ts)
    });
  };

  const handleMouseLeave = () => {
    setTooltip(null);
  };

  const showPoint = (index: number, chartArea: HTMLDivElement) => {
    const point = points[Math.max(0, Math.min(index, points.length - 1))];
    if (!point) return;
    const rect = chartArea.getBoundingClientRect();
    setTooltip({
      show: true,
      index: Math.max(0, Math.min(index, points.length - 1)),
      x: point.x * rect.width,
      y: point.y * rect.height,
      value: point.value,
      label: formatLabel(point.ts)
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const currentIndex = tooltip?.index ?? points.length - 1;
    showPoint(currentIndex + (event.key === "ArrowRight" ? 1 : -1), event.currentTarget);
  };

  const PADDING = { left: 40, right: 8, top: 8, bottom: 32 };

  return (
    <div ref={containerRef} className="relative h-full w-full" style={{ minHeight: height }}>
      {/* Y轴标签 */}
      <div
        className="absolute flex flex-col justify-between"
        style={{
          left: 0,
          top: PADDING.top,
          width: PADDING.left - 4,
          height: `calc(100% - ${PADDING.top + PADDING.bottom}px)`
        }}
      >
        {yTicks.map((tick, i) => (
          <span key={i} className="pr-1 text-right text-[10px] leading-none text-slate-400">
            {formatCompactNumber(tick)}
          </span>
        ))}
      </div>

      {/* Y轴标题 */}
      <div className="absolute left-0 top-0 text-[10px] text-slate-400">{valueLabel}</div>

      {/* 图表区域 */}
      <div
        className="dashboard-traffic-plot absolute cursor-crosshair"
        style={{
          left: PADDING.left,
          top: PADDING.top,
          right: PADDING.right,
          bottom: PADDING.bottom
        }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onFocus={(event) => showPoint(points.length - 1, event.currentTarget)}
        onBlur={handleMouseLeave}
        onKeyDown={handleKeyDown}
        tabIndex={points.length > 0 ? 0 : -1}
        role="group"
        aria-label={`${valueLabel || "消息数"}趋势图，共 ${points.length} 个数据点`}
      >
        {/* 水平网格线 */}
        <div className="pointer-events-none absolute inset-0">
          {yTicks.map((_, i) => (
            <div
              key={i}
              className="dashboard-chart-gridline absolute left-0 right-0 border-t border-dashed"
              style={{ top: `${(i / (yTicks.length - 1)) * 100}%` }}
            />
          ))}
        </div>

        {/* SVG 图表 */}
        <svg
          className="absolute inset-0 h-full w-full overflow-visible"
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${valueLabel || "消息数"}随时间变化`}
        >
          <title>{`${valueLabel || "消息数"}随时间变化`}</title>
          <defs>
            <linearGradient id="trafficGradient" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="var(--accent-primary)" stopOpacity="0.2" />
              <stop offset="100%" stopColor="var(--accent-primary)" stopOpacity="0.015" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill="url(#trafficGradient)" />
          <path
            d={linePath}
            fill="none"
            stroke="var(--accent-primary)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* Tooltip */}
        {tooltip?.show && (
          <>
            {/* 垂直指示线 */}
            <div
              className="dashboard-chart-cursor pointer-events-none absolute top-0 h-full w-px"
              style={{ left: tooltip.x }}
            />
            {/* 圆点 */}
            <div
              className="dashboard-chart-point pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
              style={{ left: tooltip.x, top: tooltip.y }}
            />
            {/* 标签 */}
            <div
              className="dashboard-chart-tooltip pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap px-2.5 py-1.5 text-xs"
              style={{
                left: tooltip.x,
                top: Math.max(0, tooltip.y - 48)
              }}
            >
              <div className="font-medium">{tooltip.label}</div>
              <div className="flex items-center gap-1">
                <span
                  className="dashboard-chart-legend-mark h-2 w-2 rounded-sm"
                  aria-hidden="true"
                />
                <span>
                  {valueLabel}: {tooltip.value}
                </span>
              </div>
            </div>
          </>
        )}
      </div>

      <table className="sr-only">
        <caption>{`${valueLabel || "消息数"}趋势数据`}</caption>
        <thead>
          <tr>
            <th>时间</th>
            <th>{valueLabel || "消息数"}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((point) => (
            <tr key={point.ts}>
              <td>{formatLabel(point.ts)}</td>
              <td>{point.value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* X轴标签 */}
      <div
        className="absolute flex justify-between"
        style={{
          left: PADDING.left,
          right: PADDING.right,
          bottom: 8,
          height: 16
        }}
      >
        {xLabels.map((item, i) => (
          <span
            key={i}
            className="text-[10px] text-slate-400"
            style={{
              position: "absolute",
              left: `${item.position * 100}%`,
              transform: "translateX(-50%)"
            }}
          >
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
};

// ============================================================================
// Traffic Overview Section
// ============================================================================

const TrafficOverviewSection = ({
  trends,
  overview,
  timeWindow,
  loading,
  className
}: {
  trends: DashboardTrendBundle;
  overview: DashboardOverview | null;
  timeWindow: DashboardTimeWindow;
  loading?: boolean;
  className?: string;
}) => {
  const chartData = useMemo<AreaChartPoint[]>(() => {
    const points = trends.messages?.series?.[0]?.data || [];
    return points.map((p) => ({ ts: p.ts, value: p.value }));
  }, [trends.messages]);

  const deltaPct = overview?.kpis?.messages24h?.deltaPct;
  const change = toChange(deltaPct);
  const showChange = change.trend !== "flat";
  const changeTone = change.isPositive
    ? "dashboard-change--positive"
    : "dashboard-change--negative";

  return (
    <DashCard className={cn("flex flex-col", className)}>
      <div className="dashboard-card-heading">
        <div>
          <h2 className="dashboard-section-title mb-0">流量概览</h2>
          <p className="dashboard-section-caption">消息量随时间变化</p>
        </div>
        {showChange ? (
          <span className={cn("dashboard-delta", changeTone)}>
            {change.trend === "up" ? (
              <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {change.value > 0 ? "+" : ""}
            {change.value.toFixed(1)}%
          </span>
        ) : null}
      </div>

      {loading ? (
        <LoadingBlock className="h-full flex-1" />
      ) : chartData.length === 0 ? (
        <div className="dashboard-empty flex flex-1 items-center justify-center">暂无流量数据</div>
      ) : (
        <div className="flex-1">
          <SimpleAreaChart data={chartData} timeWindow={timeWindow} valueLabel="消息数" />
        </div>
      )}
    </DashCard>
  );
};

// ============================================================================
// Trend Charts
// ============================================================================

const mapSeries = (trend: DashboardTrends | null, tone: TrendSeries["tone"]): TrendSeries[] => {
  if (!trend?.series?.length) return [];
  return trend.series.map((s, index) => ({
    name: s.name,
    data: s.data,
    tone,
    lineStyle: index % 2 === 0 ? "solid" : "dashed"
  }));
};

const mapQualitySeries = (trend: DashboardTrends | null): TrendSeries[] => {
  if (!trend?.series?.length) return [];
  return trend.series.map((s) => ({
    name: s.name,
    data: s.data,
    tone: s.name.includes("错误") ? "danger" : "info",
    lineStyle: s.name.includes("错误") ? "solid" : "dashed"
  }));
};

const TrendChartItem = ({
  title,
  series,
  thresholds = [],
  xAxisMode,
  yAxisType = "number",
  yAxisLabel,
  loading
}: {
  title: string;
  series: TrendSeries[];
  thresholds?: ChartThreshold[];
  xAxisMode: ChartXAxisMode;
  yAxisType?: ChartYAxisType;
  yAxisLabel?: string;
  loading?: boolean;
}) => {
  if (loading) {
    return (
      <div className="dashboard-chart-panel">
        <LoadingBlock className="mb-3 h-4 w-24" />
        <LoadingBlock className="h-48 w-full" />
      </div>
    );
  }

  return (
    <article className="dashboard-chart-panel">
      <div className="dashboard-chart-heading">
        <h3>{title}</h3>
        {yAxisLabel ? <span>{yAxisLabel}</span> : null}
      </div>
      <SimpleLineChart
        series={series}
        xAxisMode={xAxisMode}
        yAxisType={yAxisType}
        thresholds={thresholds}
        height={192}
        theme="light"
        yAxisTickCount={4}
        ariaLabel={title}
      />
    </article>
  );
};

const TrendSection = ({
  trends,
  timeWindow,
  loading
}: {
  trends: DashboardTrendBundle;
  timeWindow: DashboardTimeWindow;
  loading?: boolean;
}) => {
  const xAxisMode = timeWindow === "24h" ? "hour" : "date";

  const sessionsSeries = useMemo(() => mapSeries(trends.sessions, "success"), [trends.sessions]);
  const activeSeries = useMemo(
    () => mapSeries(trends.activeUsers, "primary"),
    [trends.activeUsers]
  );
  const latencySeries = useMemo(() => mapSeries(trends.latency, "warning"), [trends.latency]);
  const qualitySeries = useMemo(() => mapQualitySeries(trends.quality), [trends.quality]);

  return (
    <section className="dashboard-trend-section" aria-labelledby="dashboard-trends-title">
      <h2 id="dashboard-trends-title" className="dashboard-section-title">
        趋势分析
      </h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <TrendChartItem
          title="会话趋势"
          series={sessionsSeries}
          xAxisMode={xAxisMode}
          yAxisLabel="单位：次"
          loading={loading}
        />
        <TrendChartItem
          title="活跃用户趋势"
          series={activeSeries}
          xAxisMode={xAxisMode}
          yAxisLabel="单位：人"
          loading={loading}
        />
        <TrendChartItem
          title="响应时间趋势"
          series={latencySeries}
          xAxisMode={xAxisMode}
          yAxisType="duration"
          yAxisLabel="单位：毫秒"
          loading={loading}
          thresholds={[
            { value: DASHBOARD_THRESHOLDS.latency.good, label: "良好 ≤10s", tone: "info" },
            { value: DASHBOARD_THRESHOLDS.latency.warning, label: "警告 >15s", tone: "critical" }
          ]}
        />
        <TrendChartItem
          title="质量趋势"
          series={qualitySeries}
          xAxisMode={xAxisMode}
          yAxisType="percent"
          yAxisLabel="单位：%"
          loading={loading}
          thresholds={[
            { value: DASHBOARD_THRESHOLDS.errorRate.warning, label: "错误警告", tone: "warning" },
            { value: DASHBOARD_THRESHOLDS.noDocRate.warning, label: "无知识警告", tone: "critical" }
          ]}
        />
      </div>
    </section>
  );
};

// ============================================================================
// AI Performance
// ============================================================================

const STATUS_COLOR: Record<MetricTone, string> = {
  good: "var(--success)",
  warning: "var(--warning)",
  bad: "var(--error)"
};

const QUALITY_SNAPSHOT_META = [
  {
    label: "错误率",
    toneClass: "dashboard-bar--danger",
    valueClass: "dashboard-value--danger",
    target: "阈值 ≤5%"
  },
  {
    label: "无知识率",
    toneClass: "dashboard-bar--warning",
    valueClass: "dashboard-value--warning",
    target: "阈值 ≤20%"
  },
  {
    label: "慢响应率（>20s）",
    toneClass: "dashboard-bar--secondary",
    valueClass: "dashboard-value--secondary",
    target: "阈值 ≤20%"
  }
] as const;

const MetricRow = ({
  icon: Icon,
  label,
  value,
  status
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  status: MetricTone;
}) => (
  <div className="flex items-center justify-between py-2.5">
    <span className="flex items-center gap-2.5 text-sm text-[var(--text-secondary)]">
      <Icon className="h-4 w-4 text-[var(--text-tertiary)]" aria-hidden="true" />
      {label}
    </span>
    <span className="text-sm font-semibold tabular-nums" style={{ color: STATUS_COLOR[status] }}>
      {value}
    </span>
  </div>
);

const QualitySnapshot = ({
  performance,
  windowLabel
}: {
  performance: DashboardPerformance | null;
  windowLabel: string;
}) => {
  const items = [
    { ...QUALITY_SNAPSHOT_META[0], value: performance?.errorRate },
    { ...QUALITY_SNAPSHOT_META[1], value: performance?.noDocRate },
    { ...QUALITY_SNAPSHOT_META[2], value: performance?.slowRate }
  ];

  return (
    <div className="dashboard-subsection">
      <div className="dashboard-subsection-heading">
        <p>质量快照</p>
        <span>{windowLabel}</span>
      </div>
      <div className="grid grid-cols-3 gap-2.5" role="img" aria-label="质量指标柱状图">
        {items.map((item) => {
          const hasValue = item.value !== null && item.value !== undefined;
          const normalized = clampPercent(item.value);
          const barHeight = `${Math.max(normalized, hasValue ? 4 : 0)}%`;
          return (
            <div key={item.label} className="space-y-1.5">
              <div className="dashboard-bar-track">
                <div
                  className={cn("dashboard-bar-fill", item.toneClass)}
                  style={{ height: barHeight }}
                  aria-hidden="true"
                />
              </div>
              <div
                className={cn("text-center text-xs font-semibold tabular-nums", item.valueClass)}
              >
                {formatPercent(item.value)}
              </div>
              <div className="text-center text-[11px] text-[var(--text-secondary)]">
                {item.label}
              </div>
              <div className="text-center text-[10px] text-[var(--text-tertiary)]">
                {item.target}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const EfficiencySnapshot = ({
  overview,
  windowLabel
}: {
  overview: DashboardOverview | null;
  windowLabel: string;
}) => {
  const activeUsers = overview?.kpis.activeUsers.value ?? 0;
  const sessions = overview?.kpis.sessions24h.value ?? 0;
  const messages = overview?.kpis.messages24h.value ?? 0;

  const metrics = [
    { label: "人均会话", value: activeUsers > 0 ? sessions / activeUsers : null, unit: "次/人" },
    { label: "单会话消息", value: sessions > 0 ? messages / sessions : null, unit: "条/会话" },
    { label: "人均消息", value: activeUsers > 0 ? messages / activeUsers : null, unit: "条/人" }
  ];

  return (
    <div className="dashboard-subsection">
      <div className="dashboard-subsection-heading">
        <p>运营效率</p>
        <span>{windowLabel}</span>
      </div>
      <div className="divide-y divide-[var(--border-light)]">
        {metrics.map((metric) => {
          const valueText =
            metric.value === null ? "-" : `${formatRatio(metric.value)} ${metric.unit}`;
          return (
            <div key={metric.label} className="flex items-center justify-between py-2">
              <span className="text-xs text-[var(--text-tertiary)]">{metric.label}</span>
              <span className="text-sm font-semibold tabular-nums text-[var(--text-secondary)]">
                {valueText}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const AIPerformanceCard = ({
  performance,
  metricStatus,
  health,
  overview,
  timeWindowLabel
}: {
  performance: DashboardPerformance | null;
  metricStatus: MetricStatusView;
  health: HealthStatus;
  overview: DashboardOverview | null;
  timeWindowLabel: string;
}) => {
  const healthCfg = HEALTH_CONFIG[health];
  const successRate = performance?.successRate ?? 0;
  const ringColor =
    successRate >= 95 ? "var(--success)" : successRate >= 85 ? "var(--warning)" : "var(--error)";

  const p95LatencyStatus = getLatencyStatus(performance?.p95LatencyMs);

  const radius = 50;
  const circumference = 2 * Math.PI * radius;
  const progress = (Math.min(successRate, 100) / 100) * circumference;

  return (
    <DashCard>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="dashboard-section-title mb-0">AI 性能</h2>
        <span className={cn("dashboard-status", healthCfg.className)}>{healthCfg.label}</span>
      </div>

      <div className="flex justify-center py-3">
        <div className="relative">
          <svg
            className="-rotate-90"
            viewBox="0 0 120 120"
            width="120"
            height="120"
            role="img"
            aria-label={`AI 请求成功率 ${formatPercent(successRate)}`}
          >
            <title>{`AI 请求成功率 ${formatPercent(successRate)}`}</title>
            <circle
              cx="60"
              cy="60"
              r={radius}
              fill="none"
              stroke="var(--bg-hover)"
              strokeWidth={8}
            />
            <circle
              cx="60"
              cy="60"
              r={radius}
              fill="none"
              stroke={ringColor}
              strokeWidth={8}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference - progress}
              className="transition-[stroke-dashoffset] duration-700 ease-out"
            />
          </svg>
          <div
            className="absolute inset-0 flex flex-col items-center justify-center"
            aria-hidden="true"
          >
            <span className="text-2xl font-bold" style={{ color: ringColor }}>
              {formatPercent(successRate)}
            </span>
            <span className="mt-0.5 text-xs text-[var(--text-tertiary)]">成功率</span>
          </div>
        </div>
      </div>

      <div className="divide-y divide-[var(--border-light)]">
        <MetricRow
          icon={Timer}
          label="平均响应"
          value={formatDuration(performance?.avgLatencyMs)}
          status={metricStatus.latency}
        />
        <MetricRow
          icon={Clock}
          label="P95 响应"
          value={formatDuration(performance?.p95LatencyMs)}
          status={p95LatencyStatus}
        />
      </div>

      <QualitySnapshot performance={performance} windowLabel={timeWindowLabel} />
      <EfficiencySnapshot overview={overview} windowLabel={timeWindowLabel} />
    </DashCard>
  );
};

// ============================================================================
// Insights
// ============================================================================

const TYPE_LABEL: Record<InsightCardData["type"], string> = {
  anomaly: "异常",
  trend: "趋势",
  recommendation: "建议"
};

const TYPE_ICON: Record<InsightCardData["type"], typeof Info> = {
  anomaly: AlertCircle,
  trend: Info,
  recommendation: Lightbulb
};

const TYPE_STYLE: Record<InsightCardData["type"], string> = {
  anomaly: "dashboard-insight-tag--danger",
  trend: "dashboard-insight-tag--primary",
  recommendation: "dashboard-insight-tag--warning"
};

const InsightCard = ({ item }: { item: InsightCardData }) => {
  const Icon = TYPE_ICON[item.type];

  return (
    <article className="dashboard-insight-row">
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={cn("dashboard-insight-tag", TYPE_STYLE[item.type])}>
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {TYPE_LABEL[item.type]}
        </span>
        <span className="text-[11px] tabular-nums text-[var(--text-tertiary)]">
          {item.timestamp}
        </span>
      </div>
      <p className="text-sm font-semibold text-[var(--text-primary)]">{item.title}</p>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">
        {item.metric}: {item.change}
      </p>
      <p className="mt-0.5 text-xs text-[var(--text-tertiary)]">归因：{item.context}</p>
      {item.action ? (
        <p className="mt-1 text-xs font-medium text-[var(--text-secondary)]">建议：{item.action}</p>
      ) : null}
    </article>
  );
};

const buildInsightList = (
  performance: DashboardPerformance | null,
  timeWindowLabel: string,
  timestamp: number | null,
  overview: DashboardOverview | null
): InsightCardData[] => {
  const t = formatTime(timestamp);
  const windowMessages = overview?.kpis?.messages24h?.value;

  if (!performance || !windowMessages) {
    return [
      {
        type: "trend",
        severity: "info",
        title: "暂无会话数据",
        metric: "Dashboard",
        change: timeWindowLabel,
        context: "当前窗口内暂无消息记录，各项指标将在会话产生后自动更新",
        timestamp: t
      }
    ];
  }

  const items: InsightCardData[] = [];

  if (performance.errorRate > 5 || performance.successRate < 95) {
    items.push({
      type: "anomaly",
      severity: "critical",
      title: "链路稳定性触发告警",
      metric: "成功率/错误率",
      change: `${performance.successRate.toFixed(1)}% / ${performance.errorRate.toFixed(1)}%`,
      context: "成功率低于 95% 或错误率高于 5%",
      action: "优先查看失败请求分布与超时节点",
      timestamp: t
    });
  } else {
    items.push({
      type: "trend",
      severity: "info",
      title: "系统可用性稳定",
      metric: "成功率",
      change: `${performance.successRate.toFixed(1)}%`,
      context: "当前窗口整体可用性处于健康区间",
      timestamp: t
    });
  }

  if (performance.noDocRate > 20) {
    items.push({
      type: "recommendation",
      severity: "warning",
      title: "召回质量需优化",
      metric: "无知识率",
      change: `${performance.noDocRate.toFixed(1)}%`,
      context: "无知识率超过 20%，用户命中体验存在风险",
      action: "优化索引覆盖率与检索重排策略",
      timestamp: t
    });
  }

  if (performance.avgLatencyMs > 15000) {
    items.push({
      type: "recommendation",
      severity: "warning",
      title: "响应性能需要关注",
      metric: "平均响应时间",
      change: `${(performance.avgLatencyMs / 1000).toFixed(2)}s`,
      context: "平均延迟高于 3s，影响交互体验",
      action: "排查慢节点与模型并发配置",
      timestamp: t
    });
  }

  if (items.length < 3) {
    items.push({
      type: "recommendation",
      severity: "info",
      title: "继续保持当前策略",
      metric: "运营状态",
      change: timeWindowLabel,
      context: "当前窗口内未发现显著异常趋势",
      timestamp: t
    });
  }

  return items.slice(0, 3);
};

const InsightSection = ({
  performance,
  overview,
  timeWindowLabel,
  timestamp,
  className
}: {
  performance: DashboardPerformance | null;
  overview: DashboardOverview | null;
  timeWindowLabel: string;
  timestamp: number | null;
  className?: string;
}) => {
  const items = useMemo(
    () => buildInsightList(performance, timeWindowLabel, timestamp, overview),
    [performance, timeWindowLabel, timestamp, overview]
  );
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [isScrollable, setIsScrollable] = useState(false);
  const [showScrollbar, setShowScrollbar] = useState(false);
  const hideScrollbarTimerRef = useRef<number | null>(null);

  const handleScroll = useCallback(() => {
    if (!isScrollable) return;
    setShowScrollbar(true);

    if (hideScrollbarTimerRef.current !== null) {
      window.clearTimeout(hideScrollbarTimerRef.current);
    }

    hideScrollbarTimerRef.current = window.setTimeout(() => {
      setShowScrollbar(false);
      hideScrollbarTimerRef.current = null;
    }, 500);
  }, [isScrollable]);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const updateScrollable = () => {
      setIsScrollable((prev) => {
        const next = el.scrollHeight > el.clientHeight + 1;
        return prev === next ? prev : next;
      });
    };

    updateScrollable();
    const resizeObserver = new ResizeObserver(updateScrollable);
    resizeObserver.observe(el);
    window.addEventListener("resize", updateScrollable);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateScrollable);
    };
  }, [items]);

  useEffect(
    () => () => {
      if (hideScrollbarTimerRef.current !== null) {
        window.clearTimeout(hideScrollbarTimerRef.current);
        hideScrollbarTimerRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    if (isScrollable) return;
    setShowScrollbar(false);

    if (hideScrollbarTimerRef.current !== null) {
      window.clearTimeout(hideScrollbarTimerRef.current);
      hideScrollbarTimerRef.current = null;
    }
  }, [isScrollable]);

  return (
    <DashCard className={cn("flex flex-col", className)}>
      <CardTitle>运营洞察</CardTitle>
      <div
        ref={contentRef}
        onScroll={handleScroll}
        className={cn(
          "flex-1 space-y-3",
          isScrollable
            ? cn(
                "overflow-y-auto pr-1 insight-scroll-shell",
                showScrollbar && "is-scrollbar-visible"
              )
            : "overflow-y-hidden"
        )}
      >
        {items.map((item, i) => (
          <InsightCard key={`${item.title}-${i}`} item={item} />
        ))}
      </div>
    </DashCard>
  );
};

// ============================================================================
// Main Page
// ============================================================================

export function DashboardPage() {
  const {
    timeWindow,
    setTimeWindow,
    loading,
    error,
    lastUpdated,
    overview,
    performance,
    trends,
    refresh
  } = useDashboardData();

  const { health, metricStatus } = useHealthStatus(performance, overview);

  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);

  return (
    <div className="admin-page">
      <DashboardHeader
        timeWindow={timeWindow}
        lastUpdated={lastUpdated}
        loading={loading}
        onRefresh={() => void refresh()}
        onTimeWindowChange={setTimeWindow}
      />

      {error ? (
        <div className="dashboard-alert" role="alert">
          <div className="flex min-w-0 items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}，已保留当前可用内容。</span>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            重试
          </Button>
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          <KPISection overview={overview} timeWindow={timeWindow} />
          <TrafficOverviewSection
            trends={trends}
            overview={overview}
            timeWindow={timeWindow}
            loading={loading}
            className="h-[300px]"
          />
          <TrendSection trends={trends} timeWindow={timeWindow} loading={loading} />
        </div>

        <aside className="min-w-0 space-y-5 xl:sticky xl:top-20 xl:self-start">
          <AIPerformanceCard
            performance={performance}
            metricStatus={metricStatus}
            health={health}
            overview={overview}
            timeWindowLabel={WINDOW_LABEL_MAP[timeWindow]}
          />
          <InsightSection
            performance={performance}
            overview={overview}
            timeWindowLabel={WINDOW_LABEL_MAP[timeWindow]}
            timestamp={lastUpdated}
            className="h-[360px]"
          />
        </aside>
      </div>
    </div>
  );
}
