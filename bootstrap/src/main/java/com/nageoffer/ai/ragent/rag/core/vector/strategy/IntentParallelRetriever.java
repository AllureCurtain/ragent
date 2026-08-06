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

package com.nageoffer.ai.ragent.rag.core.vector.strategy;

import com.nageoffer.ai.ragent.framework.convention.RetrievedChunk;
import com.nageoffer.ai.ragent.rag.core.intent.IntentNode;
import com.nageoffer.ai.ragent.rag.core.intent.NodeScore;
import com.nageoffer.ai.ragent.rag.core.retrieval.RetrieveRequest;
import com.nageoffer.ai.ragent.rag.core.vector.VectorRetrieverService;
import lombok.extern.slf4j.Slf4j;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executor;

/**
 * 意图并行检索器
 * 继承模板类，实现意图特定的检索逻辑
 */
@Slf4j
public class IntentParallelRetriever extends AbstractParallelRetriever<IntentParallelRetriever.IntentTask> {

    public record IntentTask(NodeScore nodeScore, int intentTopK) {
    }

    public IntentParallelRetriever(VectorRetrieverService retrieverService,
                                   Executor executor) {
        super(retrieverService, executor);
    }

    /**
     * 按意图节点并行检索：将 NodeScore 解析为各自召回深度后委托模板方法执行
     * （独立命名以避免与父类 {@code executeParallelRetrieval(String, List, int)} 泛型擦除后签名冲突）
     */
    public List<RetrievedChunk> retrieveByIntents(String question,
                                                  List<NodeScore> targets,
                                                  int recallBudget) {
        return retrieveByIntents(question, targets, recallBudget, retrieverService.embedAndNormalize(question));
    }

    /**
     * 按意图节点并行检索，复用调用方已算好的查询向量
     */
    public List<RetrievedChunk> retrieveByIntents(String question,
                                                  List<NodeScore> targets,
                                                  int recallBudget,
                                                  float[] queryVector) {
        return super.executeParallelRetrieval(question, buildTasks(targets, recallBudget), recallBudget, queryVector);
    }

    @Override
    protected List<RetrievedChunk> createRetrievalTask(String question, IntentTask task, float[] queryVector, int ignoredTopK) {
        NodeScore nodeScore = task.nodeScore();
        IntentNode node = nodeScore.getNode();
        List<String> collectionNames = node.getEffectiveCollectionNames();
        if (collectionNames.isEmpty()) {
            return List.of();
        }
        try {
            return retrieverService.retrieveByVector(
                    queryVector,
                    RetrieveRequest.builder()
                            .collectionNames(collectionNames)
                            .query(question)
                            .topK(task.intentTopK())
                            .build()
            );
        } catch (Exception e) {
            log.error("意图检索失败 - 意图ID: {}, 意图名称: {}, Collections: {}, 错误: {}",
                    node.getId(), node.getName(), collectionNames, e.getMessage(), e);
            return List.of();
        }
    }

    @Override
    protected String getTargetIdentifier(IntentTask task) {
        NodeScore nodeScore = task.nodeScore();
        IntentNode node = nodeScore.getNode();
        return String.format("意图ID: %s, 意图名称: %s", node.getId(), node.getName());
    }

    @Override
    protected String getStatisticsName() {
        return "意图检索";
    }

    /**
     * 计算命中意图的总召回深度
     * <p>
     * 定向路是每意图各取一份、并行 fan-out，故通道产能是各意图深度之和而非单个 recallBudget；
     * 调用方据此切分主路 / 补充路名额，避免拿「每意图深度」当「通道总额度」用
     */
    public int resolveTotalDepth(List<NodeScore> targets, int recallBudget) {
        return buildTasks(targets, recallBudget).stream()
                .mapToInt(IntentTask::intentTopK)
                .sum();
    }

    /**
     * 把意图节点展开为扇出任务，并按「查询身份」去重
     * <p>
     * 一个任务就是一次 retrieveByVector，其结果只由 collection 集合与召回深度决定（问题与查询向量在请求内恒定），
     * 故两项相同的任务必然返回同一份候选。留着它除了白跑一次检索，还会让同一 chunk 在通道原始列表里占两个名次，
     * 被下游 RRF 按名次累加成双倍分；顺带把通道产能也算大一倍，连累补充路名额虚高
     * <p>
     * 不能改按 collection 去重：一个节点的多个 collection 是一次查询里的并集范围、总共只出 topK 条，
     * 按 collection 计数会把多库节点的产能算成 库数 × topK
     * <p>
     * {@link #resolveTotalDepth} 与实际扇出共用本方法，保证「通道产能」与真实查询数永不漂移
     */
    private List<IntentTask> buildTasks(List<NodeScore> targets, int recallBudget) {
        record QueryIdentity(Set<String> collections, int topK) {
        }
        Map<QueryIdentity, IntentTask> tasks = new LinkedHashMap<>();
        for (NodeScore nodeScore : targets) {
            int intentTopK = resolveIntentTopK(nodeScore, recallBudget);
            Set<String> collections = Set.copyOf(collectionsOf(nodeScore));
            tasks.putIfAbsent(new QueryIdentity(collections, intentTopK), new IntentTask(nodeScore, intentTopK));
        }
        return List.copyOf(tasks.values());
    }

    private static List<String> collectionsOf(NodeScore nodeScore) {
        if (nodeScore == null || nodeScore.getNode() == null) {
            return List.of();
        }
        return nodeScore.getNode().getEffectiveCollectionNames();
    }

    /**
     * 计算单个意图节点检索 TopK
     * 节点级 node.topK 为该意图的绝对召回深度、优先；否则用统一的每通道召回条数 recallBudget
     */
    private int resolveIntentTopK(NodeScore nodeScore, int recallBudget) {
        if (nodeScore != null && nodeScore.getNode() != null) {
            Integer nodeTopK = nodeScore.getNode().getTopK();
            if (nodeTopK != null && nodeTopK > 0) {
                return nodeTopK;
            }
        }
        return recallBudget;
    }
}
