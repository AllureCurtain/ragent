/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package com.nageoffer.ai.ragent.rag.core.retrieval.channel;

import com.nageoffer.ai.ragent.framework.convention.RetrievedChunk;
import com.nageoffer.ai.ragent.rag.config.SearchChannelProperties;
import com.nageoffer.ai.ragent.rag.core.retrieval.RetrievalBudget;
import com.nageoffer.ai.ragent.rag.core.retrieval.RetrieveRequest;
import com.nageoffer.ai.ragent.rag.core.vector.VectorRetrieverService;
import com.nageoffer.ai.ragent.rag.core.vector.strategy.CollectionParallelRetriever;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;

/**
 * 向量检索通道
 * <p>
 * 向量模态收敛为一条通道：定向与全局是同一 embedding 查询、只是 collection 范围不同，
 * 拆成两条并列通道会让同一份证据在 RRF 里自我加权
 * <p>
 * 定向作用域下并行补一路「未命中库」：意图判错时正确证据只在未命中库里，
 * 而判错与否事前无从可靠判定（意图分未校准）、事后也测不出（错库内容余弦未必低），
 * 故不做判定、直接给补充路固定候选名额，与定向路一起交下游精排
 */
@Slf4j
@Component
public class VectorSearchChannel implements SearchChannel {

    private final SearchChannelProperties properties;
    private final VectorRetrieverService retrieverService;
    private final CollectionParallelRetriever globalRetriever;
    private final Executor retrievalExecutor;

    public VectorSearchChannel(VectorRetrieverService retrieverService,
                               SearchChannelProperties properties,
                               Executor innerRetrievalExecutor) {
        this.properties = properties;
        this.retrieverService = retrieverService;
        this.globalRetriever = new CollectionParallelRetriever(retrieverService, innerRetrievalExecutor);
        this.retrievalExecutor = innerRetrievalExecutor;
    }

    @Override
    public String getName() {
        return "VectorSearch";
    }

    @Override
    public boolean isEnabled(SearchContext context) {
        // 一条通道一个开关；启用后内部总有一条作用域可走
        return properties.getChannels().getVector().isEnabled();
    }

    @Override
    public SearchChannelResult search(SearchContext context) {
        long startTime = System.currentTimeMillis();

        try {
            RetrievalScope scope = context.getRetrievalScope();
            List<RetrievedChunk> chunks;
            Map<String, Object> metadata;
            if (scope.directed()) {
                chunks = retrieveDirected(context, scope);
                metadata = Map.of("scope", "directed", "topScore", scope.topScore());
            } else {
                chunks = retrieveGlobal(context, scope);
                metadata = Map.of("scope", "global", "topScore", scope.topScore());
            }

            long latency = System.currentTimeMillis() - startTime;
            return SearchChannelResult.builder()
                    .channelType(SearchChannelType.VECTOR)
                    .channelName(getName())
                    .chunks(chunks)
                    .latencyMs(latency)
                    .metadata(metadata)
                    .build();

        } catch (Exception e) {
            log.error("向量检索失败", e);
            return SearchChannelResult.builder()
                    .channelType(SearchChannelType.VECTOR)
                    .channelName(getName())
                    .chunks(List.of())
                    .latencyMs(System.currentTimeMillis() - startTime)
                    .build();
        }
    }

    @Override
    public SearchChannelType getType() {
        return SearchChannelType.VECTOR;
    }

    /**
     * 定向作用域：对命中库取主路候选，同时并行补一路未命中库
     * 定向与全局同一取数原语、只差库集合；两路共用一次 embedding、同池并发，补充路不增加通道延迟
     */
    private List<RetrievedChunk> retrieveDirected(SearchContext context, RetrievalScope scope) {
        String question = context.getMainQuestion();
        float[] queryVector = retrieverService.embedAndNormalize(question);
        ScopeQuota quota = ScopeQuota.split(scope, resolveDirectedBudget(scope, context.getBudget()), supplementRatio());

        // 补充路失败必须只损失自己：它拿到的是兜底名额，而 join() 抛出会让已经取回的定向证据一起被
        // 通道级 catch 丢掉——兜底路把主路带走，鲁棒性方向正好反了
        CompletableFuture<List<RetrievedChunk>> supplementTask = quota.supplement() > 0
                ? CompletableFuture.<List<RetrievedChunk>>supplyAsync(
                () -> retrieveOver(question, queryVector, scope.supplementCollections(), quota.supplement()),
                retrievalExecutor)
                .exceptionally(e -> {
                    log.warn("向量补充路检索失败，仅丢弃补充证据: {}", e.getMessage());
                    return List.of();
                })
                : CompletableFuture.completedFuture(List.of());

        List<RetrievedChunk> directed = retrieveOver(question, queryVector, scope.targetCollections(), quota.primary());
        List<RetrievedChunk> supplement = supplementTask.join();

        log.info("向量检索完成（定向），意图 top1={}，命中 {} 库 {} 条（最高余弦 {}），补充 {} 库 {} 条（最高余弦 {}）",
                scope.topScore(), scope.targetCollections().size(), directed.size(), topScoreOf(directed),
                scope.supplementCollections().size(), supplement.size(), topScoreOf(supplement));
        return merge(directed, supplement);
    }

