"""RAGAS LLM-as-judge 五个指标的封装。

指标：
    - faithfulness         response 是否忠实于 retrieved_contexts（幻觉检测）
    - answer_relevancy     response 是否切题（反向生成问题与 user_input 余弦相似度）
    - answer_correctness   response 与 reference 的语义+事实一致（claim F1 + similarity）
    - context_precision    retrieved_contexts 里有用信息的比例
    - context_recall       retrieved_contexts 是否覆盖 reference 所需信息

依赖：``pip install ragas langchain-openai datasets``

环境变量（推荐）：
    SILICONFLOW_API_KEY  使用硅基流动同时作为 judge 和 embedding provider
    JUDGE_API_KEY        judge 模型 API Key；未设置时可用 SILICONFLOW_API_KEY
    JUDGE_BASE_URL       judge OpenAI-compatible base URL
    JUDGE_MODEL          默认 deepseek-ai/DeepSeek-V3.2（硅基流动）或 gpt-5.4-mini（旧版 AIHubMix）
    EMBEDDING_API_KEY    embedding API Key；未设置时可用 SILICONFLOW_API_KEY
    EMBEDDING_BASE_URL   embedding base URL；默认 https://api.siliconflow.cn/v1
    EMBEDDING_MODEL      默认 Qwen/Qwen3-Embedding-8B
环境变量（旧版兼容）：
    AIHUBMIX_API_KEY / AIHUBMIX_BASE_URL
        未配置拆分变量时，同时作为 judge 和 embedding provider；
        embedding 默认 text-embedding-3-large。

样本过滤：只评 response / retrieved_contexts / reference 三项齐全且 final_status=success
的样本，其余记 skip_reason 到 meta，不参与均值。
"""
from __future__ import annotations

import os
import sys
import types
import warnings
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any

from eval.common.schemas import EvalRecord, MetricResult

warnings.filterwarnings("ignore", category=DeprecationWarning)

RAGAS_METRIC_KEYS = (
    "faithfulness",
    "answer_relevancy",
    "answer_correctness",
    "context_precision",
    "context_recall",
)

_REASONING_MODEL_PREFIXES = ("gpt-5", "o1", "o3", "o4")

DEFAULT_LEGACY_BASE_URL = "https://aihubmix.com/v1"
DEFAULT_JUDGE_MODEL = "gpt-5.4-mini"
DEFAULT_LEGACY_EMBEDDING_MODEL = "text-embedding-3-large"
DEFAULT_SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1"
DEFAULT_SILICONFLOW_JUDGE_MODEL = "deepseek-ai/DeepSeek-V3.2"
DEFAULT_SILICONFLOW_EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-8B"


@dataclass(frozen=True)
class ProviderConfig:
    judge_api_key: str
    judge_base_url: str
    judge_model: str
    embedding_api_key: str
    embedding_base_url: str
    embedding_model: str


def _env(name: str) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _load_provider_config() -> ProviderConfig:
    """Load split judge/embedding provider config with legacy AIHUBMIX fallback."""
    legacy_api_key = _env("AIHUBMIX_API_KEY")
    legacy_base_url = _env("AIHUBMIX_BASE_URL") or DEFAULT_LEGACY_BASE_URL
    siliconflow_api_key = _env("SILICONFLOW_API_KEY")
    siliconflow_base_url = _env("SILICONFLOW_BASE_URL") or DEFAULT_SILICONFLOW_BASE_URL

    judge_api_key = _env("JUDGE_API_KEY") or siliconflow_api_key or legacy_api_key
    if not judge_api_key:
        raise RuntimeError(
            "缺少环境变量 JUDGE_API_KEY / SILICONFLOW_API_KEY"
            "（或旧版 AIHUBMIX_API_KEY），"
            "RAGAS LLM-judge 调用所需"
        )
    if _env("JUDGE_BASE_URL"):
        judge_base_url = _env("JUDGE_BASE_URL")
    elif siliconflow_api_key:
        judge_base_url = siliconflow_base_url
    else:
        judge_base_url = legacy_base_url
    judge_model = (
        _env("JUDGE_MODEL")
        or (DEFAULT_SILICONFLOW_JUDGE_MODEL if siliconflow_api_key else DEFAULT_JUDGE_MODEL)
    )

    embedding_api_key = _env("EMBEDDING_API_KEY") or siliconflow_api_key
    if embedding_api_key:
        embedding_base_url = (
            _env("EMBEDDING_BASE_URL")
            or siliconflow_base_url
        )
        embedding_model = _env("EMBEDDING_MODEL") or DEFAULT_SILICONFLOW_EMBEDDING_MODEL
    elif legacy_api_key:
        embedding_api_key = legacy_api_key
        embedding_base_url = legacy_base_url
        embedding_model = _env("EMBEDDING_MODEL") or DEFAULT_LEGACY_EMBEDDING_MODEL
    else:
        raise RuntimeError(
            "缺少环境变量 EMBEDDING_API_KEY / SILICONFLOW_API_KEY"
            "（或旧版 AIHUBMIX_API_KEY），RAGAS embedding 调用所需"
        )

    return ProviderConfig(
        judge_api_key=judge_api_key,
        judge_base_url=judge_base_url,
        judge_model=judge_model,
        embedding_api_key=embedding_api_key,
        embedding_base_url=embedding_base_url,
        embedding_model=embedding_model,
    )


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise RuntimeError(f"环境变量 {name} 必须是整数，当前值：{raw}") from exc


