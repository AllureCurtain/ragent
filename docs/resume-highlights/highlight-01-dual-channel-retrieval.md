# 简历亮点一：双路并行召回 + 去重 + 重排序流水线

## 一、简历原文

> 通过 CompletableFuture 实现双路并行召回机制，结合自研去重与重排序流水线，显著提升复杂场景下知识检索的精准度

## 二、业务背景

用户提问后，系统需要从多个知识库中检索相关文档片段（chunk）作为 LLM 的上下文。单一检索策略要么召回不全（只搜特定知识库）、要么召回太多噪音（搜全部知识库）。因此设计了**双通道并行检索**：一个精准定向、一个全局兜底，合并后再去重、重排序，最终只把最相关的 top-K 个 chunk 送给大模型。

## 三、整体流程

```
用户提问
  │
  ▼
RetrievalEngine.retrieve()
  │  对每个子问题用 CompletableFuture 并行构建上下文（子问题级并行）
  │  线程池：ragContextExecutor
  ▼
每个子问题调用 retrieveAndRerank()
  │
  ▼
MultiChannelRetrievalEngine.retrieveKnowledgeChannels()
  │
  ├── 【阶段1：双通道并行检索】
  │     过滤启用的通道，按优先级排序
  │     用 CompletableFuture.supplyAsync() 并行执行（通道级并行）
  │     线程池：ragRetrievalExecutor
  │
  │     通道1：IntentDirectedSearchChannel（意图定向搜索）
  │       优先级：1（最高）
  │       启用条件：识别出 KB 意图且分数 >= 0.4
  │       策略：只搜索意图对应的特定知识库 collection
  │       内部并行：对多个 intent 节点并行检索（集合/意图级并行）
  │       TopK 倍数：2x
  │
  │     通道2：VectorGlobalSearchChannel（向量全局搜索）
  │       优先级：10（低，兜底）
  │       启用条件：意图定向关闭 OR 无意图 OR 最大意图分数 < 0.6 OR 单一意图分数 < 0.8
  │       策略：搜索所有知识库 collection
  │       内部并行：对多个 collection 并行检索（集合/意图级并行）
  │       TopK 倍数：3x
  │
  │     容错：任一通道异常 → try-catch 返回空结果，不阻断其他通道
  │
  ├── 【阶段2：后置处理器链】
  │     按 order 排序依次执行：
  │
  │     处理器1：DeduplicationPostProcessor（order=1）
  │       按通道优先级顺序合并结果
  │       基于 chunk ID 或内容 hash 去重
  │       同一 chunk 在多个通道出现 → 保留分数最高的
  │
  │     处理器2：RerankPostProcessor（order=10）
  │       受 rag.rerank.enabled 控制，默认开启
  │       调用 RerankService.rerank()
  │       → RoutingRerankService（路由 + 降级）
  │       → BaiLianRerankClient（百炼重排模型 API）
  │       对去重后的所有候选重新打分，返回 top-K
  │       失败降级：NoopRerankClient（直接取前 top-K）
  │
  ▼
ContextFormatter.formatKbContext()
  │  将最终 chunk 格式化为 LLM 可读的文本上下文
  ▼
送给大模型生成回答
```

### 3.1 三层并行架构

| 层级 | 代码位置 | 并行内容 | 线程池 |
|------|---------|---------|--------|
| **子问题级** | `RetrievalEngine` | 多个子问题并行构建上下文 | `ragContextExecutor` |
| **通道级** | `MultiChannelRetrievalEngine` | 多个启用通道并行执行 | `ragRetrievalExecutor` |
| **集合/意图级** | `AbstractParallelRetriever` | 多个 collection 或 intent 节点并行检索 | `innerRetrievalExecutor` |

### 3.2 双通道对比

| 维度 | 意图定向搜索 | 向量全局搜索 |
|------|-------------|-------------|
| 类名 | `IntentDirectedSearchChannel` | `VectorGlobalSearchChannel` |
| 优先级 | 1 | 10 |
| 作用 | **精准**：只搜意图对应的知识库 | **兜底**：搜所有知识库 |
| 启用条件 | 有 KB 意图且分数 >= 0.4 | 意图定向关闭 OR 无意图 OR 最大分数 < 0.6 OR 单一意图分数 < 0.8 |
| 内部并行 | 对多个 intent 节点并行 | 对多个 collection 并行 |
| TopK 倍数 | 2x | 3x |

### 3.3 通道启用关系

两个通道**不是互斥的**：

| 意图情况 | 意图定向 | 全局搜索 |
|---------|---------|---------|
| 无意图 | 不启用 | 启用 |
| 最高分 < 0.4 | 不启用 | 启用 |
| 0.4 <= 最高分 < 0.6 | 启用 | 启用 |
| 0.6 <= 最高分 < 0.8，且只有 1 个意图 | 启用 | 启用 |
| 0.6 <= 最高分 < 0.8，且有多个意图 | 启用 | 不启用 |
| 最高分 >= 0.8 | 启用 | 不启用 |

