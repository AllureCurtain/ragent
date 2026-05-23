# Best Practices Index

这个目录用于沉淀项目中值得复用的工程实现方式，重点记录：

- 架构设计思路
- 模块分层方式
- 可扩展实现模式
- 稳定、可复用的工程实践
- 适合后续开发借鉴的实现套路

## 目录

- [ingestion-architecture.md](./ingestion-architecture.md)
  记录 `ingestion` 中 pipeline / task / node / context / engine 的整体架构与主流程。

- [infra-ai-model-routing-and-health.md](./infra-ai-model-routing-and-health.md)
  记录 `infra-ai` 中模型路由、失败切换、健康状态管理的实现方式与可借鉴点。

- [rag-trace-architecture.md](./rag-trace-architecture.md)
  记录 `RAG Trace` 中 root / node 注解、AOP 采集、上下文传播、节点栈与调用树构建逻辑。

- [mcp-dual-end-architecture.md](./mcp-dual-end-architecture.md)
  记录 MCP 在 `bootstrap` 与 `mcp-server` 两端的整体结构、调用链、注册中心、执行器、client 与 dispatcher 的分工。

## 记录原则

1. 只记录值得长期复用的实践，不记录一次性业务细节。
2. 优先记录“为什么这样设计”，而不是只记“代码在哪”。
3. 每篇文档尽量包含：
   - 场景/问题
   - 当前实现方式
   - 为什么合理
   - 可借鉴点
   - 后续可能演进方向
4. 尽量附上关键类或关键流程，方便回看源码。
