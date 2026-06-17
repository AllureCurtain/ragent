# 简历亮点四：大模型前置上下文补全与长句拆解

## 一、简历原文

> 设计检索前查询理解层，结合术语归一化、上下文补全与长句拆解，将多轮口语问题改写为可检索查询，解决指代消解与复合问句导致的召回偏差

## 二、业务背景

用户在多轮对话里经常出现两类输入问题，会直接拉低向量检索命中率：

1. **指代消解缺失**：用户说"它的数据库用什么？"，但检索系统并不知道"它"到底指哪一个系统，召回结果会很差
2. **复合问句**：用户一次问多个问题，比如"12306 的订单流程是什么？支付环节怎么处理？"，如果整句直接做向量检索，embedding 会被多个主题稀释，很难稳定命中核心内容

因此，系统在检索前增加了一层**问题理解与整理**：
- **上下文补全**：结合最近对话历史，把"它"还原成"12306 系统"
- **长句拆解**：把一句复合问题拆成多个独立问题，分别检索后再合并结果

## 三、整体流程

```
用户提问："它的支付流程和退款规则是什么？"
  │
  ▼
[Step 0] 加载对话历史
  │  memoryService.loadAndAppend()
  │  取出最近的摘要 + 滑动窗口历史（来自对话记忆模块）
  │
  ▼
[Step 1] 术语归一化（规则前置）
  │  queryTermMappingService.normalize()
  │  数据库驱动的子串替换：如 "OA 系统" → "协同办公系统"
  │  无需调用大模型，毫秒级完成
  │
  ▼
[Step 2] 大模型改写 + 拆分（LLM 前置）
  │  callLLMRewriteAndSplit()
  │  输入：系统提示词 + 最近 1 到 2 轮对话历史（按原始 history.size() 做 4 条窗口裁剪） + 当前问题
  │  输出：JSON { "rewrite": "...", "sub_questions": [...] }
  │
  │  示例输出：
  │  {
  │    "rewrite": "12306系统的支付流程和退款规则",
  │    "sub_questions": [
  │      "12306系统的支付流程是什么",
  │      "12306系统的退款规则是什么"
  │    ]
  │  }
  │
  ▼
[Step 3] 每个子问题独立做意图识别（并行）
  │  IntentResolver.resolve()
  │  CompletableFuture 并行：每个子问题 → 意图分类 → SubQuestionIntent
  │  目标总意图数上限 3；当子问题数不超过 3 时，每个有命中的子问题保底 1 个意图
  │
  ▼
[Step 4] 每个子问题独立做多通道检索（并行）
  │  RetrievalEngine.retrieve()
  │  每个子问题走双路召回 → 去重 → 重排序（详见亮点一）
  │
  ▼
[Step 5] 合并所有子问题的检索结果
  │  按子问题编号组织：
  │  ---
  │  **子问题**：12306系统的支付流程是什么
  │  **相关文档**：[检索到的 chunk]
  │  ---
  │  **子问题**：12306系统的退款规则是什么
  │  **相关文档**：[检索到的 chunk]
  │
  ▼
[Step 6] 最终 Prompt 组装
  │  RAGPromptService.buildStructuredMessages()
  │  消息顺序：system prompt → history（含摘要）→ 证据 + 问题
  │  证据和问题合并成同一条 user message：
  │  <documents>...</documents>
  │
  │  <questions>
  │  1. 12306系统的支付流程是什么
  │  2. 12306系统的退款规则是什么
  │  </questions>
  │
  ▼
大模型流式生成回答
```

## 四、核心设计

### 4.1 术语归一化（QueryTermMappingService）

`QueryTermMappingService.java`

**作用：** 在调用大模型之前，先做数据库驱动的术语替换，解决业务别名问题。

**加载方式：** 每次 `normalize()` 调用时通过 `loadMappings()` 获取规则；优先读取 Redis 缓存，缓存未命中再从 `t_query_term_mapping` 表查询启用规则并回填 Redis。

**缓存策略：**
- 缓存 Key：`ragent:query-term:mappings`
- 过期时间：7 天
- Redis 读取失败时返回 `null`，降级查数据库
- 数据库查询只加载 `enabled = 1` 的规则，排序后写回缓存

**排序策略：**
1. 优先级降序（priority 高的先执行）
2. 源词长度降序（长词优先，避免短词碰撞：如先替换"协同办公系统"，再替换"办公"）

**防重复替换：** `QueryTermMappingUtil.applyMapping()` 从左到右扫描，匹配时检查目标位置是否已经是目标词——如果是则跳过，避免"OA → 协同办公系统 → 协同协同办公系统系统"的双重替换。

