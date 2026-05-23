# MCP 双端结构实践总结

## 1. 这个实践解决什么问题

在 RAG/Agent 系统里，模型并不总是只靠知识检索回答问题，很多场景还需要调用外部工具能力，例如：

- 销售数据查询
- 审批/考勤/假期查询
- 业务系统 API 调用
- 第三方系统数据获取

如果把这些工具逻辑直接写进主应用，会带来几个问题：

- 主应用和工具实现强耦合
- 工具无法独立部署和扩展
- 工具协议、参数、执行逻辑混在聊天流程中
- 后续想接更多工具时，主应用会越来越重

这个项目采用的做法是：

> 把工具能力拆成 MCP 双端结构：主应用作为调用方，`mcp-server` 作为工具提供方，通过 MCP 协议完成工具发现与调用。

---

## 2. 先回答一个关键问题：远程工具在哪里

在这个项目里，真正的“远程工具实现”主要在：

- `mcp-server`

例如：

- `mcp-server/.../executor/SalesMCPExecutor.java`

这类 `MCPToolExecutor` 才是真正执行业务逻辑的地方。

而 `bootstrap` 侧并不真正实现这些远程工具，它做的是：

- 发现远程工具
- 保存工具定义
- 为远程工具创建本地代理执行器
- 在需要时通过 client 发起远程调用

所以可以这样理解：

### `mcp-server` 侧

> 放的是真正的工具实现

### `bootstrap` 侧

> 放的是远程工具的本地代理和调用编排逻辑

这也是 MCP 双端结构最重要的设计点之一：

> 工具能力和主应用编排解耦。

---

## 3. 整体结构是什么

这套设计可以先理解成：

- `bootstrap`：MCP 调用方（consumer）
- `mcp-server`：MCP 服务方（provider）

其中：

- 调用方负责发现工具、提取参数、发起调用
- 服务方负责暴露工具、执行工具逻辑、返回结果

整体调用链：

```text
用户问题
  -> RAG 主流程判断需要调用工具
  -> 选择某个 MCP Tool
  -> 提取工具参数
  -> 生成 MCPRequest
  -> 找到对应 MCPToolExecutor
  -> 通过 MCPClient 发请求到 mcp-server
  -> mcp-server 接收 /mcp 请求
  -> Dispatcher 分发到具体工具执行器
  -> 执行业务逻辑
  -> 返回 MCPResponse
  -> 主应用继续编排后续回答
```

---

## 4. 为什么这是双端结构

这套设计不是单纯“写了一个远程接口”，而是有明确的两侧分工。

### 4.1 bootstrap 侧

核心职责：

- 管理当前可用工具
- 把自然语言问题转成工具参数
- 用统一接口调用工具
- 屏蔽远程通信细节

### 4.2 mcp-server 侧

核心职责：

- 对外暴露工具
- 接收 MCP 协议请求
- 根据工具 ID 找到执行器
- 执行业务逻辑并返回结果

这就是一个典型的：

> 调用方 / 服务方 解耦结构

---

## 5. bootstrap 侧的结构

### 5.1 工具定义层

- `bootstrap/.../rag/core/mcp/MCPTool.java`

`MCPTool` 表示主应用视角下的工具说明书，包含：

- `toolId`
- `description`
- `parameters`
- `requireUserId`
- `mcpServerUrl`

它解决的是：

> 主应用如何描述“有哪些工具可用，以及每个工具需要什么参数”。

### 5.2 请求响应层

- `bootstrap/.../rag/core/mcp/MCPRequest.java`
- `bootstrap/.../rag/core/mcp/MCPResponse.java`

这两个对象表示一次具体工具调用：

- `MCPRequest`：调用哪个工具、用户是谁、原始问题是什么、参数是什么
- `MCPResponse`：调用是否成功、文本结果、结构化结果、错误信息、耗时等

### 5.3 执行器层

- `bootstrap/.../rag/core/mcp/MCPToolExecutor.java`

主应用并不是直接执行 `MCPTool`，而是通过 `MCPToolExecutor` 来执行工具。

也就是说：

> 每个可执行工具在运行时都需要一个对应的 executor。

在远程工具场景下，这个 executor 通常不是“真实业务执行器”，而是远程代理执行器。

### 5.4 注册中心层

- `bootstrap/.../rag/core/mcp/MCPToolRegistry.java`
- `bootstrap/.../rag/core/mcp/DefaultMCPToolRegistry.java`

注册中心负责：

- 注册工具执行器
- 按 `toolId` 查执行器
- 列举当前工具

本质是：

> `toolId -> executor` 的统一查找中心

### 5.5 参数提取层

- `bootstrap/.../rag/core/mcp/MCPParameterExtractor.java`
- `bootstrap/.../rag/core/mcp/LLMMCPParameterExtractor.java`