    /**
     * 定向路的通道产出额度：意图级 node.topK 覆盖每通道默认额度 recallBudget，是绝对深度、可大可小
     * <p>
     * 逐库取数后一次查询只有一个深度，多意图命中时取最大值——取大只放宽召回、多出的候选交给精排收敛，
     * 任何按意图切分配额的方案都是在重造 fan-out。再按候选池上限钳制：超出的部分进不了 Rerank，查了也是空转
     */
    private int resolveDirectedBudget(RetrievalScope scope, RetrievalBudget budget) {
        int depth = scope.intents().stream()
                .mapToInt(nodeScore -> {
                    Integer topK = nodeScore.getNode() == null ? null : nodeScore.getNode().getTopK();
                    return topK != null && topK > 0 ? topK : budget.recallBudget();
                })
                .max()
                .orElse(budget.recallBudget());
        int candidateLimit = budget.candidateLimit();
        return candidateLimit > 0 ? Math.min(depth, candidateLimit) : depth;
    }

    /**
     * 全局作用域：跨全部有效库检索
     */
    private List<RetrievedChunk> retrieveGlobal(SearchContext context, RetrievalScope scope) {
        if (scope.targetCollections().isEmpty()) {
            log.warn("未找到任何 KB collection，跳过全局检索");
            return List.of();
        }
        String question = context.getMainQuestion();
        List<RetrievedChunk> chunks = retrieveOver(question, retrieverService.embedAndNormalize(question),
                scope.targetCollections(), globalFetchSize(context.getBudget()));

        log.info("向量检索完成（全局），意图 top1={}，{} 库 {} 条（最高余弦 {}）",
                scope.topScore(), scope.targetCollections().size(), chunks.size(), topScoreOf(chunks));
        return chunks;
    }

    /**
     * 在给定 collection 范围内取一路候选：按相关性降序、条数不超过 budget
     * <p>
     * 后端支持跨库过滤（PG / Milvus 共享库）时一次查询带总预算即可；否则逐库并行 fan-out 兜底，
     * 每库各取 budget 再统一截断——多取是为了拿到真正的全局前 budget 条（哪个库有好料事前不知道），
     * 但截断不能省：省掉它 budget 就从「总量」悄悄变成「每库上限」，补充路名额被放大成 库数 × 名额
     * <p>
     * 排序在截断之前，两者都不能省：先排后截才是取全局最优的前 budget 条
     */
    private List<RetrievedChunk> retrieveOver(String question, float[] queryVector, List<String> collections, int budget) {
        if (collections.isEmpty()) {
            return List.of();
        }
        List<RetrievedChunk> chunks = retrieverService.supportsGlobalRetrieval()
                ? retrieverService.retrieveByVector(queryVector, RetrieveRequest.builder()
                .collectionNames(collections)
                .query(question)
                .topK(budget)
                .build())
                : globalRetriever.executeParallelRetrieval(question, collections, budget, queryVector);
        return ScopeQuota.cap(sortedByScore(chunks), budget);
    }

    /**
     * 按相关性降序，兑现「通道出口全局有序」这一下游 RRF 依赖的不变式
     * <p>
     * 后端返回序不能直接信：PG 开了 {@code hnsw.iterative_scan=relaxed_order}，pgvector 在该模式下允许
     * 轻微乱序且规划器不补 Sort 节点。其余取数路径（fan-out 归并、两路 merge）都排过，唯独这条曾原样返回
     */
    private static List<RetrievedChunk> sortedByScore(List<RetrievedChunk> chunks) {
        if (chunks.size() < 2) {
            return chunks;
        }
        List<RetrievedChunk> sorted = new ArrayList<>(chunks);
        sorted.sort(BY_SCORE_DESC);
        return sorted;
    }

    /**
     * 全局路一次取数的条数上限
     * <p>
     * 候选池上限 <=0 是融合阶段「不截断」的语义，原样拿来当取数上限就成了 LIMIT 0、一条都召不回，
     * 与配置意图正好相反，故先回退到通道召回额度，保证传给后端的上限恒为正
     */
    private int globalFetchSize(RetrievalBudget budget) {
        int candidateLimit = budget.candidateLimit();
        return properties.getChannels().getVector()
                .resolveCandidateBudget(candidateLimit > 0 ? candidateLimit : budget.recallBudget());
    }

    private double supplementRatio() {
        return properties.getScope().getSupplementRatio();
    }

    /**
     * 合并两路候选并按相关性降序，兑现「通道出口全局有序」这一下游 RRF 依赖的不变式
     */
    private static List<RetrievedChunk> merge(List<RetrievedChunk> directed, List<RetrievedChunk> supplement) {
        if (supplement.isEmpty()) {
            return directed;
        }
        List<RetrievedChunk> merged = new ArrayList<>(directed.size() + supplement.size());
        merged.addAll(directed);
        merged.addAll(supplement);
        merged.sort(BY_SCORE_DESC);
        return merged;
    }

    /**
     * 相关性降序，缺分沉底
     */
    private static final Comparator<RetrievedChunk> BY_SCORE_DESC =
            (a, b) -> Float.compare(scoreOf(b), scoreOf(a));

    /**
     * 取一路候选的最高余弦，供阈值校准观测
     */
    private static float topScoreOf(List<RetrievedChunk> chunks) {
        return chunks.isEmpty() ? 0F : scoreOf(chunks.get(0));
    }

    private static float scoreOf(RetrievedChunk chunk) {
        return chunk.getScore() == null ? Float.NEGATIVE_INFINITY : chunk.getScore();
    }
}