**管理入口：** `QueryTermMappingAdminServiceImpl` 提供 CRUD，每次增删改后调用 `QueryTermMappingCacheManager.clearCache()` 清 Redis 缓存；下一次查询再从数据库加载并回填，而不是在后台立即 reload 到本地内存。

### 4.2 大模型改写与拆分（MultiQuestionRewriteService）

`MultiQuestionRewriteService.java`

**三阶段处理：**

```java
// 阶段 1：开关检查
if (!ragConfigProperties.getQueryRewriteEnabled()) {
    String normalized = queryTermMappingService.normalize(userQuestion);
    List<String> subs = ruleBasedSplit(normalized);  // 正则兜底拆分
    return new RewriteResult(normalized, subs);
}

// 阶段 2：术语归一化
String normalizedQuestion = queryTermMappingService.normalize(userQuestion);

// 阶段 3：LLM 改写 + 拆分
return callLLMRewriteAndSplit(normalizedQuestion, userQuestion, history);
```

**对话历史裁剪方式：**

```java
// 过滤 USER/ASSISTANT 后，再按原始 history.size() 计算 skip，目标是保留最近 1-2 轮对话
// 如果 history 里包含 SYSTEM 摘要，实际保留的 USER/ASSISTANT 可能少于 4 条
List<ChatMessage> recentHistory = history.stream()
        .filter(msg -> msg.getRole() == ChatMessage.Role.USER
                || msg.getRole() == ChatMessage.Role.ASSISTANT)
        .skip(Math.max(0, history.size() - 4))
        .toList();
```

**LLM 请求参数：**

| 参数 | 值 | 为什么 |
|------|-----|--------|
| temperature | 0.1 | 极低，保证改写确定性，不引入创造性内容 |
| topP | 0.3 | 极低，限制采样范围 |
| thinking | false | 不需要推理过程，节省 token |

**输出解析：**

1. `LLMResponseCleaner.stripMarkdownCodeFence()` 去除 ` ```json ... ``` ` 包裹
2. 解析 JSON：提取 `rewrite` 和 `sub_questions`
3. `rewrite` 为空 → 返回 null → 触发兜底
4. `sub_questions` 为空 → 默认为 `[rewrite]`（不拆分）

### 4.3 三级降级策略

```
LLM 调用成功 + 解析成功
  → 使用 LLM 返回的 rewrite 和 sub_questions
  │
  ├── LLM 调用抛异常
  │     → 使用归一化后的问题兜底
  │
  ├── LLM 返回但 JSON 解析失败
  │     → 使用归一化后的问题兜底
  │
  └── 功能开关关闭
        → 术语归一化 + 正则拆分（按 ?？。；;\n 分割）
```

**兜底逻辑：**

```java
try {
    String raw = llmService.chat(req);
    RewriteResult parsed = parseRewriteAndSplit(raw);
    if (parsed != null) {
        return parsed;
    }
    log.warn("查询改写+拆分解析失败，使用归一化问题兜底");
} catch (Exception e) {
    log.warn("查询改写+拆分 LLM 调用失败，使用归一化问题兜底");
}
return new RewriteResult(normalizedQuestion, List.of(normalizedQuestion));
```

### 4.4 Prompt 模板设计要点

`prompt/user-question-rewrite.st`

> 这是给改写模型使用的**提示词模板文件**，不是普通配置文件。`PromptTemplateLoader` 会先加载这份模板，再由 `MultiQuestionRewriteService` 组装历史消息和当前问题，一起发给模型。

| 规则类别 | 具体内容 |
|---------|---------|
| **保留** | 专有名词（系统名、产品名）、关键限制（时间范围、环境） |
| **删除** | 礼貌用语（"请帮我"）、回答指令（"详细说明"）、无关描述（"我是新人"） |
| **禁止** | 添加原文没有的条件、修改专有名词、引入枚举词 |
| **指代消解** | 结合对话历史还原"它"、"这个"为具体实体 |
| **拆分标准** | 多个问号、显式列举、分号/换行 → 拆分 |
| **不拆分** | 抽象对比（"A 和 B 的区别"）、笼统询问 → 不拆 |

### 4.5 子问题如何进入后续检索链路

**意图识别并行化（IntentResolver.resolve）：**

```java
List<CompletableFuture<SubQuestionIntent>> tasks = subQuestions.stream()
    .map(q -> CompletableFuture.supplyAsync(
        () -> new SubQuestionIntent(q, classifyIntents(q)),
        intentClassifyExecutor
    ))
    .toList();
```

