# ragenteval 评测项目使用指南

## 1. 项目定位

`ragenteval` 是 Ragent 的评测侧仓库，位于主项目根目录下的 `ragenteval/`。它不包含 Java 后端代码，也不是一个需要常驻运行的服务，而是一套 Python 命令行工具和评测资产，用来做 RAG 客服助手的离线回归评测。

它主要负责四件事：

- 维护「比特严选」客服场景的评估集。
- 维护用于灌入 Ragent 的 Markdown 知识库。
- 调用 Ragent 的真实对话接口和评测旁路接口，录制每条样本的回答、召回证据、意图预测和延迟。
- 计算指标并输出 Markdown、CSV、JSONL、HTML slides 报告。

核心代码入口：

- `ragenteval/eval/common/schemas.py`：评测数据模型。
- `ragenteval/eval/common/cli.py`：CLI 入口。
- `ragenteval/eval/rag/pipeline/runner.py`：调用 Ragent 并生成 runs。
- `ragenteval/eval/rag/pipeline/score.py`：指标计算编排。
- `ragenteval/eval/rag/report/`：报告、A/B diff、HTML slides。
- `ragenteval/eval/rag/init/`：初始化 Ragent 知识库和意图树。

## 2. 与 Ragent 的关系

一次完整评测会同时使用两个 Ragent 接口：

```text
GET /api/ragent/rag/v3/chat
    真实 SSE 对话链路，用于拿最终回答、thinking、首字延迟和总耗时。

GET /api/ragent/rag/eval
    评测旁路 JSON 接口，用于拿召回文档、chunk、上下文、意图叶子节点等检索证据。
```

Ragent 侧对应实现：

- `bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/eval/EvalController.java`
- `bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/eval/EvalResponse.java`
- `bootstrap/src/main/resources/application.yaml`

`/rag/eval` 受配置控制：

```yaml
app:
  eval:
    enabled: true
```

本地评测可以开启；生产环境应关闭，避免暴露评测旁路。

## 3. 数据与产物

当前仓库里的主要资产：

```text
ragenteval/
├── eval/rag/dataset/
│   ├── eval_set_v1.jsonl       # 当前默认评估集，20 条
│   └── eval_set_v1_all.jsonl   # 全量评估集，150 条
├── knowledge_base/             # 115 篇 Markdown 知识库文档
├── examples/
│   ├── runs/                   # 示例录制结果
│   └── reports/                # 示例报告
└── eval/agent/                 # Agent 评测预留目录，目前为空实现
```

运行时会生成这些本地文件，均不应提交：

```text
ragenteval/eval/runs/v1_<timestamp>.jsonl
ragenteval/eval/reports/<run_name>/
ragenteval/eval/rag/init/kb_ids.json
ragenteval/eval/rag/init/intent_ids.json
ragenteval/eval/rag/dataset/doc_id_map.json
```

其中 `doc_id_map.json` 很关键：它保存「业务文档 ID -> Ragent 内部文档 ID」的映射。换数据库、重建知识库或重新上传文档后，这个文件必须重新生成。

## 4. 环境准备

先启动 Ragent 后端，并保证数据库、Redis、向量库、对象存储等本地依赖可用。

Windows PowerShell 示例：

```powershell
# 在 ragent 根目录启动后端
.\mvnw.cmd -pl bootstrap spring-boot:run
```

进入评测仓库：

```powershell
cd .\ragenteval
```

建议使用 Python 3.11。当前仓库还没有 `requirements.txt` 或 `pyproject.toml`，需要手动安装依赖：

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1

# 只跑自建指标和初始化脚本，requests 即可
pip install requests

