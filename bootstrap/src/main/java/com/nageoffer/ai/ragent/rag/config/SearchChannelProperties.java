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

package com.nageoffer.ai.ragent.rag.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * RAG 检索配置
 */
@Data
@Component
@ConfigurationProperties(prefix = "rag.search")
public class SearchChannelProperties {

    /**
     * 默认返回的 TopK
     */
    private int defaultTopK = 10;

    /**
     * 检索通道配置
     */
    private Channels channels = new Channels();

    /**
     * 多通道结果融合配置
     */
    private Fusion fusion = new Fusion();

    @Data
    public static class Channels {

        /**
         * 向量全局检索配置
         */
        private VectorGlobal vectorGlobal = new VectorGlobal();

        /**
         * 意图定向检索配置
         */
        private IntentDirected intentDirected = new IntentDirected();

        /**
         * 关键词检索配置
         */
        private Keyword keyword = new Keyword();

        /**
         * 联网检索配置（You.com Search）
         */
        private WebSearch webSearch = new WebSearch();

        /**
         * 知识图谱检索配置
         */
        private Graph graph = new Graph();
    }

    @Data
    public static class VectorGlobal {

        /**
         * 是否启用
         */
        private boolean enabled = true;

        /**
         * 意图置信度阈值
         * 当意图识别的最高分数低于此阈值时，启用全局检索
         */
        private double confidenceThreshold = 0.6;

        /**
         * 单意图补充检索阈值
         * 当仅识别出一个意图且分数低于此阈值时，启用全局检索作为安全网
         */
        private double singleIntentSupplementThreshold = 0.8;

        /**
         * TopK 倍数
         * 仅逐库并行 fan-out 兜底路径（如 Milvus）使用，每库召回 topK * 倍数
         */
        private int topKMultiplier = 3;

        /**
         * 全局检索候选预算
         * 单次全局查询的 LIMIT 上限，与 fusion.rerankCandidateLimit 配合控制候选规模
         * <=0 时回退到 topK * topKMultiplier 的旧语义
         */
        private int candidateBudget = 100;

        /**
         * 解析全局检索候选预算
         * 优先使用绝对预算 candidateBudget；未配置（<=0）时回退到 topK * topKMultiplier
         */
        public int resolveCandidateBudget(int topK) {
            return candidateBudget > 0 ? candidateBudget : topK * Math.max(1, topKMultiplier);
        }
    }

    @Data
    public static class IntentDirected {

        /**
         * 是否启用
         */
        private boolean enabled = true;

        /**
         * 最低意图分数
         * 低于此分数的意图节点会被过滤
         */
        private double minIntentScore = 0.4;

        /**
         * TopK 倍数
         */
        private int topKMultiplier = 2;
    }

    @Data
    public static class Keyword {

        /**
         * 是否启用
         * 仅当 rag.keyword.type != none（存在关键词检索实现）时才会真正生效
         */
        private boolean enabled = false;

        /**
         * 检索范围
         * intent 仅意图域 / global 全库 / both 意图优先，无意图时全库兜底
         */
        private String mode = "both";

        /**
         * TopK 倍数
         * 关键词召回更多候选，后续通过融合与 Rerank 筛选
         */
        private int topKMultiplier = 2;
    }

    @Data
    public static class Graph {

        /**
         * 是否启用
         * 仅当开启图谱后端（rag.graph.type != none）时才会真正生效
         */
        private boolean enabled = false;

        /**
         * 检索范围
         * intent 仅意图域 / global 全局图 / both 意图优先，无意图时全局兜底
         */
        private String mode = "both";

        /**
         * TopK 倍数
         * 图谱召回实体/关系与来源分块，候选交由融合与 Rerank 精排
         */
        private int topKMultiplier = 2;
    }

    @Data
    public static class WebSearch {

        /**
         * 是否启用
         * 默认关闭；开启后还需配置 api-key（或环境变量 YDC_API_KEY），两者缺一通道不生效
         */
        private boolean enabled = false;

        /**
         * 最多返回的结果条数（网页 + 新闻合计）
         * 默认 5，上限 20；向 You.com 传的是「每 section」数量，合并后由通道统一截断到此值
         */
        private int count = 5;

        /**
         * 请求超时（秒）
         */
        private int timeoutSeconds = 10;

        /**
         * You.com Search API Key
         * 建议留空，此时回退读取环境变量 YDC_API_KEY，避免密钥落入配置文件
         */
        private String apiKey = "";

        /**
         * You.com Search API 地址
         * 一般无需修改，测试时可指向本地 stub
         */
        private String apiUrl = "https://ydc-index.io/v1/search";
    }

    @Data
    public static class Fusion {

        /**
         * 融合策略
         * rrf 倒数名次融合（当前唯一实现），off 关闭融合直接透传
         */
        private String strategy = "rrf";

        /**
         * RRF 平滑常数 k
         * 值越大越弱化高名次的优势。经典取 60（面向上千候选的检索场景），
         * 但本链路每通道候选通常仅约 20~40 条，k=60 会把名次差异过度抹平（头部与尾部分数几乎拉不开），
         * 建议按候选池量级调低（如 20）让头部更有区分度；具体值配合检索归因日志校准
         */
        private int rrfK = 60;

        /**
         * Rerank 候选上限
         * RRF 融合排序后仅保留前 N 个高分候选送入 Rerank 精排，
         * 既控制 Rerank 的成本与延迟，又让多路命中的候选凭 RRF 分数优先入选
         * <=0 表示不截断（全量送入 Rerank），行业经验值 40~100
         */
        private int rerankCandidateLimit = 50;

        /**
         * 各通道 RRF 贡献权重
         * 让不同可信度的通道在融合时话语权不同：RRF 只用名次、丢弃分数量纲，无权重时各通道等权，
         * 一个新接入 / 噪声较多的通道会与最可信通道在每个名次上平起平坐。加权后 delta = 权重 / (k + rank)
         */
        private ChannelWeights channelWeights = new ChannelWeights();
    }

    @Data
    public static class ChannelWeights {

        /**
         * 意图定向（向量精查命中库）权重 最可信
         */
        private double intentDirected = 1.0;

        /**
         * 向量全局（跨库兜底）权重
         */
        private double vectorGlobal = 1.0;

        /**
         * 关键词（BM25）权重
         */
        private double keyword = 1.0;

        /**
         * 图谱权重
         * 图谱为新接入通道、跑在单一全局图上、证据仅经结果侧过滤，默认降权，
         * 待归因日志验证其 Rerank 存活率后再上调；存活率长期为 0 说明当前是纯成本
         */
        private double graph = 0.5;

        /**
         * 联网检索权重
         */
        private double webSearch = 0.5;

        /**
         * 未显式配置通道的兜底权重
         */
        private double defaultWeight = 1.0;
    }
}