**意图数上限管理（capTotalIntents）：**
- 目标是把总意图数控制在 3 个以内（`MAX_INTENT_COUNT = 3`）
- 当子问题数不超过 3 时，保证每个有命中的子问题至少保留 1 个最高分意图
- 剩余名额按全局分数排名分配
- 当前实现的边界是：如果子问题数超过 3，保底策略会优先覆盖每个子问题，实际保留数可能超过 3

**最终 Prompt 编号策略（RAGPromptService）：**

```java
private String buildUserQuestion(String question, List<String> subQuestions) {
    if (CollUtil.isNotEmpty(subQuestions) && subQuestions.size() > 1) {
        String numbered = IntStream.range(0, subQuestions.size())
                .mapToObj(i -> (i + 1) + ". " + subQuestions.get(i))
                .collect(Collectors.joining("\n"));
        return renderSection("multi-questions", Map.of("questions", numbered));
    }
    if (StrUtil.isBlank(question)) {
        return "";
    }
    return renderSection("single-question", Map.of("question", question));
}
```

`context-format.st` 中对应的 section 是：

```text
--- section: single-question ---
<question>{question}</question>

--- section: multi-questions ---
<questions>
{questions}
</questions>
```

最终 user message 不是只放问题，而是把 `buildEvidenceBody()` 生成的 KB/MCP 证据和 `buildUserQuestion()` 生成的问题合并。KB 证据包在 `<documents>` 里，MCP 结果包在 `<tool-data>` 里，问题包在 `<question>` 或 `<questions>` 里。

---

## 五、面试题（架构设计版）

> 这一组题只围绕**整体设计、方案取舍、失败兜底和系统边界**来问，不展开到具体方法实现细节。

### Q1：为什么要在检索前增加一层“上下文补全 + 长句拆解”，而不是直接拿用户原问题去做检索？

**标准回答：**

因为检索阶段要解决的是**先把证据找准**，而不是等到大模型回答时再去“理解用户到底想问什么”。

如果用户问题本身带有指代、省略和多主题混合这些特征，检索在一开始就会偏掉。后面的生成模型即使很强，也只是基于偏掉的证据继续回答。

这套设计主要解决两类问题：

1. **指代问题**：像“它”“这个”“那边那个流程”这类说法，对人类来说依赖上下文就能理解，但对检索系统来说语义不完整。
2. **复合问句问题**：一句话里同时问多个主题时，query 的语义中心会被稀释，检索结果容易每个方向都不够准。

代码里这件事是有完整落地的，不只是概念：

- `RAGChatServiceImpl` 负责排队、trace 和任务入口，真正的流水线在 `StreamChatPipeline`
- `StreamChatPipeline.loadMemory()` 先加载历史，再进入改写链路
- `MultiQuestionRewriteService` 会把最近 1 到 2 轮 `USER/ASSISTANT` 历史和当前问题一起发给模型
- 模型输出 `rewrite` 和 `sub_questions`
- 后续再让每个子问题分别进入意图识别和检索

**具体示例：**

历史对话：
- 用户：`12306系统的架构是什么？`

当前问题：
- 用户：`它的数据库用什么？支付流程呢？`

如果直接拿这句话做检索，会有两个问题：

1. `它` 没有实体指向
2. `数据库` 和 `支付流程` 是两个主题，混在一起会影响召回精度

更理想的前置处理结果是：

```json
{
  "rewrite": "12306系统的数据库和支付流程",
  "sub_questions": [
    "12306系统的数据库用什么",
    "12306系统的支付流程是什么"
  ]
}
```

这样后续检索拿到的证据会稳定得多。

### Q2：这套前置处理链路整体是怎么设计的？规则归一化、LLM 改写、多子问题分发分别承担什么职责？

**标准回答：**

这套链路可以按三层来理解：

1. **规则归一化层**
2. **LLM 改写层**
3. **多子问题分发层**

它们不是重复设计，而是分别处理不同类型的问题。

**第一层：规则归一化**

这层解决的是**业务叫法不统一**的问题。  
比如业务里有人说 `OA`，文档里写的是 `协同办公系统`，如果不先统一，检索命中会不稳定。

这一层对应 `QueryTermMappingService.normalize()`，底层规则来自 `t_query_term_mapping` 表，但当前实现不是启动时一次性加载到本地内存，而是优先读 Redis 缓存；缓存未命中时查数据库、按优先级和词长排序，再回填 Redis。

**第二层：LLM 改写**