这里的 `0.8` 来自 `singleIntentSupplementThreshold`。它解决的是“只有一个中等置信意图时过早关闭全局召回”的问题：虽然最高分已经超过 `0.6`，但如果只有一个意图且没有其他候选可以互相校验，系统仍会打开全局检索做安全网。

另外，当前实现里还有一个兜底边界：如果配置关闭了 `intent-directed.enabled`，`VectorGlobalSearchChannel` 会直接启用。否则在只关闭意图定向通道的情况下，可能出现没有任何检索通道可用的问题。

### 3.4 意图分数到底怎么来的？

意图分数不是代码里用向量距离算出来的，也不是固定规则 `if/else` 打出来的。当前实现是 **LLM 对意图树叶子节点打分，代码负责解析、排序、过滤和限流**。

核心链路如下：

1. `DefaultIntentClassifier.loadIntentTreeData()` 从 Redis 读取意图树；缓存没有时从 DB 加载启用节点并回填缓存。
2. 只取叶子节点参与分类。`IntentNode.isLeaf()` 的注释也写明：叶子节点才挂知识库，叶子节点才参与意图匹配打分。
3. `DefaultIntentClassifier.buildPrompt()` 把每个叶子节点的 `id / path / description / type / toolId / examples` 拼进 `prompt/intent-classifier.st`。
4. LLM 返回 JSON 数组，例如 `[{"id":"biz-12306-order","score":0.88,"reason":"..."}]`。
5. `DefaultIntentClassifier.classifyTargets()` 解析 JSON，把 `id` 映射回 `IntentNode`，按 `score` 降序排序。
6. `IntentResolver.classifyIntents()` 再过滤 `score >= INTENT_MIN_SCORE`，当前 `INTENT_MIN_SCORE = 0.35`，并限制最多 `MAX_INTENT_COUNT = 3`。

也就是说，**分数本身由 LLM 根据意图分类 prompt 和意图树描述生成**。代码不重新计算这个分数，只信任它做后续路由判断。

`prompt/intent-classifier.st` 里给模型的评分口径是：

| 分数区间 | 含义 |
|---------|------|
| `> 0.8` | 强匹配：关键实体或主题明确一致，问题场景高度吻合 |
| `0.4~0.8` | 中等相关：部分要素匹配，但关键实体不完全一致 |
| `< 0.4` | 弱相关：仅勉强沾边，建议返回空数组 |

这里要区分两个阈值：

| 阈值 | 代码位置 | 作用 |
|------|---------|------|
| `0.35` | `RAGConstant.INTENT_MIN_SCORE` | 意图解析阶段的候选保留线，低于它直接丢掉 |
| `0.4` | `intent-directed.minIntentScore` | 检索阶段的定向通道启用线，KB 意图低于它不走意图定向检索 |
| `0.6` | `vector-global.confidenceThreshold` | 最高意图分低于它时，全局检索兜底 |
| `0.8` | `vector-global.singleIntentSupplementThreshold` | 只有一个中等置信意图时，继续打开全局检索补召回 |

### 3.5 从接口到通道选择的完整例子

下面这个例子不是为了证明某个固定业务答案，而是为了覆盖三种检索路径：高置信只走定向、中等置信双通道、无意图走全局兜底。

用户请求：

```text
GET /rag/v3/chat?question=请帮我详细说一下：12306 的订单流程是什么？支付环节怎么处理？推荐一部周末看的电影？
```

#### 第一步：接口进入

入口是 `RAGChatController.chat()`：

```java
@GetMapping(value = "/rag/v3/chat", produces = "text/event-stream;charset=UTF-8")
public SseEmitter chat(@RequestParam String question,
                       @RequestParam(required = false) String conversationId,
                       @RequestParam(required = false, defaultValue = "false") Boolean deepThinking) {
    SseEmitter emitter = new SseEmitter(ragDefaultProperties.getSseTimeoutMs());
    ragChatService.streamChat(question, conversationId, deepThinking, emitter);
    return emitter;
}
```

然后 `RAGChatServiceImpl.streamChat()` 生成 `conversationId / taskId / callback`，构造 `StreamChatContext`，最后进入 `chatPipeline.execute(ctx)`。

#### 第二步：归一化重写

`StreamChatPipeline.execute()` 的前半段顺序是：

```java
loadMemory(ctx);
rewriteQuery(ctx);
resolveIntents(ctx);
```

`rewriteQuery(ctx)` 调用：

```java
RewriteResult rewriteResult = queryRewriteService.rewriteWithSplit(ctx.getQuestion(), ctx.getHistory());
ctx.setRewriteResult(rewriteResult);
```

实际实现是 `MultiQuestionRewriteService.rewriteWithSplit()`：