def filter_evaluable(records: list[EvalRecord]) -> tuple[list[EvalRecord], list[tuple[str, str]]]:
    """返回 (可评的记录, [(query_id, skip_reason), ...])。"""
    evaluable: list[EvalRecord] = []
    skipped: list[tuple[str, str]] = []
    for r in records:
        reason = None
        if not (r.response or "").strip():
            reason = "empty response"
        elif not r.retrieved_contexts:
            reason = "empty retrieved_contexts"
        elif not (r.reference or "").strip():
            reason = "empty reference"
        elif r.final_status != "success":
            reason = f"final_status={r.final_status}"
        if reason:
            skipped.append((r.query_id, reason))
        else:
            evaluable.append(r)
    return evaluable, skipped


def _build_dataset(records: list[EvalRecord]) -> Any:
    from datasets import Dataset

    return Dataset.from_dict(
        {
            "user_input": [r.user_input for r in records],
            "response": [r.response for r in records],
            "retrieved_contexts": [r.retrieved_contexts for r in records],
            "reference": [r.reference for r in records],
        }
    )


def _model_family(model: str) -> str:
    """返回去掉 provider 前缀后的模型名，便于兼容 openai/gpt-4o-mini 这类写法。"""
    return model.rsplit("/", 1)[-1].lower()


def _is_reasoning_model(model: str) -> bool:
    """OpenAI reasoning 系列不要默认发送 temperature 等采样参数。"""
    family = _model_family(model)
    return any(family.startswith(prefix) for prefix in _REASONING_MODEL_PREFIXES)


def _install_ragas_langchain_compat() -> None:
    """Patch optional VertexAI import expected by ragas 0.2.x on newer LangChain."""
    module_name = "langchain_community.chat_models.vertexai"
    if module_name in sys.modules:
        return
    try:
        __import__(module_name)
        return
    except ModuleNotFoundError:
        module = types.ModuleType(module_name)

        class ChatVertexAI:  # noqa: D401 - import shim only
            """Compatibility placeholder for an optional integration we do not use."""

        module.ChatVertexAI = ChatVertexAI
        sys.modules[module_name] = module


def _build_judges(
    judge_api_key: str,
    judge_base_url: str,
    judge_model: str,
    embedding_api_key: str,
    embedding_base_url: str,
    emb_model: str,
    timeout: int = 900,
    use_json_mode: bool = True,
) -> tuple[Any, Any]:
    from langchain_openai import ChatOpenAI, OpenAIEmbeddings

    judge_kwargs: dict[str, Any] = {
        "model": judge_model,
        "api_key": judge_api_key,
        "base_url": judge_base_url,
        "max_retries": 3,
        "timeout": timeout,
    }
    if not _is_reasoning_model(judge_model):
        judge_kwargs["temperature"] = 0
        if use_json_mode:
            # JSON mode 强制 LLM 输出合法 JSON，避免中文引号等导致 OutputParserException
            judge_kwargs["model_kwargs"] = {"response_format": {"type": "json_object"}}

    judge = ChatOpenAI(
        **judge_kwargs,
    )
    emb = OpenAIEmbeddings(
        model=emb_model,
        api_key=embedding_api_key,
        base_url=embedding_base_url,
        timeout=timeout,
    )
    return judge, emb