这层解决的是**自然语言不适合直接检索**的问题。  
比如礼貌用语、口语化表达、指代、省略、复合问法，这些都不是规则替换能完全解决的，所以要交给模型做语义整理。

这里用的模板就是 `prompt/user-question-rewrite.st`，它规定了：

- 什么内容要保留
- 什么内容要删除
- 什么时候拆分
- 指代词如何结合历史还原

**第三层：多子问题分发**

如果一个问题被拆成多个子问题，系统不会再把它们揉回一条 query，而是让每个子问题独立进入后续链路：

- 各自做意图识别
- 各自做检索
- 最后再按子问题编号渲染到 `context-format.st` 的 `<questions>` section 中，并和证据合并为一条 user message

所以第四点更像是一个**检索前的 query 理解层**，而第一点是后面的**实际召回与重排层**。两者是串联关系，不是同一层。

**具体示例：**

用户问题：
- `OA系统在移动端的审批流程是什么？消息提醒机制又是怎么做的？`

这条问题经过三层后可以理解成：

1. 规则归一化：把 `OA系统` 统一到系统内部标准叫法
2. LLM 改写：去掉无关表述，保留 `移动端` 这个限制条件
3. 子问题分发：
   - `移动端审批流程是什么`
   - `消息提醒机制怎么做`

然后这两个子问题再分别进入意图识别和检索。

**延伸追问：**

如果面试官继续问“那意图识别和检索怎么做”，就可以自然转到亮点一去讲，因为第四点的输出正是亮点一的输入。

### Q3：为什么这里采用“规则前置 + LLM 增强”的组合方案，而不是全交给规则或全交给 LLM？

**标准回答：**

因为这两类能力擅长解决的问题不同：

- **规则**擅长处理高确定性问题
- **LLM**擅长处理高语义复杂度问题

如果全靠规则，优点是快、稳、可控，但它只能覆盖“已知模式”。  
如果全靠 LLM，理解能力强，但成本更高，也更容易出现输出不稳定、专有名词改写过度的问题。

所以当前项目采用的是“规则前置 + LLM 增强”的组合：

1. 先用规则做术语归一化
2. 再把归一化后的问题和历史一起交给模型做语义改写
3. 如果模型失败，再退回归一化结果

这里最容易混淆的一点是：

> `normalize` 不是基于历史做的，它只是**术语归一化**；  
> 基于历史的上下文补全，是后面的 LLM 改写在做。

也就是说：

- `normalize` 解决的是：`OA` 和 `协同办公系统` 是不是同一个东西
- 历史 + LLM 解决的是：`它` 指的是不是上一轮提到的 `12306系统`

**当前项目中的规则具体是什么：**

- 存在数据库表 `t_query_term_mapping`
- 每条规则就是一组 `sourceTerm -> targetTerm`
- 例如：`OA -> 协同办公系统`
- 规则支持启用/禁用、优先级、后台管理

所以这里的“规则”本质上就是**业务别名映射规则**。

**具体示例：**

用户问题：
- `OA那边这个流程在移动端怎么走？`

系统大致会这样处理：

1. 规则归一化：把 `OA` 统一成标准系统名称
2. LLM 改写：再结合历史判断 `这个流程` 到底指审批流程还是报销流程

如果只靠规则：
- `这个流程` 这种口语化表达很难处理

如果只靠 LLM：
- `OA` 这种业务简称可能被模型换成别的表述，检索稳定性反而变差

所以两层组合更稳。

### Q4：一个问题被拆成多个子问题后，系统如何平衡**检索效果、整体延迟和最终回答完整性**？

**标准回答：**

拆分的目标不是“拆得越多越好”，而是在下面三件事之间找平衡：

1. **检索效果**
2. **整体延迟**
3. **最终回答完整性**

先说检索效果。  
拆分以后，每个子问题都是单主题 query，检索目标会更清晰，证据更容易命中。

但如果过度拆分，也会带来两个问题：

1. 意图识别和检索次数增多，整体延迟会上升
2. 最终上下文变大，模型更容易漏答、重复答或者答得发散

当前系统主要通过四个手段做平衡：

**第一，拆分本身有约束，不是随便拆。**

`user-question-rewrite.st` 里明确规定：

- 多个问号、显式列举、分号/换行时才拆
- 抽象对比题、笼统问题不拆

所以它不是“长句必拆”，而是“只有明确多主题才拆”。

**第二，拆分后走并行，而不是串行。**

子问题的意图识别是并行的，检索构建也是并行的，所以不会因为问题拆成两个就让总耗时直接翻倍。

