# 简历亮点理解文档索引

本目录存放对简历中五个技术亮点的深度理解文档，用于面试前的系统复习与自我检验。

## 文件列表

| 文件 | 对应简历亮点 | 状态 | 说明 |
|------|-------------|------|------|
| [highlight-01-dual-channel-retrieval.md](./highlight-01-dual-channel-retrieval.md) | 双路并行召回 + 去重重排序流水线 | **已完成** | CompletableFuture 三层并行、意图定向/全局搜索通道、去重算法、百炼重排模型、降级策略 |
| [highlight-02-schedule-engine.md](./highlight-02-schedule-engine.md) | 知识库定时同步引擎 | **已完成** | MySQL 分布式锁、自适应心跳、分阶段错误恢复、ETag 条件拉取、看门狗机制 |
| [interview-question-guide.md](./interview-question-guide.md) | 通用提问 Guide | **已完成** | 说明后面应该怎么提问题，优先提哪些类型的问题，避免问成纯代码细节题 |
| [highlight-03-circuit-breaker-ttfb.md](./highlight-03-circuit-breaker-ttfb.md) | 三态熔断器 + TTFB 探测 + 多模型自动降级 | **已完成** | 三态熔断器、CountDownLatch 首包等待、ProbeBufferingCallback 事件缓冲、无感切换 |
| [highlight-04-context-completion.md](./highlight-04-context-completion.md) | 大模型前置上下文补全与长句拆解 | **已完成** | 术语归一化 + LLM 改写拆分、三级降级、指代消解、子问题并行分发、意图数跨子问题分配 |
| [highlight-05-redis-queue-rate-limit.md](./highlight-05-redis-queue-rate-limit.md) | Redis 分布式排队限流 + SSE 实时推送 | **已完成** | Redis ZSET 排队、Lua 原子 claim、可过期信号量、Pub/Sub 跨节点唤醒、SSE 事件协议、跨节点流式取消 |

## 文档结构约定

每个亮点文档包含以下章节：

1. **简历原文** — 简历上的原始表述
2. **业务背景** — 该亮点解决的实际业务问题
3. **整体流程** — 核心流程图解与步骤说明
4. **疑问与解答记录** — 理解过程中的疑问、错误认知及正确答案
5. **面试高频追问预判** — 可能被问到的问题及核心回答要点