# 如需跑 RAGAS LLM-as-judge，再安装这些
pip install ragas langchain-openai datasets pandas
```

设置 Ragent 账号和地址：

```powershell
$env:RAGENT_BASE_URL="http://localhost:9090/api/ragent"
$env:RAGENT_USERNAME="admin"
$env:RAGENT_PASSWORD="admin"
```

如需跑 RAGAS：

```powershell
$env:AIHUBMIX_API_KEY="<your_api_key>"
$env:JUDGE_MODEL="gpt-5.4-mini"
$env:EMBEDDING_MODEL="text-embedding-3-large"
```

## 5. 初始化 Ragent 评测数据

第一次使用时，需要把 `ragenteval/knowledge_base` 里的文档和意图树灌入 Ragent。

### 5.1 创建 4 个知识库

```powershell
python eval/rag/init/create_kbs.py
```

脚本会创建：

- 比特严选-商品库
- 比特严选-使用手册库
- 比特严选-政策库
- 比特严选-FAQ库

成功后会写入：

```text
eval/rag/init/kb_ids.json
```

注意：该脚本不做服务端幂等，重复执行会创建同名知识库。

### 5.2 上传 115 篇 Markdown 文档

先 dry-run 看文件分布：

```powershell
python eval/rag/init/upload_docs.py --dry-run
```

冒烟上传前 3 篇：

```powershell
python eval/rag/init/upload_docs.py --limit 3
```

全量上传：

```powershell
python eval/rag/init/upload_docs.py --sleep 0.2
```

上传后会增量写入：

```text
eval/rag/dataset/doc_id_map.json
```

文档分块和入向量库是异步的。全量上传后建议等几分钟，再到 Ragent 的知识库管理页或接口确认每个文档 `chunkCount > 0`。

### 5.3 构建意图树

先看将要创建的节点：

```powershell
python eval/rag/init/build_intent_tree.py --dry-run
```

确认后执行：

```powershell
python eval/rag/init/build_intent_tree.py
```

成功后会写入：

```text
eval/rag/init/intent_ids.json
```

注意：当前脚本读取的是 `eval/rag/dataset/eval_set_v1.jsonl`。该文件目前是 20 条默认样本，不是 150 条全量样本。若要按全量评估集生成完整意图样例和 KB 投票，需要先调整脚本的数据集路径，或把默认集切换为全量集。

### 5.4 重置知识库

查看将删除什么：

```powershell
python eval/rag/init/reset_kbs.py
```

确认删除：

```powershell
python eval/rag/init/reset_kbs.py --yes
```

该操作会删除 Ragent 侧知识库、文档，并默认清理本地 `kb_ids.json`、`doc_id_map.json`。

## 6. 跑评测

### 6.1 一键冒烟

只跑 5 条，并跳过 RAGAS：

```powershell
python -m eval rag all --limit 5 --skip-ragas
```

这会执行：

```text
run -> score -> report
```

### 6.2 只录制 Ragent 输出

```powershell
python -m eval rag run --limit 20
```

常用调试参数：

```powershell
# 从第 10 条开始跑 5 条
python -m eval rag run --start 10 --limit 5

# 只跑某个二级意图
python -m eval rag run --filter-intent S1_选购推荐

# 并发跑，注意不要超过 Ragent 本地限流
python -m eval rag run --limit 20 -w 3