```java
String normalizedQuestion = queryTermMappingService.normalize(userQuestion);
return callLLMRewriteAndSplit(normalizedQuestion, userQuestion, history);
```

这里先走 `QueryTermMappingService.normalize()`。它会读取后台配置的术语映射，逐条执行 `QueryTermMappingUtil.applyMapping()`。例如后台配置了：

| sourceTerm | targetTerm |
|------------|------------|
| `12306` | `12306系统` |

那么问题会先从：

```text
请帮我详细说一下：12306 的订单流程是什么？支付环节怎么处理？推荐一部周末看的电影？
```

归一化成：

```text
请帮我详细说一下：12306系统 的订单流程是什么？支付环节怎么处理？推荐一部周末看的电影？
```

接着 `callLLMRewriteAndSplit()` 会加载 `prompt/user-question-rewrite.st`。这个 prompt 要求模型返回：

```json
{
  "rewrite": "改写后的查询",
  "should_split": true,
  "sub_questions": ["子问题1", "子问题2"]
}
```

在这个例子里，LLM 可能返回：

```json
{
  "rewrite": "12306系统的订单流程、支付环节处理和周末电影推荐",
  "should_split": true,
  "sub_questions": [
    "12306系统的订单流程是什么",
    "12306系统的支付环节怎么处理",
    "推荐一部周末看的电影"
  ]
}
```

`parseRewriteAndSplit()` 会把 JSON 解析成：

```java
new RewriteResult(rewrite, subs)
```

所以此时上下文里的变量大致是：

```text
rewriteResult.rewrittenQuestion =
  "12306系统的订单流程、支付环节处理和周末电影推荐"

rewriteResult.subQuestions =
  [
    "12306系统的订单流程是什么",
    "12306系统的支付环节怎么处理",
    "推荐一部周末看的电影"
  ]
```

如果 `rag.query-rewrite.enabled=false`，代码不会调用 LLM 改写，而是走 `normalize()` + `ruleBasedSplit()`。如果 LLM 调用或 JSON 解析失败，则兜底为 `new RewriteResult(normalizedQuestion, List.of(normalizedQuestion))`。

#### 第三步：对子问题做意图打分

`resolveIntents(ctx)` 调用：

```java
List<SubQuestionIntent> subIntents = intentResolver.resolve(ctx.getRewriteResult());
ctx.setSubIntents(subIntents);
```

`IntentResolver.resolve()` 会取 `rewriteResult.subQuestions()`；如果没有子问题，就退回 `rewriteResult.rewrittenQuestion()`。然后每个子问题用 `CompletableFuture.supplyAsync()` 并行调用 `classifyIntents(q)`。

对每个子问题，`DefaultIntentClassifier.classifyTargets(question)` 会让 LLM 在意图树叶子节点里选择候选并输出分数。假设当前意图树里有这些叶子节点：

| id | type | path | collectionName |
|----|------|------|----------------|
| `biz-12306-order` | KB | 业务系统 / 12306系统 / 订单流程 | `kb_12306_order` |
| `biz-12306-payment` | KB | 业务系统 / 12306系统 / 支付处理 | `kb_12306_payment` |

那么三条子问题可能得到这样的候选：

```text
子问题1：12306系统的订单流程是什么
LLM 返回：biz-12306-order, score=0.91
IntentResolver 保留：0.91 >= 0.35

子问题2：12306系统的支付环节怎么处理
LLM 返回：biz-12306-payment, score=0.58
IntentResolver 保留：0.58 >= 0.35

子问题3：推荐一部周末看的电影
LLM 返回：[]
IntentResolver 保留：空意图
```

此时变量从 `RewriteResult` 变成 `List<SubQuestionIntent>`：

```text
subIntents = [
  SubQuestionIntent(
    subQuestion="12306系统的订单流程是什么",
    nodeScores=[NodeScore(node=biz-12306-order, score=0.91)]
  ),
  SubQuestionIntent(
    subQuestion="12306系统的支付环节怎么处理",
    nodeScores=[NodeScore(node=biz-12306-payment, score=0.58)]
  ),
  SubQuestionIntent(
    subQuestion="推荐一部周末看的电影",
    nodeScores=[]
  )
]
```

#### 第四步：按分数选择检索路径

`StreamChatPipeline.retrieve(ctx)` 调用：

```java
retrievalEngine.retrieve(ctx.getSubIntents(), searchProperties.getDefaultTopK());
```

`RetrievalEngine.retrieve()` 对每个 `SubQuestionIntent` 并行构建上下文。每个子问题都会进入：

```java
multiChannelRetrievalEngine.retrieveKnowledgeChannels(List.of(intent), topK);
```

也就是说，**通道选择是按子问题独立判断的**。

对子问题 1：

```text
nodeScores = [biz-12306-order: 0.91]
```

