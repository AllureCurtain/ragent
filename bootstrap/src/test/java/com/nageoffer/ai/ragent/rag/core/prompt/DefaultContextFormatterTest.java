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

package com.nageoffer.ai.ragent.rag.core.prompt;

import com.nageoffer.ai.ragent.framework.convention.RetrievedChunk;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.DefaultResourceLoader;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * KB 上下文组装测试
 * <p>
 * 覆盖上下文优化的核心行为：
 * 1. 按文档聚合：文档之间按相关性（各文档最佳块排名）排序，文档内部按 chunkIndex 还原原文顺序
 * 2. 文档标题作为 source 内部锚点，剥掉文件扩展名；docId 缺失的块单独成组、无 source
 * 3. 同文档的块按 index 排好后用单换行顺次拼接
 */
class DefaultContextFormatterTest {

    private DefaultContextFormatter formatter() {
        return new DefaultContextFormatter(new PromptTemplateLoader(new DefaultResourceLoader()));
    }

    private RetrievedChunk chunk(String id, String text, String docId, String docName, Integer index, float score) {
        return RetrievedChunk.builder()
                .id(id).text(text).score(score)
                .docId(docId).docName(docName).chunkIndex(index)
                .build();
    }

    @Test
    void groupsByDocumentAndOrdersWithinDocByIndex() {
        // 相关性顺序：A的idx3(rank1)、B的idx0(rank2)、A的idx1(rank3)、无归属孤块(rank4)
        List<RetrievedChunk> chunks = List.of(
                chunk("a3", "A-idx3正文", "docA", "员工手册.pdf", 3, 0.9f),
                chunk("b0", "B-idx0正文", "docB", "报销政策.md", 0, 0.8f),
                chunk("a1", "A-idx1正文", "docA", "员工手册.pdf", 1, 0.7f),
                chunk("x0", "孤块正文", null, null, null, 0.6f));

        String result = formatter().formatKbContext(List.of(), Map.of("mc", chunks), 100);

        // 文档 A 整体在文档 B 之前（A 的最佳块排名更高），孤块最后
        assertTrue(result.indexOf("A-idx1正文") < result.indexOf("A-idx3正文"), "同文档内应按 chunkIndex 升序");
        assertTrue(result.indexOf("A-idx3正文") < result.indexOf("B-idx0正文"), "文档 A 整块应在文档 B 之前");
        assertTrue(result.indexOf("B-idx0正文") < result.indexOf("孤块正文"), "无归属孤块应排在最后");

        // 标题作为 source 内部锚点，且剥掉扩展名
        assertTrue(result.contains("source=\"员工手册\""), "应带上文档标题且剥掉扩展名");
        assertTrue(result.contains("source=\"报销政策\""));
        assertFalse(result.contains("员工手册.pdf"), "扩展名不应出现");

        // 孤块单独成组、无 source 属性
        assertTrue(result.contains("<content>\n孤块正文\n</content>"), "docId 缺失应渲染为无 source 的独立块");
    }

    @Test
    void sameDocChunksJoinedByNewline() {
        // 同文档的块按 index 排好后用单换行顺次拼接（原文照拼，不做任何去重/加工）
        List<RetrievedChunk> chunks = List.of(
                chunk("c1", "第一块正文", "docC", "说明.txt", 1, 0.9f),
                chunk("c2", "第二块正文", "docC", "说明.txt", 2, 0.8f));

        String result = formatter().formatKbContext(List.of(), Map.of("mc", chunks), 100);

        assertTrue(result.contains("第一块正文\n第二块正文"), "同文档块之间用单换行拼接");
    }
}