# 保留原始 SSE 字节流，排查流式解析问题
python -m eval rag run --limit 1 --debug
```

录制产物：

```text
eval/runs/v1_<timestamp>.jsonl
```

每一行是一条 `EvalRecord`，包含用户问题、参考答案、Ragent 回答、召回文档、chunk、意图预测和延迟。

### 6.3 只评分

基于最新 runs 文件评分：

```powershell
python -m eval rag score --skip-ragas
```

指定某个 runs 文件：

```powershell
python -m eval rag score eval/runs/v1_20260524_162111.jsonl --skip-ragas
```

开启 RAGAS：

```powershell
python -m eval rag score --ragas-limit 10
```

多次 RAGAS 取均值，降低 judge 方差：

```powershell
python -m eval rag score --ragas-limit 10 --ragas-n 3
```

评分产物：

```text
eval/reports/<run_name>/_scores.json
```

### 6.4 生成报告

```powershell
python -m eval rag report
```

指定主题：

```powershell
python -m eval rag report --theme swiss
python -m eval rag report --theme magazine
```

只重出 HTML slides：

```powershell
python -m eval rag report --only-slides
```

报告产物：

```text
eval/reports/<run_name>/report.md
eval/reports/<run_name>/per_sample.csv
eval/reports/<run_name>/failures.jsonl
eval/reports/<run_name>/slides.html
```

## 7. A/B 对比

两次评测跑完后，可以比较 `_scores.json`：

```powershell
python -m eval rag diff v1_20260524_162111 v1_20260525_101530
```

同时输出 Markdown：

```powershell
python -m eval rag diff v1_base v1_candidate -o reports/diff.md
```

diff 会按指标阈值标记明显退化项，例如 Hit@5、Recall@5、answer_correctness、TTFT P95 等。

## 8. 指标怎么看

自建指标：

- `intent_top1`：Ragent 预测的 top-1 意图是否等于评估集标注的 `intent_l2`。
- `hit@K`：Top-K 召回文档中是否至少命中一个 must 文档。
- `recall@K`：Top-K 召回覆盖了多少 must 文档。
- `recall_inclusive@K`：把 `expected_doc_ids_nice` 也纳入期望集合。
- `mrr@10`：第一个命中文档的排名质量。
- `refusal_when_required`：`requires_rag=true` 但没有召回文档。
- `fallback_when_required`：`requires_rag=true` 但回答里出现知识库兜底话术。
- `over_retrieval_rate`：`requires_rag=false` 但仍走了 KB 召回。
- `ttft_p95_ms`：首个正式回答 token 的 P95 延迟，不包含 thinking token。

RAGAS 指标：

- `faithfulness`：回答是否忠实于召回上下文。
- `answer_relevancy`：回答是否切题。
- `answer_correctness`：回答与参考答案的事实一致性。
- `context_precision`：召回上下文中有用信息比例。
- `context_recall`：召回上下文是否覆盖参考答案所需信息。

优先看这些上线相关指标：

```text
intent_top1
hit@5
recall@5
mrr@10
faithfulness
answer_correctness
context_precision
context_recall
refusal_when_required
over_retrieval_rate
ttft_p95_ms
```

## 9. 人工复核

`per_sample.csv` 会把每条样本的指标横向展开。如果跑了 RAGAS，报告逻辑支持人工复核列：

```text
faithfulness_manual
answer_relevancy_manual
answer_correctness_manual
context_precision_manual
context_recall_manual
```

在这些列里填 `0-1` 或 `0-100` 的人工分后，再执行：

```powershell
python -m eval rag report
```

报告会按「人工列优先，空值回退 RAGAS」的口径重新计算。

## 10. 已知限制

当前实现有几个需要注意的点：

1. 答案和检索证据不是同一次请求产生的。`/rag/v3/chat` 负责生成答案，`/rag/eval` 再单独跑一次检索拿证据。一般结果接近，但严格来说不同源。
2. `/rag/eval` 是评测旁路，手工组合 query rewrite、intent resolver 和 retrieval engine，不完全等同生产 `StreamChatPipeline`。后续如果生产链路新增过滤、重排、上下文压缩等逻辑，需要同步检查评测旁路。
3. 默认评估集是 20 条，全量 150 条文件尚未通过 CLI 参数直接切换。
4. `eval/agent/` 只是预留目录，当前不评 Tool Calling 准确率。
5. 仓库缺少依赖清单和自动化测试。建议后续补 `pyproject.toml`、SSE parser 测试、metrics 测试和示例报告生成测试。

## 11. 常见问题

### `No module named eval`

确认命令是在 `ragenteval/` 根目录执行：

```powershell
cd .\ragenteval
python -m eval rag run --limit 5
```

也可以直接调用：

```powershell
python eval/common/cli.py rag run --limit 5
```

### 找不到 `doc_id_map.json`

先执行文档上传：

```powershell
python eval/rag/init/upload_docs.py
```

如果换了数据库或重新建了知识库，也需要重新上传并生成新的 `doc_id_map.json`。

### RAGAS 被跳过

通常是缺少依赖或缺少 `AIHUBMIX_API_KEY`。只看自建指标时使用：

```powershell
python -m eval rag score --skip-ragas
```

需要 RAGAS 时安装依赖并设置 API key。

### 指标异常高或异常低

优先检查：

- Ragent 是否启用了正确的意图树和知识库。
- 文档是否已经完成 chunk 入库。
- `doc_id_map.json` 是否对应当前数据库。
- `retrievedContextDocIds` 与 `retrieved_contexts` frontmatter 是否一致。
- `ground_truth` 是否是自然语言参考答案，而不是元指令。

## 12. 推荐使用方式

日常开发建议：

```powershell
# 1. 快速检查链路
python -m eval rag all --limit 5 --skip-ragas

# 2. 改了检索、意图、prompt 后跑默认 20 条
python -m eval rag all --limit 20 --skip-ragas

# 3. 准备汇报或做关键回归时，再开启 RAGAS
python -m eval rag all --limit 20 --ragas-limit 20 --ragas-n 3

# 4. 两版对比
python -m eval rag diff <baseline_run> <candidate_run>
```

如果要把它纳入 CI，先只跑 `--skip-ragas` 的自建指标；RAGAS 成本高、有方差，更适合定期评测或发布前评测。