- `IntentDirectedSearchChannel.isEnabled()`：有 KB 意图，且 `0.91 >= 0.4`，启用
- `VectorGlobalSearchChannel.isEnabled()`：最高分 `0.91 >= 0.8`，不启用
- 结果：只搜 `biz-12306-order.collectionName = kb_12306_order`

对子问题 2：

```text
nodeScores = [biz-12306-payment: 0.58]
```

- `IntentDirectedSearchChannel.isEnabled()`：有 KB 意图，且 `0.58 >= 0.4`，启用
- `VectorGlobalSearchChannel.isEnabled()`：最高分 `0.58 < 0.6`，启用全局兜底
- 结果：同时搜 `kb_12306_payment` 和所有 KB collection，后续去重 + rerank

对子问题 3：

```text
nodeScores = []
```

- `IntentDirectedSearchChannel.isEnabled()`：没有 KB 意图，不启用
- `VectorGlobalSearchChannel.isEnabled()`：没有任何意图，启用全局检索
- 结果：搜索所有 KB collection；如果仍无结果，最终会进入“未检索到与问题相关的文档内容”的兜底回答

这个例子对应的路径表：

| 子问题 | 意图分数 | 意图定向检索 | 全局向量检索 | 原因 |
|--------|----------|--------------|--------------|------|
| 12306系统的订单流程是什么 | `0.91` | 启用 | 不启用 | 高置信 KB 意图，精准检索即可 |
| 12306系统的支付环节怎么处理 | `0.58` | 启用 | 启用 | 中等置信，定向检索 + 全局兜底 |
| 推荐一部周末看的电影 | 无意图 | 不启用 | 启用 | 无法定位 KB 意图，只能全局兜底 |

这张表还可以补两个边界分支：

| 意图识别结果 | 意图定向检索 | 全局向量检索 | 说明 |
|--------------|--------------|--------------|------|
| 只有 1 个 KB 意图，分数 `0.72` | 启用 | 启用 | 已超过 `0.6`，但单一意图还没到 `0.8`，全局检索继续补召回 |
| 有 2 个 KB 意图，最高分 `0.72` | 启用 | 不启用 | 多个候选能互相覆盖，最高分已超过 `0.6`，不再打开全局兜底 |

最终，所有启用通道返回的 chunk 会进入后置处理链：

```text
SearchChannelResult 列表
  -> DeduplicationPostProcessor 去重
  -> RerankPostProcessor 重排
  -> ContextFormatter.formatKbContext()
  -> LLM 生成最终回答
```

面试里可以把这个流程压缩成一句话：

> 请求进入后先做术语归一化和 LLM 改写拆分，得到 `RewriteResult`；每个子问题再通过 LLM 意图分类器对意图树叶子节点打分，形成 `SubQuestionIntent`；检索阶段不重新打分，而是根据这些分数决定启用意图定向通道、全局向量通道，或两个通道同时启用。

---

## 四、核心组件详解

### 4.1 通道级并行执行

`MultiChannelRetrievalEngine`：

```java
List<CompletableFuture<SearchChannelResult>> futures = enabledChannels.stream()
    .map(channel -> CompletableFuture.supplyAsync(
        () -> {
            try {
                return channel.search(context);
            } catch (Exception e) {
                log.error("检索通道 {} 执行失败", channel.getName(), e);
                return SearchChannelResult.builder()
                        .channelType(channel.getType())
                        .channelName(channel.getName())
                        .chunks(List.of())    // 返回空结果
                        .build();
            }
        },
        ragRetrievalExecutor
    ))
    .toList();
```

每个通道独立 try-catch，失败返回空 `SearchChannelResult`，不影响其他通道。

### 4.2 集合/意图级并行

`AbstractParallelRetriever`：

```java
List<RetrievalFuture<T>> futures = targets.stream()
    .map(target -> {
        CompletableFuture<List<RetrievedChunk>> future = CompletableFuture.supplyAsync(
            () -> createRetrievalTask(question, target, topK),
            executor
        );
        return new RetrievalFuture<>(target, future);
    })
    .toList();

List<RetrievedChunk> allChunks = new ArrayList<>();
for (RetrievalFuture<T> future : futures) {
    try {
        List<RetrievedChunk> chunks = future.future.join();
        allChunks.addAll(chunks);
        successCount++;
    } catch (Exception e) {
        failureCount++;  // 单个失败不影响其他结果
        log.error("获取检索结果失败 - 目标: {}", getTargetIdentifier(future.target), e);
    }
}
return allChunks;  // 只包含成功的结果
```

### 4.3 去重算法

`DeduplicationPostProcessor`：