def _build_metrics(judge_model: str) -> list[Any]:
    """RAGAS metric 对象会在 evaluate() 中被临时写入 llm/embeddings，不能跨线程共享。"""
    import copy

    _install_ragas_langchain_compat()
    from ragas.metrics import (
        answer_correctness,
        answer_relevancy,
        context_precision,
        context_recall,
        faithfulness,
    )

    metrics = [
        copy.copy(faithfulness),
        copy.copy(answer_relevancy),
        copy.copy(answer_correctness),
        copy.copy(context_precision),
        copy.copy(context_recall),
    ]
    if _is_reasoning_model(judge_model):
        for metric in metrics:
            if getattr(metric, "name", None) == "answer_relevancy":
                metric.strictness = 1
    return metrics


def _run(
    records: list[EvalRecord],
    config: ProviderConfig,
    judge_model: str,
    emb_model: str,
    timeout: int = 900,
) -> Any:
    import pandas as pd

    _install_ragas_langchain_compat()
    from ragas import evaluate

    try:
        from ragas.run_config import RunConfig

        run_config = RunConfig(
            max_retries=_env_int("RAGAS_MAX_RETRIES", 2),
            timeout=timeout,
            max_wait=_env_int("RAGAS_MAX_WAIT", 70),
            max_workers=_env_int("RAGAS_MAX_WORKERS", 1),
        )
    except Exception:
        run_config = None

    def _do_eval(recs: list[EvalRecord], use_json_mode: bool) -> Any:
        judge, emb = _build_judges(
            config.judge_api_key,
            config.judge_base_url,
            judge_model,
            config.embedding_api_key,
            config.embedding_base_url,
            emb_model,
            timeout,
            use_json_mode=use_json_mode,
        )
        kwargs: dict[str, Any] = {
            "dataset": _build_dataset(recs),
            "metrics": _build_metrics(judge_model),
            "llm": judge,
            "embeddings": emb,
            "show_progress": len(recs) > 1,
        }
        if run_config is not None:
            kwargs["run_config"] = run_config
        kwargs["batch_size"] = _env_int("RAGAS_BATCH_SIZE", 1)
        return evaluate(**kwargs)

    # 第一层：batch + JSON mode
    batch_exc: Exception | None = None
    try:
        return _do_eval(records, use_json_mode=True)
    except Exception as _e:
        batch_exc = _e  # Python 3 会在 except 块结束后清理 as 变量，显式保存

    # 第二层：batch 无 JSON mode（回退到 LLM 原生输出）
    try:
        print(
            f"  RAGAS batch eval failed ({type(batch_exc).__name__}), "
            "retrying without JSON mode ..."
        )
        return _do_eval(records, use_json_mode=False)
    except Exception as _e2:
        print(
            f"  RAGAS batch eval without JSON mode also failed "
            f"({type(_e2).__name__}), falling back to per-sample ..."
        )

    # 第三层：逐条 eval（无 JSON mode），隔离问题样本
    dfs = []
    for i, r in enumerate(records):
        try:
            dfs.append(_do_eval([r], use_json_mode=False).to_pandas())
        except Exception as single_exc:
            print(
                f"    sample {i} ({r.query_id}): "
                f"{type(single_exc).__name__}, returning NaN"
            )
            dfs.append(
                pd.DataFrame(
                    {k: [float("nan")] for k in RAGAS_METRIC_KEYS}
                )
            )
    combined_df = pd.concat(dfs, ignore_index=True)

    class _FallbackResult:
        def to_pandas(self) -> pd.DataFrame:
            return combined_df

    return _FallbackResult()