这层负责把自然语言问题转成结构化工具参数。

例如：

- 用户问题：`帮我查一下本月华东区销售额`
- 提取参数：

```json
{
  "region": "华东",
  "period": "本月"
}
```

这一步很关键，因为 MCP 不只是远程调用，还涉及：

> 自然语言到工具参数的转换

---

## 6. bootstrap 侧的 client 层

### 6.1 `MCPClient`

- `bootstrap/.../rag/core/mcp/client/MCPClient.java`

它是远程 MCP Server 的客户端抽象，定义了三个核心动作：

- `initialize()`
- `listTools()`
- `callTool()`

### 6.2 `HttpMCPClient`

- `bootstrap/.../rag/core/mcp/client/HttpMCPClient.java`

它是真正通过 HTTP + JSON-RPC 2.0 与远程 mcp-server 通信的实现。

它做的事情包括：

- 初始化握手
- 获取远程工具列表
- 调用远程工具
- 解析返回结果
- 把远端协议对象转换成 bootstrap 本地对象

### 6.3 `MCPClientProperties`

- `bootstrap/.../rag/core/mcp/client/MCPClientProperties.java`

它负责配置远程 MCP Server 列表，例如：

- server name
- server url

说明这套系统是配置驱动的，而不是把服务地址写死在代码里。

### 6.4 `MCPClientAutoConfiguration`

- `bootstrap/.../rag/core/mcp/client/MCPClientAutoConfiguration.java`

应用启动时，它会：

1. 读取配置的 MCP Server 列表
2. 为每个 server 创建 `HttpMCPClient`
3. 调 `initialize()` 建立连接
4. 调 `listTools()` 拉取远程工具定义
5. 为每个远程工具创建 `RemoteMCPToolExecutor`
6. 注册到本地 `MCPToolRegistry`

这一步非常关键，因为它实现了：

> 把远程工具自动装配进本地工具系统

### 6.5 `RemoteMCPToolExecutor`

- `bootstrap/.../rag/core/mcp/client/RemoteMCPToolExecutor.java`

这是整个调用方设计里最关键的桥梁之一。

它实现了 `MCPToolExecutor`，但内部并不执行业务逻辑，而是：

- 持有 `MCPClient`
- 持有远程工具定义 `MCPTool`
- 在 `execute()` 时转而调用远程 server

也就是说：

> 它把“远程 MCP 工具”适配成了“本地可执行工具”。

这就是为什么上层流程不需要关心工具到底是本地还是远程。

---

## 7. mcp-server 侧的结构

### 7.1 工具定义层

- `mcp-server/.../core/MCPToolDefinition.java`
- `mcp-server/.../core/MCPToolRequest.java`
- `mcp-server/.../core/MCPToolResponse.java`

这三个对象是服务端内部的工具领域对象：

- `MCPToolDefinition`：服务端工具定义
- `MCPToolRequest`：协议层转给工具执行器的内部请求
- `MCPToolResponse`：工具执行器返回的内部响应

它们的作用是：

> 把协议层和具体业务执行层分开

### 7.2 服务端执行器层

- `mcp-server/.../core/MCPToolExecutor.java`
- `mcp-server/.../executor/SalesMCPExecutor.java`

服务端每个具体工具都实现一个 `MCPToolExecutor`。

例如 `SalesMCPExecutor`：

- 先通过 `getToolDefinition()` 声明自己是什么工具
- 再通过 `execute()` 实现具体业务逻辑

### 7.3 服务端注册中心层

- `mcp-server/.../core/MCPToolRegistry.java`
- `mcp-server/.../core/DefaultMCPToolRegistry.java`

和 bootstrap 侧类似，服务端也有注册中心。

其作用是：

- 统一管理所有工具执行器
- 按 `toolId` 查找执行器
- 提供工具列表给 `tools/list`

### 7.4 协议入口层

- `mcp-server/.../endpoint/MCPEndpoint.java`

这是 HTTP 入口，负责接收：

- `POST /mcp`

它本身不做业务，只负责把 JSON-RPC 请求交给 `MCPDispatcher`。

### 7.5 协议分发层

- `mcp-server/.../endpoint/MCPDispatcher.java`

这是服务端协议处理的核心。

它负责分发三个核心方法：

- `initialize`
- `tools/list`
- `tools/call`

具体来说：

#### `initialize`
返回协议版本、能力信息、serverInfo。

#### `tools/list`
从注册中心取所有工具定义，再转换成 MCP 标准 schema 返回。

#### `tools/call`
按 `toolId` 找执行器，构造 `MCPToolRequest`，执行工具，最后把 `MCPToolResponse` 转成 MCP 协议标准响应。

