# RAG Trace 调用链追踪实践总结

## 1. 这个实践解决什么问题

RAG 系统的执行链路通常比较长，常见会经过：

- query rewrite
- intent resolve
- retrieval
- multi-channel retrieval
- llm routing
- provider chat
- tool call

如果只有普通日志，通常只能看到零散的打印信息，很难回答下面这些问题：

- 一次请求到底经过了哪些关键节点？
- 哪个节点耗时最高？
- 哪个节点失败了？
- 某个 provider 是不是经常出错？
- 多层嵌套调用之间的父子关系是什么？

这个项目里的 `RAG Trace` 机制，本质上是在做：

> 为一次完整的 RAG 调用建立结构化调用链追踪能力，而不是只依赖平铺日志。

---

## 2. 核心设计目标

这套设计想解决的核心问题是：

- 给每次 RAG 请求分配唯一 `traceId`
- 记录整条链路的开始、结束、成功、失败、耗时
- 记录链路中每个关键节点的执行情况
- 保存节点之间的父子层级关系
- 在异步线程切换时保持 trace 上下文不丢失

也就是说，目标不是“多打一层日志”，而是：

> 把 RAG 的运行过程建模成一棵可追踪、可持久化、可查询的执行树。

---

## 3. 核心组成

### 3.1 注解层

- `framework/src/main/java/com/nageoffer/ai/ragent/framework/trace/RagTraceRoot.java`
- `framework/src/main/java/com/nageoffer/ai/ragent/framework/trace/RagTraceNode.java`

它们分别标记：

- 整条调用链入口
- 调用链中的普通节点

### 3.2 上下文层

- `framework/src/main/java/com/nageoffer/ai/ragent/framework/trace/RagTraceContext.java`

负责在当前线程和异步线程中维护：

- `traceId`
- `taskId`
- 当前节点路径栈

### 3.3 AOP 采集层

- `bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/aop/RagTraceAspect.java`

负责拦截注解方法，在方法开始/结束/异常时写入 trace 记录。

### 3.4 持久化层

- `bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/service/RagTraceRecordService.java`
- `bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/service/impl/RagTraceRecordServiceImpl.java`

负责把 run 和 node 持久化到数据库。

### 3.5 数据实体层

- `bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/dao/entity/RagTraceRunDO.java`
- `bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/dao/entity/RagTraceNodeDO.java`

分别记录：

- 一次完整 trace run
- trace 中的每个节点

---

## 4. Root 与 Node 的分工

### 4.1 `@RagTraceRoot`

`@RagTraceRoot` 表示：

> 一次完整调用链的根入口

它负责启动整条 trace run，例如：

- 生成 `traceId`
- 记录 run 开始时间
- 记录入口方法
- 解析 conversationId / taskId
- 在执行结束时更新整条 run 的状态和耗时

它关注的是：

- 整条链路级别的信息

### 4.2 `@RagTraceNode`

`@RagTraceNode` 表示：

> 调用链中的某个具体步骤

比如：

- `query-rewrite`
- `intent-resolve`
- `retrieval-engine`
- `multi-channel-retrieval`
- `llm-chat-routing`
- `bailian-chat`

它关注的是：

- 单个节点级别的信息

---

## 5. AOP 核心逻辑

### 5.1 Root 逻辑

`RagTraceAspect` 会拦截 `@RagTraceRoot` 方法，并做这些事情：

1. 判断 trace 功能是否开启
2. 如果当前线程已经有 traceId，则避免重复创建 root
3. 生成新的 `traceId`
4. 从方法参数中解析 `conversationId` / `taskId`
5. 创建一条 run 记录，状态先设为 `RUNNING`
6. 将 `traceId` 写入 `RagTraceContext`
7. 执行原方法
8. 成功则将 run 更新为 `SUCCESS`
9. 异常则将 run 更新为 `ERROR`
10. finally 中清理上下文

一句话概括：

> root 负责启动和结束整条 trace。

### 5.2 Node 逻辑

`RagTraceAspect` 也会拦截 `@RagTraceNode` 方法，并做这些事情：

1. 判断 trace 功能是否开启
2. 如果当前线程没有 `traceId`，则直接执行原方法，不记录节点
3. 生成新的 `nodeId`
4. 从 `RagTraceContext` 中取当前父节点 `parentNodeId`
5. 读取当前深度 `depth`
6. 创建一条 node 记录，状态先设为 `RUNNING`
7. 把当前 `nodeId` 压入上下文栈
8. 执行原方法
9. 成功则更新节点为 `SUCCESS`
10. 异常则更新节点为 `ERROR`
11. finally 中把当前节点弹栈

一句话概括：

> node 负责记录调用链中的每一步执行情况，并维护节点树结构。

---

## 6. `RagTraceContext` 的关键价值

`RagTraceContext` 是整套 trace 的运行时上下文。

它的作用不仅仅是保存一个 `traceId`，更重要的是维护：

- 当前 trace 属于哪条调用链
- 当前执行路径上的节点栈
- 当前节点的父子层级关系

### 6.1 为什么有一个“栈”

这里的栈不是业务数据栈，而是：