```java
Map<String, RetrievedChunk> chunkMap = new LinkedHashMap<>();

// 按通道优先级排序（INTENT_DIRECTED=1 > KEYWORD_ES=2 > VECTOR_GLOBAL=3）
results.stream()
    .sorted((r1, r2) -> Integer.compare(
            getChannelPriority(r1.getChannelType()),
            getChannelPriority(r2.getChannelType())
    ))
    .forEach(result -> {
        for (RetrievedChunk chunk : result.getChunks()) {
            String key = generateChunkKey(chunk);  // chunk.getId() 或 text.hashCode()

            if (!chunkMap.containsKey(key)) {
                chunkMap.put(key, chunk);          // 首次出现，直接放入
            } else {
                RetrievedChunk existing = chunkMap.get(key);
                if (chunk.getScore() > existing.getScore()) {
                    chunkMap.put(key, chunk);      // 重复出现，保留分数高的
                }
            }
        }
    });

return new ArrayList<>(chunkMap.values());
```

### 4.4 重排序流水线

`BaiLianRerankClient`：

1. 接收 query + 所有候选 chunk 文本
2. 构造 HTTP 请求发送给百炼 rerank API
3. API 返回每个 chunk 的相关性分数（relevance_score）和原始 index
4. 按新分数重新排序，取 top-N
5. 如果返回数量不足，从原候选中补齐

降级策略：`RoutingRerankService` → 百炼模型失败 → `NoopRerankClient`（不做真正重排，直接保留当前输入顺序并截取前 top-K）。

---

## 五、疑问与解答记录

### Q1：双路并行召回具体是哪两路？为什么这样设计？

**正确答案：** 是 **IntentDirectedSearchChannel（意图定向搜索）** 和 **VectorGlobalSearchChannel（向量全局搜索）** 两路。

- **意图定向搜索**：只搜意图识别命中的知识库，优点是精准、噪音少
- **向量全局搜索**：搜所有知识库，优点是覆盖全、能兜底

这样设计是为了在 **精准率（precision）** 和 **召回率（recall）** 之间做平衡：
- 只用意图定向：可能漏召回
- 只用全局搜索：噪音太多
- 两路结合：高置信度时偏向精准，中间区间时双通道互补

---

### Q2：意图分数是 0.5 时，两个通道都启用，最终给大模型的 top-K 是怎么来的？

**正确答案：** 不是"两个通道直接按分数合并"，而是分三步：

1. **两个通道并行检索**，各自返回一批候选 chunk
2. **DeduplicationPostProcessor（order=1）先去重**
   - 按通道优先级顺序处理结果
   - 用 `LinkedHashMap` + `chunkId/text.hashCode()` 去重
   - 同一个 chunk 出现多次时保留检索分数更高的版本
3. **RerankPostProcessor（order=10）再重排**
   - 把去重后的所有候选交给百炼重排模型
   - 由 Rerank API 重新打分并截取最终 top-K
   - 如果 `rag.rerank.enabled=false`，该处理器会被跳过，最终结果就是去重后的候选顺序

也就是说，**最终 top-K 不是两个通道原始分数直接排序出来的，而是"双通道召回 → 去重 → 重排"之后的结果。**

**代码位置：**
- 通道并行：`bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/core/retrieve/MultiChannelRetrievalEngine.java`
- 后置处理器链：`bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/core/retrieve/MultiChannelRetrievalEngine.java`

---

### Q3：CompletableFuture 在哪些层级做了并行？为什么要拆成三个线程池？

**正确答案：** 一共三层并行：

| 层级 | 并行内容 | 线程池 |
|------|---------|--------|
| **子问题级** | 多个子问题并行构建上下文 | `ragContextExecutor` |
| **通道级** | 意图通道 / 全局通道并行 | `ragRetrievalExecutor` |
| **集合/意图级** | 多个 collection 或 intent 节点并行检索 | `innerRetrievalExecutor` |

拆成三个线程池不是为了"看起来更清晰"，而是为了 **资源隔离，避免外层任务等待内层任务时发生线程饥饿甚至死锁**。

典型风险：
- 如果三层都共用一个线程池
- 外层子问题任务占住线程后，又 submit 内层通道任务并 `join()` 等待
- 线程池被外层任务占满，内层任务抢不到线程
- 外层一直等内层，内层永远没机会跑，就卡住了

所以多层嵌套并发场景下，**独立线程池是避免互相阻塞的关键设计。**

---

### Q4：项目里实际的线程池参数是怎么配的？为什么这么配？

**正确答案：** 当前项目已经把线程池扩展成多业务域隔离，不再只有 RAG 检索链路的 3 个池。检索链路相关的 3 个池仍然保留，其中 `ragContextExecutor` 和 `ragRetrievalExecutor` 已经按最近提交调整为 `4*CPU/4*CPU`，内层检索池是 `2*CPU/4*CPU`。

`ThreadPoolExecutorConfig.java` 中的真实配置：