def compute(
    records: list[EvalRecord], *, limit: int | None = None, n_runs: int = 1
) -> list[MetricResult]:
    """主入口。返回 5 个 MetricResult。

    n_runs > 1 时并发跑 N 次取均值，压制 LLM judge 的单次方差。
    支持 JUDGE_* 与 EMBEDDING_* 分别配置；AIHUBMIX_* 仅作为旧版兼容。
    """
    import concurrent.futures

    provider_config = _load_provider_config()
    judge_model = provider_config.judge_model
    emb_model = provider_config.embedding_model

    evaluable, skipped = filter_evaluable(records)
    if limit is not None:
        evaluable = evaluable[:limit]
    if not evaluable:
        print("RAGAS：没有可评的样本（all skipped）", file=sys.stderr)
        return [_empty_result(key, skipped) for key in RAGAS_METRIC_KEYS]

    print(f"RAGAS：可评 {len(evaluable)} 条，跳过 {len(skipped)} 条")
    if skipped:
        for reason, count in Counter(r for _, r in skipped).most_common():
            print(f"  - {reason}: {count}")
    print(
        f"  judge={judge_model} via {provider_config.judge_base_url}  "
        f"embedding={emb_model} via {provider_config.embedding_base_url}"
    )

    # 并发跑 N 次
    if n_runs <= 1:
        dfs = [_run(evaluable, provider_config, judge_model, emb_model).to_pandas()]
    else:
        print(f"  RAGAS: running {n_runs} passes concurrently for score averaging ...")
        with concurrent.futures.ThreadPoolExecutor(max_workers=n_runs) as ex:
            futures = [
                ex.submit(_run, evaluable, provider_config, judge_model, emb_model)
                for _ in range(n_runs)
            ]
            dfs = [f.result().to_pandas() for f in futures]

    # 收集各次跑分的 per-sample 分数
    raw_scores: dict[str, dict[str, list[float | None]]] = {
        k: defaultdict(list) for k in RAGAS_METRIC_KEYS
    }
    record_map = {r.query_id: r for r in evaluable}

    for df in dfs:
        for r, (_, row) in zip(evaluable, df.iterrows()):
            for k in RAGAS_METRIC_KEYS:
                v = row.get(k)
                try:
                    fv = float(v)
                    if fv != fv:  # NaN
                        fv = None
                except (TypeError, ValueError):
                    fv = None
                raw_scores[k][r.query_id].append(fv)

    # 取均值
    per_metric: dict[str, dict[str, float | None]] = {k: {} for k in RAGAS_METRIC_KEYS}
    by_l1: dict[str, dict[str, list[float]]] = {k: defaultdict(list) for k in RAGAS_METRIC_KEYS}
    by_l2: dict[str, dict[str, list[float]]] = {k: defaultdict(list) for k in RAGAS_METRIC_KEYS}
    failed: set[tuple[str, str]] = set()  # (query_id, metric_key) 需要重试

    for k in RAGAS_METRIC_KEYS:
        for qid, scores in raw_scores[k].items():
            valid = [s for s in scores if s is not None]
            if valid:
                avg = sum(valid) / len(valid)
                per_metric[k][qid] = avg
                rec = record_map[qid]
                by_l1[k][rec.intent_l1 or "?"].append(avg)
                by_l2[k][rec.intent_l2 or "?"].append(avg)
            else:
                per_metric[k][qid] = None
                failed.add((qid, k))

    # 对失败的 (query_id, metric) 逐条重试，长文本超时放宽
    if failed:
        print(
            f"  RAGAS: {len(failed)} metric(s) returned NaN/None across all runs, "
            "retrying individually ..."
        )
        for qid, k in sorted(failed):
            record = record_map[qid]
            try:
                retry_df = _run(
                    [record],
                    provider_config,
                    judge_model,
                    emb_model,
                    timeout=1200,
                ).to_pandas()
                fv = float(retry_df.iloc[0].get(k))
                if fv == fv:  # not NaN
                    per_metric[k][qid] = fv
                    by_l1[k][record.intent_l1 or "?"].append(fv)
                    by_l2[k][record.intent_l2 or "?"].append(fv)
                    print(f"    {qid}/{k}: retry OK -> {fv:.4f}")
                    continue
            except Exception:
                pass
            print(f"    {qid}/{k}: retry still failed, kept None", file=sys.stderr)

    def _mean(xs: list[float]) -> float | None:
        return sum(xs) / len(xs) if xs else None

    results: list[MetricResult] = []
    for k in RAGAS_METRIC_KEYS:
        per = per_metric[k]
        vals = [v for v in per.values() if v is not None]
        results.append(
            MetricResult(
                name=k,
                overall=_mean(vals),
                by_intent_l1={l1: _mean(v) for l1, v in by_l1[k].items()},
                by_intent_l2={l2: _mean(v) for l2, v in by_l2[k].items()},
                per_sample=per,
                meta={
                    "n_evaluable": len(evaluable),
                    "n_skipped": len(skipped),
                    "skipped": skipped,
                    "n_runs": n_runs,
                    "judge_model": judge_model,
                    "embedding_model": emb_model,
                    "base_url": provider_config.judge_base_url,
                    "judge_base_url": provider_config.judge_base_url,
                    "embedding_base_url": provider_config.embedding_base_url,
                },
            )
        )
    return results


def _empty_result(name: str, skipped: list[tuple[str, str]]) -> MetricResult:
    return MetricResult(
        name=name,
        overall=None,
        meta={"n_evaluable": 0, "n_skipped": len(skipped), "skipped": skipped},
    )