**第三，总意图数有限流。**

系统目标是把总意图数控制在 `MAX_INTENT_COUNT = 3`，并且在子问题数不超过 3 时保证每个有命中的子问题至少保留 1 个最高分意图，剩余名额再按全局分数分配。  
需要注意一个实现边界：如果 LLM 拆出超过 3 个子问题，当前 `capTotalIntents()` 会优先做“每题保底”，实际总意图数可能超过 3。面试或复盘时不要把它描述成绝对强约束。

**第四，最终问题区显式编号，保证完整性。**

最后 `RAGPromptService` 会把多个子问题按 `1. 2. 3.` 编号渲染到 `<questions>` 区块里，再和 `<documents>` / `<tool-data>` 证据一起写进用户消息，目的是降低模型漏答某一问的概率。

**具体示例：**

用户问题：
- `12306的订单流程是什么？支付环节怎么处理？退款规则又是什么？`

如果不拆：
- 一条 query 混着三个主题
- 检索很容易失焦

如果过度拆：
- 又把 `支付环节` 拆成 `支付方式`、`支付回调`、`失败补偿`
- 检索次数和上下文长度都会明显上升

当前这套设计更像一个折中方案：

- 先拆到“足以提高检索清晰度”的粒度
- 后续并行执行
- 用总意图上限控制成本
- 最后按编号组织回答，保证三个问题都能覆盖

### Q5：如果改写结果不稳定、LLM 调用失败，或者输出不符合预期，系统怎么保证主检索链路仍然可用？

**标准回答：**

这里最核心的设计原则是：

> **改写层是增强层，不是单点依赖。**

也就是说，这一层失败了，系统效果会下降，但主链路不能直接断。

当前实现里至少有三层保护：

**第一层：功能开关关闭时，主链路照常可用。**

如果 `queryRewriteEnabled` 关闭，系统直接走：

- 术语归一化
- 规则拆分

不会因为模型不可用而整条链路停掉。

**第二层：LLM 调用失败时，退回归一化结果。**

如果调用模型时报错，系统直接返回：

- `rewrittenQuestion = normalizedQuestion`
- `subQuestions = [normalizedQuestion]`

也就是“不增强，但继续检索”。

**第三层：模型输出脏格式或非法 JSON，也退回归一化结果。**

系统会先去掉 markdown code fence，再尝试解析 JSON。  
如果解析失败，或者 `rewrite` 为空，也一样走兜底，不会直接抛错。

所以这条链路不是“改写必须成功”，而是“改写成功就提升效果，失败就回退到基础路径”。

**具体示例：**

用户问题：
- `它的数据库和支付流程呢？`

正常情况下，模型会结合历史把它改写成更完整的问题。

但如果这次 LLM 超时了，系统也不会报错退出，而是继续使用归一化后的原问题去检索。

这时会发生什么：

- 回答质量可能下降
- 因为 `它` 可能没被成功还原
- 多问句也可能没被成功拆开

但整条 RAG 主链路仍然可用。

### Q6：这套方案的主要收益和边界在哪里？什么场景下值得做，什么场景下收益可能不高？

**标准回答：**

这套方案最核心的收益，不是“把问题改写得更好看”，而是：

1. **提升检索命中率**
2. **降低多轮对话里的语义偏差**
3. **让最终回答更完整**

它尤其适合下面这类场景：

- 用户是多轮对话，不是一次性提问
- 用户经常用自然语言、口语化表达
- 知识库文档本身偏书面化、结构化
- 企业内部有很多简称、别名、业务黑话
- 用户一次提多个问题很常见

在这种场景下，聊天表达和文档表达之间存在明显语义落差，所以检索前加一层 query 理解是很有价值的。

但它也不是任何项目都值得上，因为它的代价也很明确：

- 多了一次模型调用
- 增加了解析和降级逻辑
- 复杂度更高
- 如果历史理解错了，也可能把检索带偏

所以在这些场景里，收益可能就没那么高：

- 用户问题本来就很短、很标准
- 大多数都是单轮、单主题问题
- FAQ 场景为主，不是自然对话
- 系统极度敏感于延迟，不希望检索前再加一次模型调用

**具体示例：**

如果用户平时经常问：

- `报销流程`
- `请假审批节点`
- `退款规则`

这类问题本身已经很适合直接检索，再加一层 LLM 改写，收益就未必明显。

但如果用户经常问的是：

- `OA那边这个流程在移动端怎么走？消息提醒是不是也不一样？`

这种问题带简称、带上下文、带多个子主题，就很适合这套设计。

---