| 线程池 | core | max | 队列 | 拒绝策略 |
|--------|------|-----|------|---------|
| `mcpBatchExecutor` | `CPU_COUNT` | `2*CPU_COUNT` | `SynchronousQueue` | `CallerRunsPolicy` |
| `ragContextExecutor` | `4*CPU_COUNT` | `4*CPU_COUNT` | `SynchronousQueue` | `CallerRunsPolicy` |
| `ragRetrievalExecutor` | `4*CPU_COUNT` | `4*CPU_COUNT` | `SynchronousQueue` | `CallerRunsPolicy` |
| `innerRetrievalExecutor` | `2*CPU_COUNT` | `4*CPU_COUNT` | `LinkedBlockingQueue(100)` | `CallerRunsPolicy` |
| `intentClassifyExecutor` | `CPU_COUNT` | `2*CPU_COUNT` | `SynchronousQueue` | `CallerRunsPolicy` |
| `memorySummaryExecutor` | `1` | `max(2, CPU_COUNT/2)` | `LinkedBlockingQueue(200)` | `CallerRunsPolicy` |
| `modelStreamExecutor` | `max(2, CPU_COUNT/2)` | `max(4, CPU_COUNT)` | `LinkedBlockingQueue(200)` | `AbortPolicy` |
| `chatEntryExecutor` | `globalMaxConcurrent` | `globalMaxConcurrent` | `SynchronousQueue` | `AbortPolicy` |
| `knowledgeChunkExecutor` | `max(2, CPU_COUNT/2)` | `max(4, CPU_COUNT)` | `LinkedBlockingQueue(200)` | `AbortPolicy` |
| `memoryLoadExecutor` | `max(2, CPU_COUNT/2)` | `max(4, CPU_COUNT)` | `LinkedBlockingQueue(200)` | `CallerRunsPolicy` |

**为什么这样配：**
- 检索链路大部分是 **I/O 密集型**（向量库查询、Rerank API 调用），不是 CPU 密集型计算
- 通道级任务更像"扇出请求"，希望尽快派发，所以用了 `SynchronousQueue`
- 内层检索 fan-out 数量更多，允许短暂排队，所以用了 `LinkedBlockingQueue(100)`
- `CallerRunsPolicy` 可以在池子打满时回退到调用线程执行，避免直接丢任务
- 流式模型输出、SSE 排队入口、知识库分块这类用户可见或资源敏感任务使用 `AbortPolicy`，让上层明确感知容量不足

**面试要点：**
- CPU 密集型：线程数一般接近 CPU 核数
- I/O 密集型：线程数通常高于 CPU 核数，因为线程大部分时间在等网络/磁盘响应
- 如果用了无界队列，`maxPoolSize` 可能永远不会生效；本项目没有踩这个坑，关键线程池用了 `SynchronousQueue` 或有界队列

**代码位置：** `bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/config/ThreadPoolExecutorConfig.java`

---

### Q5：`CompletableFuture.allOf()` 和 `for` 循环 `future.join()` 有什么区别？项目里为什么选 `join`？

**正确答案：** 这两种写法的并行度本质上没有差别，因为 Future 在 `supplyAsync()` 提交后就已经开始异步执行了。

区别主要在 **异常处理策略**：

- **`allOf()`**：适合"要么全部成功，要么整体失败"的场景
  - 任意一个 Future 异常，`allOf().join()` 就会抛异常
  - 不适合"部分失败也要保留成功结果"的检索场景

- **逐个 `join()` + try-catch**：适合"部分失败可接受"的场景
  - 某一个 collection 检索失败，只记录日志并跳过
  - 其他 collection 的结果照常返回

项目检索链路用的是第二种：

```java
for (RetrievalFuture<T> future : futures) {
    try {
        List<RetrievedChunk> chunks = future.future.join();
        allChunks.addAll(chunks);
    } catch (Exception e) {
        log.error("获取检索结果失败", e);
    }
}
```

因为这里的业务目标不是"全有或全无"，而是 **能返回多少算多少，优先保证可用性。**

补充：项目中 **对话记忆加载** 场景用了 `allOf()`，因为它先把摘要和历史消息各自做了 fallback，异常已经被内部吞掉并转成默认值，所以适合整体汇合；但检索链路本身不是这么处理的。

**代码位置：**
- 检索链路逐个 `join`：`bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/core/retrieve/channel/AbstractParallelRetriever.java`
- 对话记忆 `allOf`：`bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/core/memory/DefaultConversationMemoryService.java`

---

### Q6：如果其中一个通道执行失败了，整个检索流程会怎样？

**正确答案：** 不会中断整个链路。每个通道都被独立 try-catch 包住，失败后返回一个空的 `SearchChannelResult`，后续流程继续。

所以最终效果是：
- **用户通常不会直接看到报错**
- 但可用候选会变少，回答质量可能下降
- 系统侧会打 error/warn 日志，方便排查

这体现的是 **通道级容错**：允许部分失败，不让一条链路的异常拖垮整个检索。

---

### Q7：去重到底是怎么做的？`result` 是什么？为什么一个 `result` 里会有很多个 chunk？

**正确答案：** `result` 指的是一个通道的检索结果对象 `SearchChannelResult`，不是单个 chunk。