> 当前调用链节点路径栈

例如当前执行路径是：

```text
retrieval-engine -> multi-channel-retrieval -> provider-call
```

那么栈中就会维护类似：

```text
[retrieval-engine, multi-channel-retrieval, provider-call]
```

栈顶表示当前节点；栈顶下面那个就是当前节点的父节点。

### 6.2 为什么要这样设计

因为 trace 不是只想知道“执行过哪些方法”，而是想知道：

- 谁调用了谁
- 节点的嵌套层级是什么
- 最终怎样还原一棵调用树

如果没有栈，只记录节点列表，就只能得到平铺记录，无法准确恢复父子关系。

### 6.3 push / pop 的含义

进入一个 trace node：

- 先读取当前栈顶作为 `parentNodeId`
- 再把自己压栈

退出一个 trace node：

- 把自己弹栈

这样就能自然维护调用路径。

### 6.4 depth 怎么来

`depth` 本质上就是当前节点压栈前的层级深度。

因此：

- root 下的直接节点通常是 `depth = 0`
- 子节点是 `depth = 1`
- 更深层依次递增

---

## 7. 为什么要用 `TransmittableThreadLocal`

`RagTraceContext` 不是用普通 `ThreadLocal`，而是用了：

- `TransmittableThreadLocal`

同时线程池也通过 `TtlExecutors` 做了包装。

这是因为 RAG 链路里存在异步执行场景。如果只用普通 `ThreadLocal`，一旦线程切换：

- `traceId` 会丢失
- 当前节点栈会丢失
- trace 树会断裂

而使用 TTL 的好处是：

> trace 上下文可以在异步线程之间传递，保证一条链路在跨线程时仍然能够被正确串起来。

这也是这套设计很像成熟工程实践的一个关键点。

---

## 8. 一次完整链路是怎么串起来的

可以把整体过程理解成：

```text
入口方法（@RagTraceRoot）
   -> 生成 traceId
   -> 创建 trace run
   -> 写入 RagTraceContext
      -> 中间方法（@RagTraceNode）
         -> 生成 nodeId
         -> 根据栈得到 parentNodeId 和 depth
         -> 记录节点开始
         -> 执行业务
         -> 记录节点结束
      -> 下一个节点继续
   -> run 完成
   -> 清理上下文
```

如果展开成一棵树，可能是：

```text
chat-root
 ├─ query-rewrite
 ├─ intent-resolve
 ├─ retrieval-engine
 │   └─ multi-channel-retrieval
 └─ llm-chat-routing
     └─ bailian-chat
```

最终数据库里会有：

- 一条 run 记录：描述整次调用
- 多条 node 记录：描述每个步骤

---

## 9. 为什么这是最佳实践

### 9.1 用注解 + AOP 做低侵入式埋点

业务代码只需要在关键方法上打注解，不必自己手工写开始/结束/异常记录逻辑。

### 9.2 root / node 分层清晰

把“整条链路”和“链路中的步骤”拆开，是很典型的追踪系统设计。

### 9.3 运行时上下文与持久化结构分离

- `RagTraceContext` 负责运行时传递
- `RagTraceRunDO` / `RagTraceNodeDO` 负责落库展示

这种分层很清晰。

### 9.4 能形成树，而不是平铺日志

父节点、深度、节点栈这些设计，使 trace 最终可以还原成调用树，这比普通日志的排查价值大很多。

### 9.5 异步上下文传播考虑得比较完整

不是只在同步调用里可用，而是考虑了线程池中的 trace 透传。

---

## 10. 开发时可借鉴的点

以后设计类似的链路追踪能力时，可以优先借鉴：

### 10.1 明确区分 root 与 node

不要把整条请求和中间步骤混成一类记录。

### 10.2 用上下文对象维护运行时状态

例如：

- traceId
- taskId
- 当前节点路径

### 10.3 用栈维护调用路径

这是处理嵌套节点关系最自然、最稳定的方式。

### 10.4 用 AOP 做统一采集

比在每个方法里手写 try/finally 记录更干净，也更容易统一演进。

### 10.5 trace 要考虑异步线程传播

如果链路里涉及线程池，普通 `ThreadLocal` 很容易导致上下文断裂。

---

## 11. 当前实践的边界

这套设计已经很有参考价值，但从更高成熟度看，后续还可以继续增强，例如：

- root 注解的接入覆盖度进一步完善
- 更完整的 trace 展示和查询能力
- 与日志、监控、告警体系进一步联动
- 对流式场景、批处理场景做更细粒度追踪
- 对跨服务 trace 做进一步扩展

所以它当前最值得学习的地方是：

> 它已经把“领域调用链追踪”建成了一套结构化能力，而不是停留在简单日志层面。

---

## 12. 一句话总结

RAG Trace 这里的最佳实践价值在于：

> 它通过 `@RagTraceRoot` + `@RagTraceNode` + `RagTraceAspect` + `RagTraceContext` + 持久化记录，把复杂 RAG 链路变成了一棵可追踪、可分析、可落库的执行树，并且考虑了异步线程中的上下文传播问题。