### 7.6 协议模型层

- `mcp-server/.../protocol/MCPToolSchema.java`
- `JsonRpcRequest / JsonRpcResponse / JsonRpcError`

这一层负责：

- 和 MCP 协议标准对齐
- 将内部对象转换成外部协议对象

例如：

- 内部：`MCPToolDefinition`
- 对外：`MCPToolSchema`

这体现了一个很好的实践：

> 内部领域对象和外部协议对象分离

---

## 8. 这套设计里最值得借鉴的“设计方式”

如果从最佳实践角度看，MCP 这里最值得学的不是某一个方法，而是下面这些设计方式。

### 8.1 双端职责分离

主应用专注于：

- 工具编排
- 参数提取
- 结果消费

而工具服务专注于：

- 工具暴露
- 业务执行
- 协议返回

这是一种很典型的 consumer/provider 分离方式。

### 8.2 本地代理模式

远程工具并不是直接暴露给主流程，而是先包装成 `RemoteMCPToolExecutor` 注册到本地。

这样上层只依赖统一的 `MCPToolExecutor`，不会感知本地/远程差异。

这是一种非常值得复用的适配器/代理设计。

### 8.3 注册中心模式

两边都使用 registry 管理 executor，而不是在业务代码里写大量 `if/else` 匹配 toolId。

这使系统更容易：

- 扩展新工具
- 动态发现工具
- 统一管理工具元信息

### 8.4 协议层与业务层分离

- 协议层处理 JSON-RPC / MCP schema
- 业务层处理 tool definition / request / response / executor

这让内部模型更稳定，也让协议变化不会直接污染业务实现。

### 8.5 启动时自动发现与自动装配

`bootstrap` 启动时自动连接远程 server、拉取工具、注册代理执行器。

这种做法本质上是在做：

> 工具能力的自动装配

比手工维护工具清单更工程化。

### 8.6 自然语言参数提取单独成层

MCP 在 AI 场景下和传统 RPC 最大的区别之一是：

- 调用参数不一定一开始就是结构化的
- 需要从自然语言中提取

把这一层独立成 `MCPParameterExtractor`，是非常正确的设计方式。

---

## 9. 一个最重要的总图：谁是代理，谁是真工具

为了避免把双端结构混在一起，可以直接用下面这张图理解：