一个 `SearchChannelResult` 里会有很多个 chunk，是因为：
- 一个通道内部可能会并行搜索多个目标（多个 collection 或多个 intent 节点）
- 每个目标都会返回若干候选 chunk
- 最后合并成这个通道的一批结果，即 `result.getChunks()`

去重逻辑：
1. 先按通道优先级排序（意图通道优先于全局通道）
2. 遍历每个通道结果里的每个 chunk
3. 用 `chunkId` 或 `text.hashCode()` 生成唯一 key
4. 第一次出现就放入 `LinkedHashMap`
5. 如果重复出现，则比较检索分数，保留分数更高的那个

**举例：**
- 意图通道先处理，`chunk_A` 分数 0.85，先放进 map
- 全局通道后处理，也返回 `chunk_A`，分数 0.92
- 因为 0.92 > 0.85，所以用 0.92 替换 0.85

最终留下的是 **检索分数更高的那个版本**，但这时还没到 Rerank，后面还会再被重排模型重新打分。

**代码位置：** `bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/core/retrieve/postprocessor/DeduplicationPostProcessor.java`

---

### Q8：重排序用的是什么模型？失败后怎么降级？`NoopRerankClient` 到底做了什么？

**正确答案：** 使用的是 **百炼（BaiLian）重排模型**，不是"千问 reranker"这个说法。

调用链路：
- `RerankPostProcessor`
- `RoutingRerankService`
- `BaiLianRerankClient`

如果百炼调用失败，`RoutingRerankService` 会走模型路由降级，落到 **`NoopRerankClient`**。

`NoopRerankClient` 的真实行为不是"换一个模型重排"，而是：
- **什么都不重排**
- 直接保留输入顺序
- 截取前 `topN` 个候选返回

也就是说，降级后 **就没有真正的 rerank 了**，只是把去重后的候选前 top-K 直接拿去给大模型。

这会带来两个影响：
1. **延迟降低**：不再发远程 Rerank API 请求
2. **质量下降**：向量检索分数只能反映语义相似度，未必最能回答问题；没有 rerank 时，更容易把"相关但不能直接回答"的 chunk 排到前面

**代码位置：**
- `infra-ai/src/main/java/com/nageoffer/ai/ragent/infra/rerank/RoutingRerankService.java`
- `infra-ai/src/main/java/com/nageoffer/ai/ragent/infra/rerank/NoopRerankClient.java`

> **面试避雷**：不要说"失败后切换到下一个模型"。更准确的说法是："路由服务会走 fallback，最差降级到 NoopRerankClient，直接截取前 top-K。"

---

### Q9：意图通道为什么是 0.4，全局关闭阈值为什么是 0.6？如果改成 0.3 / 0.8 会怎样？

**正确答案：** 这两个阈值本质上是对意图识别置信度的分层控制：

- **0.4**：最低可信线。低于 0.4，说明意图不够可信，不值得只搜特定知识库
- **0.6**：低置信兜底线。低于 0.6，一定启用全局搜索
- **0.8**：单一意图安全线。只有 1 个意图且分数低于 0.8 时，即使已经超过 0.6，也继续启用全局搜索做补充
- **0.4~0.6**：中间灰度区间，两个通道同时启用，用精准 + 兜底做对冲
- **0.6~0.8 单一意图**：仍然双通道；如果是多个意图，则关闭全局搜索

如果改成：
- **0.4 → 0.3**：更多低可信意图也会触发定向搜索，搜错知识库的概率增大，precision 下降
- **0.6 → 0.8**：全局搜索会更长时间保持开启，双通道区间变大，资源消耗和延迟都上升
- **0.8 → 0.6**：单一意图补充召回基本失效，可能更早关闭全局兜底

面试里可以说这是一个 **召回率 / 精准率 / 延迟成本** 的折中参数。

---

### Q10：5 个 collection 里有 2 个检索超时了，最终返回什么？

**正确答案：** 只返回成功的那 3 个 collection 的结果，失败的 collection 只记日志，不会拖垮整个检索。

原因是内部检索用的是逐个 `join()` + try-catch，失败一个只跳过一个：
- successCount++ 统计成功数
- failureCount++ 统计失败数
- `allChunks` 里只保留成功返回的 chunk

这也是为什么前面强调：**项目追求的是部分成功可用，而不是全有或全无。**

---

### Q11：当前项目底层向量检索到底是 Milvus 还是 PGVector？面试时怎么说才准确？

**正确答案：** 当前代码库里 **Milvus 和 PGVector 两套实现都保留着**，通过配置 `rag.vector.type` 条件装配切换。

但当前 `application.yaml` 的默认配置是：

```yaml
rag:
  vector:
    type: pg
```

所以**当前默认运行的是 PGVector 检索实现**，不是 Milvus。

