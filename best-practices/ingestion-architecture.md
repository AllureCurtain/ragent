# Ingestion 架构实践总结

## 1. 这个实践解决什么问题

Ingestion 的职责不是“简单上传文件”，而是把外部原始数据加工成系统可检索、可索引、可被 RAG 使用的知识数据。

可以理解为：

- `knowledge`：管理知识数据
- `rag`：消费知识数据进行问答
- `ingestion`：生产知识数据

所以 ingestion 是整个 RAG 平台里的**数据入口与加工流水线**。

---

## 2. 核心架构分层

### 2.1 流程定义层：Pipeline

`pipeline` 表示一条静态的处理流程定义，回答的是：

> 这类数据应该怎么处理？

一个 pipeline 一般包含：

- 流程名称
- 流程描述
- 节点列表 `nodes`
- 节点之间的连接关系 `nextNodeId`
- 每个节点的参数 `settings`
- 节点执行条件 `condition`

### 2.2 执行实例层：Task

`task` 表示一次真实执行，回答的是：

> 某条 pipeline 被实际运行了一次，结果如何？

一个 task 会记录：

- 本次使用的 pipelineId
- 数据源类型与位置
- 当前状态（running/completed/failed）
- chunk 数量
- 错误信息
- 开始/结束时间

### 2.3 步骤层：Node

`node` 是 pipeline 中的处理步骤，属于 pipeline 的组成部分。

典型 node 包括：

- fetcher
- parser
- chunker
- enhancer
- indexer

注意区分两种 node：

- `NodeConfig`：流程定义里的节点配置
- `TaskNode` / `NodeLog`：某次 task 执行时产生的节点运行记录

---

## 3. 三者关系

整体关系可以记成：

- `Pipeline`：流程模板
- `Task`：流程模板的一次执行
- `Node`：流程模板里的步骤
- `TaskNode`：步骤在某次执行中的运行记录

关系图：

```text
Pipeline
  └── Nodes（定义步骤）

Task
  └── belongs to one Pipeline
  └── runs Nodes in order
  └── generates TaskNode logs/records
```

更具体地说：

- 一个 pipeline 可以被执行很多次
- 每次执行都会生成一个 task
- task 执行时会按顺序跑 pipeline 中的 node
- 每个 node 的执行结果会形成 task node 记录

---

## 4. 运行时核心对象：IngestionContext

`IngestionContext` 是 ingestion 的运行时上下文，也是整条流水线的“中间态容器”。

它承载的数据通常包括：

- `taskId`
- `pipelineId`
- `source`
- `rawBytes`
- `mimeType`
- `rawText`
- `document`
- `chunks`
- `keywords`
- `questions`
- `metadata`
- `logs`
- `status`
- `error`

最佳实践上，这种 `context` 模式非常适合流水线架构，因为：

- 节点之间解耦
- 中间结果集中传递
- 易于扩展新节点
- engine 不需要知道每个节点的业务细节

---

## 5. executeInternal 的核心逻辑

`executeInternal` 可以概括为四步：

### 5.1 加载流程定义

- 校验 `pipelineId`
- 根据 `pipelineId` 加载 `PipelineDefinition`

### 5.2 创建任务主记录

先创建 `IngestionTask`，把本次执行登记下来：

- 任务归属哪条 pipeline
- 数据源是什么
- 当前状态先设为 `RUNNING`

这样即使后续失败，也能追踪到这次任务。

### 5.3 构造上下文并执行引擎

- 构造 `IngestionContext`
- 调用 `engine.execute(pipeline, context)`

引擎内部会：

- 校验 pipeline 配置是否合法
- 找到起始节点
- 按 `nextNodeId` 链式顺序执行
- 每执行一个 node，就往 `context.logs` 写入 `NodeLog`
- 如果节点失败，则整个 task 失败

### 5.4 持久化结果并返回摘要

执行完成后：

- 保存节点执行记录 `TaskNode`
- 更新任务主表状态、chunk 数量、错误信息、元数据
- 返回一个简化结果 `IngestionResult`

可以记成一句话：

> `executeInternal = 建任务 -> 建上下文 -> 跑引擎 -> 存结果`

---

## 6. 当前架构为什么合理

这套设计的优点主要有：

### 6.1 定义与执行分离

把“流程模板”和“运行实例”拆开，是很典型的工程化设计。

### 6.2 流程可配置

不是把 parse/chunk/index 写死在 service 里，而是用 pipeline + node 组织流程。

### 6.3 节点可插拔

通过 `nodeType -> IngestionNode` 的方式做扩展，新节点更容易接入。

### 6.4 可观测性较好

除了 task 总记录外，还有 node 级执行日志，方便定位失败节点和耗时问题。

### 6.5 适合 RAG 平台

RAG 系统的数据导入天然适合流水线模式：

- 获取原始内容
- 解析
- 切块
- 增强
- 建索引

---

## 7. 关于“同步 task”与“顺序 node”

这里要特别区分两个概念。

### 7.1 当前实现

当前更像是：

- **task：同步执行**
- **node：顺序执行**

也就是说，HTTP 请求进来后，会直接在当前调用链里执行完整个 task。

### 7.2 为什么 node 顺序执行是合理的

因为大部分 node 有明显依赖关系：

- 没有原始内容，就无法 parser
- 没有解析结果，就无法 chunk
- 没有 chunks，就无法 index

所以 task 内部按顺序执行 node 是合理且常见的。

### 7.3 未来可演进方向

如果后续规模变大，更常见的演进方向不是“把 node 全并发”，而是：

> 把 task 调度改成异步

即：

- 请求先创建 task
- task 进入后台队列
- worker 再执行 pipeline
- task 内部 node 仍可以保持顺序执行

---

## 8. 可借鉴的最佳实践

以后如果要设计类似能力，可以优先参考以下原则：

### 8.1 先分清三层

- 流程定义层：Pipeline
- 运行实例层：Task
- 步骤执行层：Node / TaskNode

### 8.2 不要把流程写死在一个 Service 方法里

应优先采用：

- 配置驱动
- 节点拆分
- 引擎调度

### 8.3 用 Context 承载中间态

避免在节点之间传大量零散参数，统一放进 context。

### 8.4 要记录节点级执行信息

不要只记录任务最终成功/失败，还要记录：

- 哪个节点执行了
- 是否成功
- 耗时多久
- 输出了什么
- 为什么失败

### 8.5 先保证串行链路清晰，再考虑异步化/并发化

成熟架构的演进顺序通常是：

1. 先把单任务的执行链路设计清楚
2. 再补任务记录和可观测性
3. 再考虑异步调度
4. 最后才考虑更复杂的并发、DAG、重试与恢复

---

## 9. 一句话总结

Ingestion 这里的设计，本质上是：

> 用 `Pipeline` 定义流程，用 `Task` 承载一次执行，用 `Node` 拆解步骤，用 `Context` 传递中间态，用 `Engine` 驱动顺序执行，并用任务记录与节点日志保证可追踪性。

这是一种很典型、也很值得在后续开发中借鉴的工程化实现方式。