```text
┌──────────────────────────── bootstrap（主应用 / 调用方）────────────────────────────┐
│                                                                                    │
│  [RAG 主流程层]                                                                    │
│  用户问题 -> intent / prompt / chat orchestration                                  │
│                  │                                                                 │
│                  ▼                                                                 │
│  [MCP 编排层]                                                                      │
│  MCPParameterExtractor                                                             │
│  - 把自然语言问题转成工具参数                                                      │
│                  │                                                                 │
│                  ▼                                                                 │
│  MCPToolRegistry                                                                   │
│  - 按 toolId 找到本地 executor                                                     │
│                  │                                                                 │
│                  ▼                                                                 │
│  [本地代理层]                                                                      │
│  RemoteMCPToolExecutor                                                             │
│  - 看起来像本地工具执行器                                                          │
│  - 实际会转发到远程 mcp-server                                                     │
│                  │                                                                 │
│                  ▼                                                                 │
│  [远程通信层]                                                                      │
│  MCPClient / HttpMCPClient                                                         │
│  - initialize                                                                      │
│  - tools/list                                                                      │
│  - tools/call                                                                      │
│                                                                                    │
└───────────────────────────────┬────────────────────────────────────────────────────┘
                                │ HTTP + JSON-RPC / MCP
                                ▼
┌──────────────────────────── mcp-server（工具服务 / 提供方）─────────────────────────┐
│                                                                                    │
│  [协议入口层]                                                                      │
│  MCPEndpoint                                                                       │
│  - 接收 POST /mcp                                                                  │
│                  │                                                                 │
│                  ▼                                                                 │
│  [协议分发层]                                                                      │
│  MCPDispatcher                                                                     │
│  - initialize                                                                      │
│  - tools/list                                                                      │
│  - tools/call                                                                      │
│                  │                                                                 │
│                  ▼                                                                 │
│  [工具管理层]                                                                      │
│  MCPToolRegistry                                                                   │
│  - 按 toolId 找到真正的 executor                                                   │
│                  │                                                                 │
│                  ▼                                                                 │
│  [真实工具执行层]                                                                  │
│  SalesMCPExecutor / 其他 executor                                                  │
│  - 真正执行业务逻辑                                                                │
│                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

这张图对应的设计要点是：

- `bootstrap` 侧主要负责**编排、参数提取、本地代理、远程调用**
- `mcp-server` 侧主要负责**暴露工具、接收协议请求、路由请求、执行业务逻辑**
- `bootstrap` 里的 `RemoteMCPToolExecutor` 是**代理执行器**
- `mcp-server` 里的 `SalesMCPExecutor` 这类才是**真实执行器**

所以这套设计最值得借鉴的方式不是某一个类，而是：

> 让主应用只依赖统一执行抽象，把真正的工具实现放到独立的工具服务中，再通过本地代理把远程工具接入主流程。

---

## 10. 一条完整双端调用链

以一个 `sales_query` 工具为例：

### 9.1 启动阶段

1. `bootstrap` 读取 MCP Server 配置
2. 创建 `HttpMCPClient`
3. 调用 `initialize`
4. 调用 `tools/list`
5. 得到远端返回的 `sales_query` 工具定义
6. 为其创建 `RemoteMCPToolExecutor`
7. 注册到本地 `MCPToolRegistry`

### 9.2 运行阶段

1. 用户提问：`帮我查一下本月华东区销售额`
2. 主应用判定要调用 `sales_query`
3. `LLMMCPParameterExtractor` 提取参数：

```json
{
  "region": "华东",
  "period": "本月"
}
```

4. 构造 `MCPRequest`
5. 从本地 registry 找到 `RemoteMCPToolExecutor`
6. `RemoteMCPToolExecutor.execute()` 内部调用 `HttpMCPClient.callTool()`
7. `HttpMCPClient` 向远端 `/mcp` 发 `tools/call`
8. `mcp-server` 的 `MCPEndpoint` 接到请求
9. `MCPDispatcher.handleToolsCall()` 查 registry 找到 `SalesMCPExecutor`
10. `SalesMCPExecutor.execute()` 执行查询逻辑
11. 返回 `MCPToolResponse`
12. `Dispatcher` 将其转换成 MCP 协议响应
13. `HttpMCPClient` 解析得到文本结果
14. `bootstrap` 封装为 `MCPResponse`
15. 结果回到 RAG 主流程，用于后续回答

---

## 10. 为什么这是一种值得借鉴的最佳实践

### 10.1 工具调用和主业务解耦

主应用不直接依赖具体工具实现，而是通过统一的 MCP 抽象层调用工具。

### 10.2 工具能力可独立部署

`mcp-server` 作为独立服务存在，使工具能力不必和主应用绑在一起。

### 10.3 本地/远程统一执行模型

通过 `MCPToolExecutor` + `RemoteMCPToolExecutor`，上层统一只依赖 executor，不区分本地还是远程。

### 10.4 协议层与业务层分离

- 协议层处理 JSON-RPC / MCP schema
- 业务层只处理 tool definition / tool request / tool response

### 10.5 配置驱动和自动注册

远程 server 列表来自配置，工具注册通过自动发现和自动装配完成，扩展性较好。

### 10.6 适合 Agent / Tool Calling 场景

这套设计天然适合后续扩展更多工具、更多 server、更多外部系统集成。

---

## 11. 开发时可借鉴的点

以后如果自己设计类似能力，可以优先借鉴：

### 11.1 区分调用方与服务方职责

不要让主应用既负责聊天编排，又直接塞满工具实现。

### 11.2 用统一执行器抽象屏蔽本地/远程差异

上层只认 executor，可以显著降低编排层复杂度。

### 11.3 用注册中心管理工具

避免到处写 `if/else` 匹配工具 ID。

### 11.4 协议对象与内部对象分开

这能让内部模型保持稳定，不被外部协议变化直接牵动。

### 11.5 让初始化、工具发现、调用都封装在 client 层

不要把 JSON-RPC、HTTP、URL 拼接等细节泄漏到业务层。

### 11.6 参数提取单独成层

AI 工具调用的一大难点不是“发请求”，而是“把自然语言变成参数”。这层最好独立出来。

---

## 12. 当前实践的边界

这套结构已经很有参考价值，但从更高成熟度看，后续还可以继续增强，例如：

- 多个 MCP Server 的健康检查与重试机制
- 更强的权限控制与鉴权透传
- 更丰富的结构化结果返回与消费方式
- 更完整的超时、重试、熔断治理
- 工具元数据和意图配置的进一步联动
- 更通用的 transport 支持（不仅 HTTP）

所以它当前更适合被理解成：

> 一个面向 MCP 工具调用的工程化双端结构，而不是通用 RPC 框架。

---

## 13. 一句话总结

MCP 这里的最佳实践价值在于：

> 它把“工具调用”拆成了调用方与服务方两端结构，通过 `registry + executor + client + endpoint + dispatcher` 把远程工具能力标准化、协议化、可扩展化地接入 RAG 主流程，是一种很适合 Agent / Tool Calling 系统借鉴的工程实现方式。