具体表现：
- `PgRetrieverService` 使用 PostgreSQL + pgvector 的 `<=>` 操作符做相似度检索
- 查询前还会设置 `hnsw.ef_search = 200` 来提升召回率
- Milvus 的实现类仍然保留，说明架构上支持切换，但不是当前默认路径

**面试建议说法：**
- 如果问"项目支持哪些向量库？" → 可以答：支持 Milvus 和 PGVector，采用条件装配切换
- 如果问"你这条链路当前默认跑在哪个向量库上？" → 要答：当前默认是 **PGVector**

**代码位置：**
- 配置：`bootstrap/src/main/resources/application.yaml`
- PG 检索：`bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/core/retrieve/PgRetrieverService.java`
- Milvus 条件装配：`bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/core/retrieve/MilvusRetrieverService.java`

---

### Q12：去重时 fallback key 用 `text.hashCode()`，如果碰撞怎么办？

**正确答案：** 当前代码没有处理哈希碰撞。这是一个真实存在的设计缺陷。

如果两个不同 chunk 的文本恰好 `hashCode()` 一样：
- 它们会被误认为同一个 key
- 后处理的 chunk 可能把前一个覆盖掉
- 导致一个本应保留的 chunk 被错误丢弃

改进方案：
- 用完整文本字符串作 key
- 或使用 MD5 / SHA-256 这种碰撞概率更低的摘要

---

## 六、面试高频追问预判（精简版）

| 问题 | 核心回答要点 |
|------|-------------|
| 双路是哪两路？ | 意图定向搜索（精准）+ 向量全局搜索（兜底） |
| 分数 0.5 时 top-K 怎么来？ | 双通道并行召回 → `Deduplication(order=1)` 去重 → `Rerank(order=10)` 重排 |
| CompletableFuture 怎么用的？ | 三层并行：子问题级、通道级、集合/意图级 |
| 为什么拆三个线程池？ | 资源隔离，避免外层 `join()` 等待内层任务时线程饥饿/死锁 |
| 实际线程池怎么配？ | 当前有 10 个业务线程池；RAG 检索核心三层是 context: 4CPU/4CPU、retrieval: 4CPU/4CPU、inner: 2CPU/4CPU |
| `allOf` 和逐个 `join` 的区别？ | `allOf` 适合全成功场景；逐个 `join` 更适合部分失败也要保留成功结果 |
| 一个通道失败了怎么办？ | 返回空 `SearchChannelResult`，打日志，不中断其他通道 |
| 去重怎么做？ | `LinkedHashMap` + `chunkId/hashCode`，按通道优先级遍历，重复时保留更高检索分 |
| 重排序用什么模型？ | 百炼重排模型 API |
| 失败后怎么降级？ | `RoutingRerankService` fallback 到 `NoopRerankClient`，直接截前 top-K |
| 当前默认向量库是什么？ | 默认是 **PGVector**，Milvus 实现仍保留，可通过配置切换 |
| 阈值 0.4 / 0.6 / 0.8 的意义？ | 0.4 是定向检索最低线，0.6 是全局低置信兜底线，0.8 是单一意图补充召回线 |
| hashCode 碰撞怎么办？ | 当前未处理，是设计缺陷 |

---

## 七、设计亮点

| 设计点 | 说明 |
|--------|------|
| **三层并行架构** | 子问题级、通道级、集合/意图级逐层拆分，并发粒度清晰 |
| **线程池资源隔离** | 不同层级独立线程池，避免嵌套并发时互相阻塞 |
| **通道非互斥设计** | 意图中间置信区间同时启用双通道，兼顾精准与兜底 |
| **通道级容错** | 单个通道失败返回空结果，不中断整体链路 |
| **集合级容错** | 单个 collection 检索失败不影响其他 collection |
| **优先级 + 分数双维去重** | 先按通道优先级遍历，再在重复时保留更高检索分 |
| **后置处理器链** | 通过 `order` 保证先去重再重排，职责清晰 |
| **重排降级策略** | 百炼失败后 fallback 到 Noop，保证链路可用 |
| **向量库可插拔** | 支持 PGVector / Milvus 条件切换，当前默认走 PG |

## 八、设计缺陷与改进空间

| 缺陷 | 说明 | 改进建议 |
|------|------|---------|
| **哈希碰撞未处理** | `hashCode()` 可能误判不同 chunk 为同一个 | 用完整文本或 MD5/SHA256 作为 fallback key |
| **Rerank API 无分批** | 候选过多时一次性请求可能触发上游限制 | 做候选上限控制或分批重排 |
| **无检索结果缓存** | 相同问题重复检索浪费向量查询与 Rerank 成本 | 引入 Redis 缓存高频 query 的检索结果 |
| **Noop 降级会牺牲精度** | fallback 后只截前 top-K，无法做真正重排 | 本地轻量级 rerank 模型做二级降级 |
| **参数依赖经验调优** | 0.4/0.6 阈值、topK 倍数需要持续校准 | 用离线评测集和线上日志持续调优 |
