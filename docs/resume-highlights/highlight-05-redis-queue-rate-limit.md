# 简历亮点五：Redis 分布式公平排队限流 + Ticket 状态机 + SSE 流式回传

## 一、简历原文

> 基于 Redis ZSET + Lua 脚本实现分布式公平排队限流，使用 Ticket 状态机以单 CAS 协调 grant/cancel/timeout 三路竞态，配合 Entry TTL 标记实现 JVM 崩溃后队列僵尸自愈；通过可过期信号量控制全局并发上限，Pub/Sub 跨节点唤醒降低排队延迟，SSE 回传执行结果与拒绝/取消状态，有效防止高并发下大模型服务穿透

**与旧版相比新增的能力（写在文档里，简历里可挑两点突出）：**

1. **Ticket 状态机**：用一个 `AtomicReference<State>` 的 CAS 当作"协调点"，把 `grant / cancel / timeout` 三条并发路径收敛成一条
2. **Entry TTL 自愈**：每个排队条目同时写一个独立的存活标记 Key，JVM 崩溃后存活标记自然过期，Lua 在下次扫描时把对应 ZSET 条目当僵尸清理
3. **原 score 重入队**：claim 成功但 permit 被抢走时，按原始 score 重新入队，保留排队位次（旧版会掉到队尾）
4. **门面拆分**：`ChatQueueLimiter` 只做"业务门面 + 拒绝写库"，真正的排队限流逻辑下沉到 `FairDistributedRateLimiter`，后者可以被任何 SSE/流式入口复用

---

## 二、业务背景

大模型调用有两个核心特征：**贵**（按 token 计费）和**慢**（一次回答可能持续几十秒）。高并发下如果不做限流：

1. **模型服务穿透**：同时几十个请求打到大模型 API，超出 QPM/并发上限直接报错，所有用户都失败
2. **资源耗尽**：每条流式请求会占用一条 SSE 连接；真正进入执行阶段后还会占用业务线程和模型调用资源，无上限接入会把线程池/连接池打满
3. **用户体验差**：被模型拒绝后用户只看到"系统错误"，不知道发生了什么

所以需要一个**分布式排队限流系统**：

- **排队**：超出并发上限的请求短时等待，不直接拒绝
- **限流**：用全局信号量严格控制同时调用大模型的请求数
- **分布式**：多个后端节点共享队列和限流状态
- **公平**：先来的请求先获得执行权（FIFO，跨节点统一顺序）
- **自愈**：节点崩溃后队列不会永久堵塞
- **明确反馈**：通过 SSE 在开始执行后回传流式内容，并在超时/取消时给出明确结果

---

### 2.1 当前配置口径

这份文档按当前 checked-in 配置说明，而不是只按 Java 属性里的兜底默认值：

| 配置项 | 当前 `application.yaml` | Java 兜底默认值 |
|--------|-------------------------|----------------|
| `rag.rate-limit.global.enabled` | `true` | `true` |
| `rag.rate-limit.global.max-concurrent` | `10` | `50` |
| `rag.rate-limit.global.max-wait-seconds` | `15` | `20` |
| `rag.rate-limit.global.lease-seconds` | `30` | `600` |
| `rag.rate-limit.global.poll-interval-ms` | `200` | `200` |
| `rag.default.sse-timeout-ms` | `300000` | `300000` |

所以当前 checked-in 配置下，排队等待预算是 15 秒，Entry 僵尸自愈窗口约为 `15s + 5s`，已获得 permit 的请求崩溃后由 30 秒 lease 兜底回收。Java 里的 `20s/600s` 是配置缺失时的后备值。

---

## 三、Redis 资源清单：先把 5 个 Key 的角色讲清楚

整个限流器在 Redis 上一共持有五种数据结构。看懂这五个，后面的代码就是"在它们之间做协调"。

| Key | 类型 | 角色 | 关键操作 |
|-----|------|------|---------|
| `rag:global:chat:semaphore` | `RPermitExpirableSemaphore` | **全局执行许可池**，决定"现在最多能跑几个" | `tryAcquire` 返回 permitId，`release(permitId)` 精确归还 |
| `rag:global:chat:queue` | `RScoredSortedSet`（ZSET） | **全局排队顺序**，决定"谁先轮到尝试" | `ZADD score member` 入队，Lua `ZRANGE/ZREM` 出队 |
| `rag:global:chat:queue:seq` | `RAtomicLong` | **全局递增序号生成器**，作为 ZSET 的 score | `incrementAndGet()` |
| `rag:global:chat:entry:{requestId}` | `RBucket<String>`（带 TTL） | **Ticket 存活标记**，区分队列条目是"还活着"还是"僵尸" | `set("1", TTL)` / `EXISTS` / `DEL` |
| `rag:global:chat:queue:notify` | `RTopic`（Pub/Sub） | **跨节点唤醒通道**，permit 释放后立刻通知所有等待者 | `publish("permit_changed")` |

### 3.1 它们之间是什么关系

```
                            ┌────────────────────────┐
                            │ rag:global:chat:queue  │  ZSET：决定"谁先轮到尝试"
                            │  score=101 → reqA      │
                            │  score=102 → reqB      │
                            │  score=103 → reqC      │
                            └───────────┬────────────┘
                                        │ rank<maxRank 才有资格 claim
                                        ▼
   ┌────────────────────────────┐   Lua 原子检查   ┌─────────────────────────────┐
   │ entry:reqA  TTL=maxWait+5s │ ◄──────────────► │ rag:global:chat:semaphore   │
   │ entry:reqB  TTL=maxWait+5s │   存活校验       │  permits 池：可用 = N - 在跑 │
   │ (entry:reqC 已过期)        │                  │  tryAcquire() → permitId    │
   └────────────────────────────┘                  └──────────────┬──────────────┘
              ▲                                                │
              │ JVM 崩溃后 TTL 自然过期                          │ 持有 permitId 才能跑
              │ → Lua 把 ZSET 里对应条目当僵尸 ZREM              │
              │                                                ▼
              │                              ┌──────────────────────────────┐
              │                              │   chatEntryExecutor 跑业务   │
              │                              │   onAcquired() 真正调模型     │
              │                              └──────────────┬───────────────┘
              │                                             │ 完成/异常
              │                                             ▼
              │                              release(permitId) → publish("permit_changed")
              │                                             │
              │                              ┌──────────────▼──────────────┐
              └──────────────────────────────│  rag:global:chat:queue:notify│
                                             │  Pub/Sub 唤醒所有节点的 poller│
                                             └─────────────────────────────┘
```

**核心观察：**

1. **ZSET 决定"能不能尝试"，Semaphore 决定"能不能真的跑"**。这两件事是分开的。一个请求只有同时拿到「队头窗口的资格」和「一个 permit」才能进入执行阶段。
2. **Entry Bucket 是 ZSET 的"健康度标记"**。ZSET 本身没有 TTL（成员级 TTL），单独用一个 String Key 的 TTL 来标识对应 ZSET 成员是否还活着。
3. **AtomicLong 提供全局总序**。所有节点抢这一个递增 ID，谁先 incr 谁先入队，跨节点公平性的根基就是这个。
4. **Topic 仅做"通知"，不携带状态**。消息内容固定是 `"permit_changed"`，节点收到后自己去查最新的 ZSET 和 Semaphore 状态。

### 3.2 关于"QUEUE 到底是不是队列"

ZSET 在 Redis 里是有序集合，不是 List。但这里用它"模拟队列"：

- score 由全局递增 AtomicLong 给出，所以 score 顺序 = 入队顺序
- 取队头就是按 score 升序取前 N 个（ZRANGE）
- 出队就是 ZREM 指定成员

**为什么不用 List？**

- List 只能 POP 头部元素，**没有"查这个成员排第几"的能力**。而我们的 Lua 必须能判断"当前请求是不是在队头 N 个里"，否则没法判定公平性
- List 中相同值的成员可以重复，删除时只能从头/尾删，没法精确 ZREM 指定成员

所以叫 `queue` 是**语义命名**，底层数据结构是 ZSET。

### 3.3 关于"RPermit 和 Semaphore 到底什么关系"

Redisson 里有两种信号量：

| 维度 | `RSemaphore` | `RPermitExpirableSemaphore`（本项目用的） |
|------|-------------|-------------------------------------------|
| acquire 返回值 | `void` | **`String permitId`** |
| release 方式 | `release()` 归还任意一个 | **`release(permitId)`** 精确归还这一个 |
| 单个 permit 是否有 TTL | 否 | **是**，每个 permit 有独立 lease |
| 节点崩溃后 | permit 永久泄漏 | **lease 到期 Redis 自动回收** |
| 重复释放 | 可能导致超额 | permitId 已释放则忽略（幂等） |

**为什么必须用 expirable 版本？**

假设普通 `RSemaphore` 中节点 A 持有一个 permit 然后 JVM 崩溃，没有任何代码会 `release()` 这个 permit。N 个 permit 的池子里，从此永远少一个。下次再崩，又少一个。直到所有 permit 都被"吃掉"，整个系统并发上限变成 0，彻底卡死。

`RPermitExpirableSemaphore` 在 `tryAcquire` 时传一个 `leaseSeconds`，每个 permit 自带 lease。节点崩溃后 Redis 会在 lease 到期时自动回收，不需要任何看门狗或补偿逻辑。代码兜底默认是 600 秒；当前 `application.yaml` 配的是 30 秒，所以当前配置下已 grant 请求崩溃后最坏约 30 秒回收。

---

## 四、整体架构与调用栈

```
RAGChatController.chat()
  │  返回 SseEmitter（timeout=rag.default.sse-timeout-ms，当前配置 300000ms）
  ▼
RAGChatServiceImpl.streamChat()
  │  生成 conversationId/taskId
  │  创建 StreamChatEventHandler：立即发送 meta 并注册可取消任务
  │  把真正的业务逻辑（Pipeline 执行）包装成 Runnable onAcquire
  ▼
ChatQueueLimiter.enqueue()          ← "业务门面"
  │  ① 限流关闭 → 直接 chatEntryExecutor.execute(onAcquire)
  │  ② 限流开启 → 构造 AcquireRequest，交给 FairDistributedRateLimiter
  ▼
FairDistributedRateLimiter.acquire()  ← 通用限流核心
  │  ① new Ticket(req)
  │  ② cancelBinder.accept(ticket::cancel)   ← 把"取消"绑到 SSE 生命周期
  │  ③ setEntryMarker(requestId, TTL)        ← 写入存活标记（必须先于入队）
  │  ④ queue.add(seq, requestId)             ← ZADD 全局队列
  │  ⑤ tryAcquireIfReady(ticket)             ← 快速路径（fast path）
  │  ⑥ scheduleQueuePoll(ticket)             ← 失败则注册定时轮询
  ▼
  ┌────────────────────────────────────────────────────────┐
  │  Ticket 状态机                                          │
  │    PENDING ──grant(permitId)──→ GRANTED                │
  │    PENDING ──timeout()──────→ TIMED_OUT                │
  │    PENDING ──cancel()───────→ CANCELLED                │
  │    （终态不可逆，业务回调最多触发一次）                    │
  └────────────────────────────────────────────────────────┘
                            │
                            ▼ GRANTED
              ┌─────────────────────────────┐
              │  chatEntryExecutor 跑业务    │
              │  StreamChatPipeline →模型调用 │
              │  finally: releaseHeldPermit()│
              └─────────────────────────────┘
```

### 4.1 ChatQueueLimiter（业务门面）

这个类**不再实现排队逻辑**，只做三件事：

1. **限流开关**：`globalEnabled=false` 时直接绕过排队
2. **构造 AcquireRequest**：把业务参数（`question/conversationId/emitter/onAcquire`）翻译成限流器认识的回调对象
3. **拒绝写库**：`handleReject()` 把超时/拒绝的对话也写入会话历史

核心代码（`ChatQueueLimiter.java:63-85`）：

```java
public void enqueue(String question, String conversationId, SseEmitter emitter, Runnable onAcquire) {
    if (!Boolean.TRUE.equals(rateLimitProperties.getGlobalEnabled())) {
        chatEntryExecutor.execute(onAcquire);
        return;
    }
    chatRateLimiter.acquire(AcquireRequest.builder()
        .maxWaitMillis(TimeUnit.SECONDS.toMillis(rateLimitProperties.getGlobalMaxWaitSeconds()))
        .onAcquired(onAcquire)
        .onTimeout(() -> handleReject(question, conversationId, emitter))
        .onAcquiredExecutor(chatEntryExecutor)
        .cancelBinder(cancel -> {
            emitter.onCompletion(cancel);
            emitter.onTimeout(cancel);
            emitter.onError(e -> cancel.run());
        })
        .build());
}
```

**为什么要拆门面？**

`FairDistributedRateLimiter` 通过 `AcquireRequest` 暴露的接口对业务零依赖（只接受 `Runnable` 和 `Consumer<Runnable>`）。这意味着：

- 它可以被任何其他 SSE/流式入口复用（比如未来的"图片生成"、"语音合成"），不需要复制整套排队状态机代码
- 它可以单元测试：不需要 Spring 上下文，直接 mock `RedissonClient` 和几个回调就能跑

### 4.2 AcquireRequest：业务和限流的契约

```java
public record AcquireRequest(
    long maxWaitMillis,               // 最大等待时间（超过就 timeout）
    Runnable onAcquired,              // 拿到 permit 后跑的业务
    Runnable onTimeout,               // 排队超时后的拒绝处理
    Executor onAcquiredExecutor,      // 业务跑在哪个线程池
    Consumer<Runnable> cancelBinder   // ← 这里是关键，下一节专门讲
) { ... }
```

---

## 五、Consumer&lt;Runnable&gt; cancelBinder：把"取消能力"反向交给外部

这是你最困惑的一个点。Consumer 本身就是 JDK 的标准函数式接口：

```java
public interface Consumer<T> {
    void accept(T t);
}
```

它表示"接受一个 T，不返回任何东西"。`Consumer<Runnable>` 就是"接受一个 Runnable，不返回任何东西"。

### 5.1 cancelBinder 到底在做什么

直接看 `FairDistributedRateLimiter.acquire()` 第 140-142 行：

```java
Ticket ticket = new Ticket(req);
if (req.cancelBinder() != null) {
    req.cancelBinder().accept(ticket::cancel);   // ← 这一行
}
```

`ticket::cancel` 是一个方法引用，本质就是一个 `Runnable`（无参、无返回值）。代码的意思是：

> "把 `ticket::cancel` 这个 Runnable 交给业务方，业务方自己决定什么时候调它。"

然后看 `ChatQueueLimiter` 那一侧（业务方）：

```java
.cancelBinder(cancel -> {            // cancel 就是 ticket::cancel
    emitter.onCompletion(cancel);    // SSE 正常完成 → 调 cancel
    emitter.onTimeout(cancel);       // SSE 超时 → 调 cancel
    emitter.onError(e -> cancel.run()); // SSE 出错 → 调 cancel
})
```

**翻译成大白话：**

1. 限流器创建了一个 Ticket，并且这个 Ticket 自带一个 `cancel()` 方法
2. 限流器不知道"外部生命周期"长什么样（它不认识 SseEmitter），所以它**反向把 cancel 当数据传出去**，让业务方自己接到生命周期上
3. 业务方拿到这个 `cancel` 后，把它注册到 SseEmitter 的三个回调上

之后只要 SSE 连接断开（用户关页面 / 浏览器崩 / 网络抖动 / 服务端超时），SseEmitter 的对应回调会触发 `ticket.cancel()`，状态机就会把这个 Ticket 干净地清掉。

### 5.2 为什么用 Consumer 而不是直接传 SseEmitter

如果限流器写死 `void acquire(SseEmitter emitter, ...)`，那它就和 Spring MVC 的 SSE 强耦合了：

- 不能在非 Web 场景复用（比如未来用 WebFlux、Netty 长连接、gRPC stream）
- 单元测试必须 mock 整个 SseEmitter

用 `Consumer<Runnable>` 当回调，限流器只知道"外部有个生命周期，结束的时候请调我给你的这个 Runnable"，**完全不需要知道 SSE 是什么**。这是经典的依赖倒置（DIP）。

### 5.3 cancelBinder 和"消费者模式"的区别

你提到"几种消费者模式中 Consumer 里的一个方法"——这里需要纠正一下：

- `java.util.function.Consumer` 是**函数式接口**（functional interface），不是"消费者模式"
- "消费者模式"通常指消息队列里的 Producer-Consumer 模式，是架构层面的概念
- 这里的 `Consumer<Runnable>` 仅仅借用了 JDK 这个接口的名字，含义就是"一个吃 Runnable 不吐东西的函数"

`ticket::cancel` 不是 Consumer 里的方法，而是 Ticket 类里的 `cancel()` 方法（`FairDistributedRateLimiter.java:185-188`），用方法引用包装成了 Runnable 传出去。

---

## 六、acquire() 主流程的 6 步

完整代码（`FairDistributedRateLimiter.java:138-151`）：

```java
public void acquire(AcquireRequest req) {
    Ticket ticket = new Ticket(req);                                   // ① 创建状态机实例
    if (req.cancelBinder() != null) {
        req.cancelBinder().accept(ticket::cancel);                    // ② 反向暴露 cancel
    }
    setEntryMarker(ticket.requestId, req.maxWaitMillis());            // ③ 先写存活标记
    RScoredSortedSet<String> queue = redissonClient.getScoredSortedSet(queueKey, StringCodec.INSTANCE);
    queue.add(nextQueueSeq(), ticket.requestId);                      // ④ ZADD 入队
    if (tryAcquireIfReady(ticket)) {                                  // ⑤ 快速路径
        return;
    }
    scheduleQueuePoll(ticket);                                        // ⑥ 注册轮询
}
```

### 6.1 第 ③ 步：为什么 ENTRY 必须先于 ZADD 写入

你问"为什么要 ENTRY？它和 Ticket 之间什么关系？为什么写入 entry 后还要从 Redis 里拿 zset？"——一次性回答：

**Ticket vs ENTRY：**

- **Ticket** 是 JVM 内存里的对象（`FairDistributedRateLimiter.Ticket`），它代表"本进程对这一次请求的认知"
- **ENTRY** 是 Redis 上的一个独立 Key（`rag:global:chat:entry:{requestId}`），它代表"全集群对这个 requestId 还活着的证明"

为什么需要 ENTRY？因为 ZSET 本身只能告诉你"有这么个成员"，但不能告诉你"这个成员的进程还活着没"。如果对应进程已经崩了，ZSET 里这条记录就是僵尸——会永远占着队头位置，把后面所有人都堵死。

解法：每个 ZSET 成员同时配一个独立的 String Key，TTL = `maxWaitMillis + 5000ms`。只要进程还活着、还在排队，它的存活标记就在；进程崩了或正常完成了，这个 Key 就消失。Lua 在 claim 之前先扫一遍队头，发现某成员**ZSET 里有但 entry Key 没了**，就直接当僵尸 ZREM 掉。

**为什么 ENTRY 必须先写、ZADD 后写？**

考虑反过来的顺序（先 ZADD 再 setEntryMarker）：

```
T=0   节点 A: queue.add(seq=101, "reqA")     ← reqA 进了 ZSET
T=1   节点 B: 触发了一次 Lua claim
T=2   节点 B: ZRANGE 看到 reqA
T=3   节点 B: EXISTS entry:reqA → 0（A 还没来得及写）
T=4   节点 B: 判定 reqA 是僵尸 → ZREM 掉
T=5   节点 A: setEntryMarker("reqA")          ← 写了，但 ZSET 里已经没了
```

这就是注释里说的"race 窗口内的并发 claim 会把刚入队的条目当僵尸 ZREM"。

正向顺序则没有这个问题：标记先在，即使 ZADD 之前有 Lua 扫描也找不到对应的 ZSET 成员（ZRANGE 不会返回 reqA），不会把它当僵尸。ZADD 之后才有可能被 Lua 看到，那时候标记已经在。

**为什么写入 entry 后还要从 Redis 里 getScoredSortedSet？**

这一步只是拿 ZSET 的客户端句柄（Redisson 的 `RScoredSortedSet`），不是真的去查数据。下一行 `queue.add(seq, requestId)` 才是真正的 ZADD 写操作。`getScoredSortedSet()` 在 Redisson 里就是个本地工厂方法，不会发起网络请求。

### 6.2 第 ④ 步：nextQueueSeq()

```java
private long nextQueueSeq() {
    RAtomicLong seq = redissonClient.getAtomicLong(queueSeqKey);
    return seq.incrementAndGet();
}
```

全局 AtomicLong 自增，每个请求拿到唯一且递增的 seq 当 ZSET 的 score。所有节点共用同一个 Redis Key，所以排序在跨节点维度天然一致。

### 6.3 第 ⑤ 步：Fast Path "立即返回"是什么意思

你问"如果拿到凭证了就直接返回，这里的返回具体是什么意思？"——回答：

`acquire()` 方法返回（`return;`）意味着限流器**这次调用结束了**，不再注册轮询。但**业务并不是同步执行的**——`ticket.grant()` 已经把业务包装成 Runnable 提交给 `chatEntryExecutor` 异步执行了。所以：

- `acquire()` 返回 ≠ 业务跑完
- `acquire()` 返回 = 限流器对这次请求的"调度责任"已经交付（要么交给 executor 跑业务，要么交给 scheduler 轮询）

整个限流器的设计就是**永远不阻塞调用线程**。调用 `acquire()` 的线程（Tomcat 处理 HTTP 请求的线程）立刻返回，让出来去处理别的 HTTP 请求。

### 6.4 第 ⑥ 步：scheduleQueuePoll 是单独的方法吗

是。`scheduleQueuePoll(ticket)` 是 `FairDistributedRateLimiter.java:338-354` 的方法，里面用 `scheduler.scheduleAtFixedRate(poller, interval, interval, ms)` 注册了一个**周期性定时任务**。同时把 poller 注册到 `PollNotifier`，这样其他节点 publish 的时候本节点也能立刻触发。

### 6.5 这套设计能不能理解成"安全获取全局凭证"

可以，这正是核心思想。把它和"优惠券扣库存"对比一下（你提到的相似场景）：

| 维度 | 优惠券扣库存 | 本项目排队限流 |
|------|------------|---------------|
| 共享资源 | 库存数（一次性） | permit 池（可循环归还） |
| 获取方式 | 先到先得，没了就没了 | 先到先得，没了排队等 |
| 全局一致性 | Redis Lua 原子扣减 | Redis Lua 原子 claim + 信号量 acquire |
| 失败语义 | 直接返回"已抢光" | 短暂等待，等不到再"系统繁忙" |
| 释放路径 | 不释放（除非超时退单） | 业务完成后 release(permitId) |
| 公平性 | 不保证（看谁先到 Redis） | **保证**（全局递增 seq + 队头窗口） |

所以**思路相同，但本项目多了"排队"和"释放"两层**：

- 优惠券扣库存只解决"先到先得"
- 本项目还要解决"超过上限的请求短暂等待 + 用完归还 + 跨节点公平"

至于你说的"远程文档定时同步那里也有很多状态"——是的，思路完全一样：**用一个状态机 + CAS 把多个并发分支收敛成一条确定路径**。区别只是状态语义不同（同步任务是 IDLE/RUNNING/SUCCESS/FAILED；这里是 PENDING/GRANTED/TIMED_OUT/CANCELLED）。

---

## 七、Ticket 状态机详解（最关键的一节）

```java
private enum State {PENDING, GRANTED, TIMED_OUT, CANCELLED}
```

**状态语义：**

| 状态 | 含义 | 触发场景 |
|------|------|---------|
| `PENDING` | 初始状态，正在排队 | `new Ticket(req)` 默认值 |
| `GRANTED` | 拿到 permit，已经/正在/已经跑完业务 | `grant(permitId)` CAS 成功 |
| `TIMED_OUT` | 排队超过 `maxWaitMillis` 仍未获得 permit | 轮询线程发现 `now > deadline` |
| `CANCELLED` | 外部主动取消（SSE 断开） | `emitter.onCompletion/onTimeout/onError` 触发 |

**核心不变量：**

1. 状态只能从 `PENDING` 出发，三个终态都不可逆
2. 三条转移路径都通过 `state.compareAndSet(PENDING, ...)`，只有一个能胜出
3. 业务回调（`onAcquired` 或 `onTimeout`）**最多触发一次**

这就是"单 CAS 协调点"的含义：**把所有并发竞争收敛到一个 AtomicReference 的 CAS 上**。

### 7.1 关于"排队超时"和"SSE 断开"的具体场景

你问"timed out 具体是什么场景？是轮询很长时间都没拿到许可吗？"——是的：

`TIMED_OUT` 触发场景：用户在等，但所有 permit 都被在跑的请求占着，等到 `maxWaitMillis` 还没轮到。当前配置是 15 秒；如果配置缺失，Java 兜底默认是 20 秒。这时轮询线程发现 `now > deadline`，CAS 状态机到 TIMED_OUT，回调 `onTimeout`（在 `ChatQueueLimiter` 里就是 `handleReject`），把"系统繁忙"消息塞回会话历史，并在成功写入拒绝会话后通过 SSE 发 `META + REJECT + FINISH + DONE`。

`CANCELLED` 触发场景（SSE 连接断开），常见三种：

1. **用户主动关页面/切标签/刷新**：浏览器关闭 SSE 连接，Tomcat 通知 SseEmitter，触发 `onCompletion`
2. **网络中断/超时**：客户端长时间没收到数据或心跳丢失，Tomcat 主动断连，触发 `onTimeout` 或 `onError`
3. **服务端流式回调出错**：模型调用过程中抛异常被吞到 SSE 层，触发 `onError`

注意：**Ticket 的 TIMED_OUT 和 SSE 的 onTimeout 不是一回事**。前者是排队层面的超时（还没开始跑），后者是 HTTP 连接层面的超时（连接闲置太久）。SSE 的 onTimeout 会调 `ticket::cancel`，让状态机走 CANCELLED 路径——也就是说，"SSE 自身超时"在状态机看来就是"被外部取消"。

### 7.2 ticket.cancel() 详解

```java
void cancel() {
    state.compareAndSet(State.PENDING, State.CANCELLED);
    cleanup();
}
```

**为什么 CAS 失败也要 cleanup？**

`cleanup()` 内部本身就是幂等的（`queue.remove()` 是 no-op 即可，`deleteEntryMarker()` 删不存在的 Key 也 ok）。失败情况说明"已经被 grant 或 timeout 抢占"，但是：

- 如果是 grant 抢占：cancel 这条路径仍然需要清自己注册的 poller、future 等本地资源
- 如果是 timeout 抢占：timeout 路径已经做过 cleanup，再做一次也无害

**你问"granted 状态下不会释放 permit，这里有什么风险吗？"**

完全没有风险，反而是**关键正确性保证**。看 `cleanup()` 第 265-271 行：

```java
boolean releasedPermit = false;
if (state.get() != State.GRANTED) {     // ← 关键：GRANTED 状态下不动 permit
    String permitId = permitRef.getAndSet(null);
    if (permitId != null) {
        releasePermitQuietly(permitId);
        releasedPermit = true;
    }
}
```

**为什么 GRANTED 下不能释放？**

GRANTED 意味着业务已经开始跑（或马上要跑），permit 的生命周期已经被 `grant()` 包装的 try/finally 接管。代码在 `grant()` 第 219-225 行：

```java
Runnable wrapped = () -> {
    try {
        req.onAcquired().run();
    } finally {
        releaseHeldPermit();   // ← permit 释放的"正常路径"
    }
};
```

如果 cancel/timeout 也跨界去释放 permit，会发生：

```
T=0  grant 成功，CAS 到 GRANTED，permit P1 持有
T=1  业务开始跑（chatEntryExecutor 上）
T=2  并发的 cancel 触发（SSE 断了），CAS 失败但执行 cleanup
T=3  如果 cleanup 释放了 P1 → 信号量 +1
T=4  下一个排队请求 R2 来抢，拿到 P1 重新 acquire 成功
T=5  现在 P1 同时被"在跑的业务"和"R2"持有！
T=6  R2 也开始跑模型调用 → 全局并发数超过 max
T=7  业务跑完 finally 释放 P1（第二次）→ 信号量再 +1 → 超额
```

这就是注释里说的"跨界释放会导致并发请求拿到尚在使用的 permit"。GRANTED 状态下 cleanup 不动 permit，是保证 permit 释放严格通过 try/finally 一条路径走。

### 7.3 ticket.timeout() 详解

```java
void timeout() {
    if (!state.compareAndSet(State.PENDING, State.TIMED_OUT)) {
        return;                                       // 已被 grant 或 cancel 抢占
    }
    cleanup();                                        // 清队列、删 entry、注销 poller
    submitSafely(req.onTimeout(), "onTimeout");      // 在业务线程池跑拒绝逻辑
}
```

CAS 失败说明"已经 grant 或 cancel"，那对应路径会自己处理，timeout 直接返回不做事。CAS 成功才进 cleanup 和 onTimeout 回调。

`submitSafely` 是把 `onTimeout` 提交到 `req.onAcquiredExecutor()`（即 chatEntryExecutor），不在 scheduler 线程上跑——避免拒绝写库这种慢操作阻塞 scheduler。

### 7.4 ticket.grant(permitId) 详解（最复杂）

```java
boolean grant(String permitId) {
    permitRef.set(permitId);                                          // A
    if (!state.compareAndSet(State.PENDING, State.GRANTED)) {        // B
        if (permitRef.compareAndSet(permitId, null)) {               // C
            releasePermitQuietly(permitId);
            publishQueueNotify();
        }
        return false;
    }
    unregisterFromNotifier();                                         // D
    cancelFutureQuietly();                                            // E
    Runnable wrapped = () -> {                                        // F
        try {
            req.onAcquired().run();
        } finally {
            releaseHeldPermit();                                      // G
        }
    };
    try {
        req.onAcquiredExecutor().execute(wrapped);                    // H
        return true;
    } catch (RejectedExecutionException ex) {                         // I
        releaseHeldPermit();
        cleanup();
        submitSafely(req.onTimeout(), "onTimeout(fallback)");
        return false;
    }
}
```

**关键点逐一拆开：**

#### A → B 的顺序：为什么先 set 再 CAS

注释明确写着"permitRef 设值与 CAS 顺序：先 set，再 CAS"。反过来的话存在 race：

```
T=0  CAS 成功（状态变 GRANTED）
T=1  并发的 cancel 触发 → CAS 失败 → cleanup
T=2  cleanup 看 state == GRANTED → 不动 permit
T=3  grant 才执行 permitRef.set(permitId)
T=4  permit 没人释放（grant 后面会 try/finally，但要求业务先跑）
```

更糟糕的场景：如果 grant 的线程在 T=1~T=3 之间被 OS 调度切走，permit 暂时是"挂账"状态，没人能释放。

正向顺序则没问题：

```
T=0  permitRef.set(permitId)
T=1  CAS 失败（被 cancel 先抢）
T=2  grant 走 C 分支：CAS permit null → 自己释放
```

CAS permit 用的是 `compareAndSet(permitId, null)`，**防止 cleanup 那条路径同时也想释放**。两边都用 CAS，谁先成功谁释放，另一边 CAS 失败就跳过。这就是注释里说的"CAS 防双重释放"。

#### D：unregisterFromNotifier 是什么意思

`PollNotifier` 维护了一个 `ConcurrentHashMap<requestId, Runnable poller>`，所有在排队的 Ticket 都在里面。一旦 grant 成功，这个 Ticket 不需要再被 Pub/Sub 唤醒了，要从注册表里删掉。`pollNotifier.unregister(requestId)` 就是 `ConcurrentHashMap.remove(requestId)`。

#### E：cancelFutureQuietly 取消定时任务

`scheduleQueuePoll` 注册的 `ScheduledFuture<?> future` 是周期性的——如果不取消，它会一直每 200ms 跑一次。grant 成功了，poller 没必要再跑，所以取消。

为什么"还会有定时任务的逻辑"？因为快速路径失败时（permit 已满 / 不在队头窗口），acquire() 注册了 scheduleQueuePoll。grant 成功是后来某次轮询触发的——这次成功后，定时任务的"剩余周期"就没必要再跑，所以 cancel。

#### F-G：try/finally 是 permit 释放的唯一正常路径

业务无论成功、抛异常、被中断，`finally` 都会跑 `releaseHeldPermit()`。这是整个限流器最重要的一条不变量：**GRANTED 之后 permit 由 try/finally 释放，没有第二条路径**。

#### H-I：RejectedExecutionException 兜底

`chatEntryExecutor` 可能因为线程池打满、JVM shutting down 等原因拒绝提交。这时业务根本没跑（wrapped 没被执行），try/finally 也不会触发释放 permit。代码显式 catch 这个异常，手动 `releaseHeldPermit() + cleanup() + onTimeout`，把这个 Ticket 当超时处理。

这是一个**特别容易漏掉**的边界。常见错误是只写 `executor.execute(wrapped)` 就以为完事了，结果线程池满的时候 permit 永远不释放、SSE 永远不结束。

### 7.5 releaseHeldPermit() 详解：permitRef.getAndSet 怎么"拿到当前 Ticket 的 permit"

```java
void releaseHeldPermit() {
    String pid = permitRef.getAndSet(null);
    if (pid != null) {
        releasePermitQuietly(pid);
        publishQueueNotify();
    }
}
```

你问"为什么直接 get 就能 get 到？是直接获取当前线程的数据吗？"——回答：

**`permitRef` 是 Ticket 实例的字段**（`AtomicReference<String>`），不是线程本地变量。每个 Ticket 自己持有一个 permitRef。

具体看 Ticket 的字段定义（第 166 行）：

```java
final AtomicReference<String> permitRef = new AtomicReference<>();
```

执行链路是这样的：

```
acquire(req)
  └── new Ticket(req)                         ← Ticket 实例 t1 创建，t1.permitRef = AtomicReference(null)
  └── tryAcquireIfReady(t1)
        └── permitId = "abc"                  ← Lua claim + Redis semaphore acquire 得到 permitId
        └── t1.grant("abc")
              └── t1.permitRef.set("abc")     ← 写到 t1 自己的字段上
              └── chatEntryExecutor.execute(wrapped)
                    └── wrapped 在线程池跑
                          └── t1.onAcquired.run()
                          └── finally: t1.releaseHeldPermit()
                                └── t1.permitRef.getAndSet(null) → "abc"   ← 取出 t1 自己的字段
```

`releaseHeldPermit()` 是 Ticket 的实例方法。`permitRef.getAndSet(null)` 操作的是**当前 Ticket 对象的 permitRef 字段**——不是"当前线程的 permit"。`this.permitRef` 这种写法的隐含 `this` 指向调用这个方法的 Ticket 实例。

**为什么用 getAndSet 而不是直接 get？**

`getAndSet(null)` 是原子的"取出旧值 + 置空"。这样可以保证：

1. 多个路径同时进入 releaseHeldPermit 时，只有一个能拿到非 null 的 pid
2. 拿到 pid 的那个负责 release，其他的拿到 null 直接返回
3. **永远不会重复 release**

如果只 `get()`：拿到了 pid 但没置空，第二次调用又拿到同一个 pid，会 release 两次。

### 7.6 publishQueueNotify() 是什么思想

```java
private void publishQueueNotify() {
    redissonClient.getTopic(notifyTopicKey).publish("permit_changed");
}
```

往 Redis Pub/Sub channel 发一条固定消息。**它不是给队列里某个特定元素发通知**，而是广播"队列/permit 状态变了，所有在等的 poller 可以重试一次"。

谁会收到？

- 所有节点都订阅了这个 topic（`start()` 里 `topic.addListener(...)` 加的 listener）
- 收到后调 `pollNotifier.fire()` → 触发本节点所有注册的 poller 立刻重试

调用场景（项目里 publishQueueNotify 总共 5 处调用）：

1. permit 真正释放后（`releaseHeldPermit` / `cleanup`）
2. tryAcquireIfReady 成功 grant 后（队头窗口变了，其他人可能晋升）
3. claim 成功但 permit 被抢、重入队后（其他人可能要让位）
4. grant 失败被取消、补释放 permit 后

所以名字虽然叫 `permit_changed`，但语义其实是"**队列或 permit 状态发生了变化，大家可以再试一次**"。这是"事件驱动 + 主动轮询"的双轮模式：Pub/Sub 当快通道（接近 0 延迟），200ms 轮询当慢通道（兜底防 Pub/Sub 丢消息）。

### 7.7 cleanup() 详解：幂等的统一清理

```java
void cleanup() {
    boolean removed = false;
    try {
        removed = redissonClient.getScoredSortedSet(queueKey, StringCodec.INSTANCE).remove(requestId);
    } catch (Exception ex) {
        log.debug("[{}] 移除队列失败 (requestId={})", name, requestId, ex);
    }
    deleteEntryMarker(requestId);

    boolean releasedPermit = false;
    if (state.get() != State.GRANTED) {
        String permitId = permitRef.getAndSet(null);
        if (permitId != null) {
            releasePermitQuietly(permitId);
            releasedPermit = true;
        }
    }
    if (removed || releasedPermit) {
        publishQueueNotify();
    }
    unregisterFromNotifier();
    cancelFutureQuietly();
}
```

**cleanup 做的事情：**

1. 从 ZSET 移除 requestId（可能已被 Lua claim 移走，no-op 即可）
2. 删 entry 标记（防止僵尸残留）
3. 如果**不是 GRANTED** 状态，释放 permit（用 getAndSet 保证只释放一次）
4. 如果实际做了清理（队列或 permit），broadcast 一次 publishQueueNotify
5. 从 PollNotifier 注销
6. 取消周期性 future

**幂等性来自哪里：**

- `queue.remove()` 删不存在的成员返回 false，不抛异常
- `deleteEntryMarker` 删不存在的 Key 不抛
- `permitRef.getAndSet(null)` 取过一次后第二次返回 null
- `pollNotifier.unregister` 是 ConcurrentHashMap.remove
- `cancelFutureQuietly` 检查 isCancelled

所以 cancel 和 timeout 都能放心调 cleanup，重复调用也安全。

---

## 八、tryAcquireIfReady() 详解（抢占核心）

```java
private boolean tryAcquireIfReady(Ticket ticket) {
    if (!ticket.isPending()) {                              // 1
        return false;
    }
    int avail = availablePermits();                         // 2
    if (avail <= 0) {                                       // 3
        return false;
    }
    long claimedScore = claimIfReady(ticket.requestId, avail);  // 4
    if (claimedScore < 0L) {                                // 5
        return false;
    }
    String permitId = tryAcquirePermit();                   // 6
    if (permitId == null) {                                 // 7
        setEntryMarker(ticket.requestId, Math.max(1, ticket.deadline - System.currentTimeMillis()));
        RScoredSortedSet<String> queue = redissonClient.getScoredSortedSet(queueKey, StringCodec.INSTANCE);
        queue.add(claimedScore, ticket.requestId);          //    用原始 score 重入队
        publishQueueNotify();
        if (!ticket.isPending()) {                          //    race 兜底：被 cancel/timeout 的话回滚
            queue.remove(ticket.requestId);
            deleteEntryMarker(ticket.requestId);
        }
        return false;
    }
    if (!ticket.isPending()) {                              // 8
        releasePermitQuietly(permitId);
        publishQueueNotify();
        return false;
    }
    publishQueueNotify();                                   // 9
    return ticket.grant(permitId);                          // 10
}
```

### 8.1 它是获取锁还是获取 permit？具体在做什么

**它在做的是"获取执行权"**。所谓"执行权" = "队头窗口资格" + "一个 permit"。这两件事缺一不可：

- 即使有空闲 permit（avail > 0），如果你排在第 10 位、前面还有 9 个人，你不能跳过去抢（公平性）
- 即使你排在第 1 位，如果 permit 池里一个都没有，你也只能等

锁这个词在这里不太准确——Java 里的"锁"通常是排他互斥，一个时刻只有一个持有者。这里更准确的说法是"**信号量许可（semaphore permit）**"，允许 N 个并发持有。

### 8.2 第 4-5 步：claimIfReady 返回 -1 为什么代表"不在队头窗口"

`claimIfReady` 调 Lua 脚本，脚本的返回是 `{0}` 或 `{1, score}`：

- `{0}` → claim 失败，Lua 层判定这个 requestId 不在存活的队头 maxRank 个里
- `{1, score}` → claim 成功，已经 ZREM 了，把原始 score 返回给 Java（用于失败时重入队）

Java 把"claim 失败"统一映射成 `-1L`：

```java
if (result == null || result.isEmpty() || parseLong(result.get(0)) != 1L) {
    return -1L;
}
return result.size() >= 2 ? parseLong(result.get(1)) : nextQueueSeq();
```

所以 `claimedScore < 0` 的语义就是"**Lua 那边说我不在队头窗口**"。

### 8.3 第 6 步：tryAcquirePermit 和 claimIfReady 的关系

这是你最困惑的点之一，关键是要理解**它们各自检查的是不同维度的资源**：

| 操作 | 检查/争用的资源 | 失败语义 |
|------|---------------|---------|
| `claimIfReady` | ZSET 队头窗口资格 | 不公平，必须排队 |
| `tryAcquirePermit` | Semaphore permit 数 | 没有空闲 permit |

为什么需要两步？

`availablePermits()`（第 2 步）只是"**看一眼**"——读到这个值之后，**和 claim 之间不是原子**。两个不同节点上的请求 R1 和 R2 都看到 `avail=1`，都调了 Lua，**Lua 都可能返回成功**（因为 Lua 只检查 ZSET 队头窗口，不检查 semaphore），但 semaphore 里只有 1 个 permit。

```
T=0  R1: availablePermits → 1
T=0  R2: availablePermits → 1
T=1  R1: claimIfReady(maxRank=1) → 成功（R1 在队头）
T=2  R2: claimIfReady(maxRank=1) → 成功（R1 刚被 ZREM，R2 现在是队头）
T=3  R1: tryAcquirePermit → 拿到 permitId="P1"
T=4  R2: tryAcquirePermit → 拿不到（permit 池空）→ null
```

这种情况下 R2 必须"**让步**"——把自己重新加回队列，避免请求丢失。

### 8.4 第 7 步：原 score 重入队的关键改进

旧版的做法是 `queue.add(nextQueueSeq(), requestId)`——用新序号，排到队尾。新版的做法是 `queue.add(claimedScore, requestId)`——用原始 score，**保留原排队位次**。

为什么这个改进重要？

考虑极端场景：系统并发 = 1，三个请求 A、B、C 入队（seq=100,101,102）。permit 满，A 第一个 claim 成功但被 B 的 race 抢了 permit。旧版：

```
A 被踢到队尾（新 seq=103）
现在队列顺序：B(101) → C(102) → A(103)
```

A 失去了原本第一个的位置。如果系统并发频繁打满，A 可能永远抢不过 B/C 的新请求，**饿死**。

新版用原始 score 100 重入队：

```
现在队列顺序：A(100) → B(101) → C(102)
```

A 仍然是第一个，下一次有 permit 释放它最先拿到。这才是"公平"的语义。

### 8.5 第 7 步的"race 兜底"：为什么重入队后还要再检查 isPending

注释写得很明确："与 cancel/timeout 的 race：claimIfReady 已 ZREM，cleanup 的 remove 在此刻是 no-op；必须 add 后回查 state，若已终态则自行回滚，避免僵尸条目永久占据队头窗口"。

具体推演这个 race：

```
T=0  T1 线程: tryAcquireIfReady → claimIfReady 成功 → ZREM 了 reqA
T=1  T2 线程: ticket.cancel() → CAS 状态到 CANCELLED → cleanup()
T=2  T2 线程: queue.remove(reqA) → no-op（已被 T1 的 Lua 移走）
T=3  T2 线程: deleteEntryMarker(reqA) → 删了
T=4  T1 线程: tryAcquirePermit → null（permit 满）
T=5  T1 线程: setEntryMarker(reqA) → 又写回去了
T=6  T1 线程: queue.add(claimedScore, reqA) → 又加回 ZSET
```

如果到这里就结束，reqA 在 ZSET 里、entry 标记也在，但状态机已经是 CANCELLED——这就是**僵尸**，会永远占着队头窗口。

兜底就是第 322-325 行：

```java
if (!ticket.isPending()) {
    queue.remove(ticket.requestId);
    deleteEntryMarker(ticket.requestId);
}
```

重入队后立刻回查状态，如果发现已终态就自己再删掉。

**为什么不能简单地"先查状态再决定要不要重入队"？**

因为查状态和重入队之间还是有 race（同样的问题套娃）。正确做法是"**先做动作，再回查终态做补偿**"——这是分布式系统里非常常见的乐观策略。

### 8.6 第 8 步：grant 之前最后一次状态检查

```java
if (!ticket.isPending()) {
    releasePermitQuietly(permitId);
    publishQueueNotify();
    return false;
}
```

为什么 grant 之前还要再查一次？因为 `tryAcquirePermit()` 是一次 Redis 调用，从发出去到返回有几毫秒延迟。这几毫秒内 cancel 完全可能已经触发并完成 cleanup。

如果不查直接 grant，可能：

- ticket.grant() 内部的 CAS 会失败（状态不是 PENDING 了）
- grant 失败分支会释放 permit（CAS 路径 C）
- 看起来是正确的——**但是没有 publishQueueNotify**

第 8 步显式释放并 publish，比依赖 grant 失败分支更直接、消息也更明确。

### 8.7 第 10 步：grant 是最终交付动作

`ticket.grant(permitId)` 是整个 tryAcquireIfReady 唯一会把状态机推到 GRANTED 的地方。它返回 true 才代表这个 Ticket 真正进入执行阶段；返回 false 说明就在 grant 内部又被 cancel 抢了（race 极少），permit 已经被 grant 内部释放。

---

## 九、scheduleQueuePoll + PollNotifier 双轮驱动

### 9.1 scheduleQueuePoll

```java
private void scheduleQueuePoll(Ticket ticket) {
    int interval = Math.max(50, pollIntervalMsSupplier.getAsInt());
    Runnable poller = () -> {
        if (!ticket.isPending()) {
            ticket.unregisterFromNotifier();
            ticket.cancelFutureQuietly();
            return;
        }
        if (System.currentTimeMillis() > ticket.deadline) {
            ticket.timeout();
            return;
        }
        tryAcquireIfReady(ticket);
    };
    ticket.future = scheduler.scheduleAtFixedRate(poller, interval, interval, TimeUnit.MILLISECONDS);
    pollNotifier.register(ticket.requestId, poller);
}
```

**poller 的三段逻辑：**

1. 状态机已经离开 PENDING → 不用跑了，注销自己
2. 超过 deadline → 触发 timeout
3. 否则尝试 tryAcquireIfReady（再争一次）

**双重注册：**

- `scheduler.scheduleAtFixedRate(poller, 200ms)`：每 200ms 主动跑
- `pollNotifier.register(requestId, poller)`：让 Pub/Sub 通知也能触发 poller

### 9.2 PollNotifier.fire() 详解

你问"如果有节点 publish 或释放了，会触发所有 poll，这里的 poll 又是什么概念？"——回答：

**poller 就是上面那个 Runnable**。`PollNotifier` 维护了一个 `ConcurrentHashMap<requestId, Runnable poller>`，里面存的就是所有还在排队的 Ticket 的 poller。每次 Redis Topic 收到通知，本节点的 `fire()` 就把这个 map 里所有 poller 跑一遍：

```java
void fire() {
    pendingNotifications.incrementAndGet();
    if (!firing.compareAndSet(false, true)) {
        return;
    }
    executor.execute(() -> {
        do {
            pendingNotifications.set(0);
            try {
                if (permitSupplier.getAsInt() <= 0) {
                    break;                                  // 当前没 permit，扫了也白扫
                }
                for (Runnable poller : pollers.values()) {  // 把所有等待者各跑一次
                    try { poller.run(); }
                    catch (Exception ex) { log.debug("poller 执行异常", ex); }
                }
            } finally {
                firing.set(false);
            }
        } while (pendingNotifications.get() > 0 && firing.compareAndSet(false, true));
    });
}
```

**fire 的两层保护：**

1. **合并通知**：`firing` 是 AtomicBoolean，CAS 失败说明"已经有人在扫"，直接退出，不重复扫。短时间内连续到达的多个通知合并成一次扫描。
2. **不丢通知**：扫完一轮之后，看 `pendingNotifications` 有没有新值。有就再 CAS 一次开新一轮（do-while）。避免"扫描期间又来了新通知却被遗漏"。

`permitSupplier.getAsInt() <= 0` 的快速短路：如果当前一个 permit 都没有，扫了所有 poller 也都会失败（avail=0 直接 return false），不如直接跳过这一轮，等下一次有 release 的通知再扫。

### 9.3 为什么不在 Pub/Sub 回调里直接跑 poller

Redisson 的 `RTopic.addListener` 回调跑在 Redisson 的 Netty IO 线程上。如果在里面做 Redis 调用（Lua 脚本 / semaphore.tryAcquire），会阻塞 Netty 线程，导致整个 Redisson 客户端的 RPC 阻塞，影响所有其他 Redis 操作。

`PollNotifier.fire()` 把扫描动作转交给 `scheduler`（独立的 ScheduledThreadPoolExecutor，2-4 个线程），不占用 Netty。

---

## 十、Lua claim 脚本详解

```lua
-- KEYS[1]: 队列 ZSET Key
-- ARGV[1]: 请求 ID
-- ARGV[2]: 最大可进入的 rank（可用许可数）
-- ARGV[3]: entry 存活标记 Key 前缀

local queueKey = KEYS[1]
local requestId = ARGV[1]
local maxRank = tonumber(ARGV[2])
local entryPrefix = ARGV[3]

local slack = 16
local headEntries = redis.call('ZRANGE', queueKey, 0, maxRank + slack - 1)

local liveRank = -1
local liveCount = 0
for i = 1, #headEntries do
    local member = headEntries[i]
    if redis.call('EXISTS', entryPrefix .. member) == 1 then
        if member == requestId then
            liveRank = liveCount
        end
        liveCount = liveCount + 1
    else
        redis.call('ZREM', queueKey, member)         -- 顺手清理僵尸
    end
end

if liveRank < 0 or liveRank >= maxRank then return {0} end

local score = redis.call('ZSCORE', queueKey, requestId)
redis.call('ZREM', queueKey, requestId)
redis.call('DEL', entryPrefix .. requestId)
return {1, score}
```

**和旧版的核心区别：**

1. 旧版直接用 `ZRANK(requestId)` 看物理排名，僵尸条目也算在排名里
2. 新版**只数存活条目**，僵尸顺手 ZREM 掉

**slack=16 是什么：**

万一队头堆了 16 个僵尸，旧版按物理排名第 17 才算队头，本来排第 1 的存活条目永远排不上。新版扫描 `maxRank + slack = maxRank + 16` 个条目，一次性把僵尸全清掉，存活条目立刻顶上来。

**为什么僵尸清理放在 claim 路径里：**

懒清理（lazy cleanup）。不需要独立的扫尾任务，每次 claim 顺手清理一点。代价是 claim 多扫几个 Key，但 Redis 是单线程的，这点开销和"开一个独立的扫尾 cron 任务"比，简单很多。

---

## 十一、具体场景走查

为了把时间线写短，下面剧本使用示例配置：`globalMaxConcurrent=2`，`globalMaxWaitSeconds=3`。当前 checked-in 配置是 `10/15s`，机制相同。

### 11.1 剧本一：用户 C 排队、A 完成、C 顺利接位

| 时刻 | 节点 / 线程 | 动作 | Redis 状态变化 |
|------|-----------|------|---------------|
| T=0 | C 的 HTTP 线程 | 调 `enqueue` → `acquire(req)` | — |
| T=0 | 同上 | `new Ticket("C001")`，state=PENDING，deadline=T+3000ms | — |
| T=0 | 同上 | cancelBinder 把 ticket::cancel 挂到 emitter 三个回调 | — |
| T=0 | 同上 | `setEntryMarker("C001", 3000)` | `entry:C001=1, TTL=8s`（示例 3s + 5s buffer） |
| T=0 | 同上 | `nextQueueSeq()` → 101 | `queue:seq=101` |
| T=0 | 同上 | `queue.add(101, "C001")` | `queue: {seq=101→C001}` |
| T=0 | 同上 | `tryAcquireIfReady` → `availablePermits()=0` → false | — |
| T=0 | 同上 | `scheduleQueuePoll` 注册 200ms 周期任务 + PollNotifier | — |
| T=0 | 同上 | acquire 返回，HTTP 线程释放 | — |
| T=200 | scheduler-1 | 第一次 poller 跑，avail 仍为 0 | — |
| T=400/600 | scheduler-1 | 同上 | — |
| T=800 | A 的业务线程 | A 业务跑完，finally → `releaseHeldPermit()` | semaphore +1 |
| T=800 | 同上 | `release(permitId_A)` → `publish("permit_changed")` | Pub/Sub 广播 |
| T=801 | 所有节点 Netty | listener 触发 `pollNotifier.fire()` | — |
| T=801 | scheduler 池 | fire 提交扫描任务，遍历 pollers | — |
| T=801 | scheduler 池 | 看到 C001 的 poller，执行 | — |
| T=801 | 同上 | `tryAcquireIfReady`：avail=1 | — |
| T=801 | 同上 | `claimIfReady("C001", 1)` → Lua 执行 | — |
| T=801 | Redis Lua | ZRANGE 取 17 个，看到 C001（entry 存在）→ liveRank=0 < 1 → claim | `queue: {} ; entry:C001 删除` |
| T=801 | scheduler 池 | Lua 返回 `{1, 101}` | — |
| T=801 | 同上 | `tryAcquirePermit()` → 拿到 permitId="P3" | semaphore -1 |
| T=801 | 同上 | `ticket.isPending()` 仍为 true → publish | — |
| T=801 | 同上 | `ticket.grant("P3")`：permitRef.set + CAS 成功 → GRANTED | — |
| T=801 | 同上 | unregister + cancelFuture + 把 wrapped 提交到 chatEntryExecutor | — |
| T=801 | chatEntry-1 | 跑 onAcquired = `StreamChatPipeline.run()` | — |
| T=801+ | 同上 | 模型流式回调 → SSE 发 META → MESSAGE → ... | — |
| T=N | 同上 | 业务完成，finally → `releaseHeldPermit()` | semaphore +1, publish |

### 11.2 剧本二：C 排队时用户关页面（cancel race）

T=0~T=800 同剧本一。

| 时刻 | 节点 / 线程 | 动作 |
|------|-----------|------|
| T=850 | C 的浏览器 | 关页面，SSE 连接断开 |
| T=850 | Tomcat | 触发 `emitter.onCompletion(cancel)` → `ticket.cancel()` |
| T=850 | Tomcat 线程 | `state.compareAndSet(PENDING, CANCELLED)` → 成功 |
| T=850 | 同上 | `cleanup()`：queue.remove("C001") → 成功；deleteEntryMarker；state≠GRANTED，permitRef 为 null（没拿到过 permit）→ 不 release；publish；unregister；cancelFuture |
| T=850 | 同上 | cancel 返回，资源全部干净归还 |

**如果恰好和 grant 撞车（极端 race）：**

| 时刻 | 节点 / 线程 | 动作 |
|------|-----------|------|
| T=801.0 | scheduler 池 | tryAcquirePermit 已拿到 P3，正在 publishQueueNotify |
| T=801.1 | Tomcat 线程 | ticket.cancel() → CAS PENDING→CANCELLED 成功 |
| T=801.2 | Tomcat 线程 | cleanup：queue.remove no-op；state==CANCELLED 不动 permit（permitRef 还是 null，因为 grant 还没 set）；publish；unregister；cancelFuture |
| T=801.3 | scheduler 池 | 走到第 8 步 `if (!ticket.isPending())` → true → releasePermitQuietly(P3) + publish → return false |

最终 P3 被释放给下一个等待者。**没有泄漏**。

另一种 race 顺序：

| 时刻 | 节点 / 线程 | 动作 |
|------|-----------|------|
| T=801.0 | scheduler 池 | 已过第 8 步检查（isPending=true），进入 ticket.grant("P3") |
| T=801.1 | scheduler 池 | `permitRef.set("P3")` |
| T=801.2 | Tomcat 线程 | ticket.cancel() → CAS PENDING→CANCELLED 成功 |
| T=801.3 | Tomcat 线程 | cleanup：state==CANCELLED → permitRef.getAndSet(null) → "P3" → releasePermitQuietly(P3) + publish |
| T=801.4 | scheduler 池 | grant 内的 CAS PENDING→GRANTED → 失败 |
| T=801.5 | scheduler 池 | 走 grant 的 C 分支：`permitRef.compareAndSet("P3", null)` → 此时 permitRef 已经是 null → CAS 失败 → 不重复释放 |

permit 被 cancel 路径释放了一次，**grant 路径 CAS 不通过不会重复释放**。这就是注释里说的"CAS 防双重释放"。

### 11.3 剧本三：排队超时

T=0 入队同剧本一，但 A、B 都跑得很慢，permit 一直占着。

| 时刻 | 节点 / 线程 | 动作 |
|------|-----------|------|
| T=200/400/.../2800 | scheduler-1 | poller 每次跑，avail=0，无事发生 |
| T=3000 | scheduler-1 | poller 跑：`now > deadline` → `ticket.timeout()` |
| T=3000 | 同上 | CAS PENDING→TIMED_OUT 成功 |
| T=3000 | 同上 | `cleanup()`：queue.remove("C001") → true；删 entry；state≠GRANTED 但 permitRef==null 无 permit；publish；unregister；cancelFuture |
| T=3000 | 同上 | `submitSafely(req.onTimeout())` → 提交到 chatEntryExecutor |
| T=3001 | chatEntry-2 | 跑 `handleReject(question, conversationId, emitter)` |
| T=3001 | 同上 | recordRejectedConversation → memoryService.append(USER) + append(REJECT) |
| T=3001 | 同上 | sendRejectEvents → SSE 发 META + REJECT + FINISH + DONE → complete |

前端看到："系统繁忙，请稍后再试"。**用户的原始问题和拒绝回复也写入了对话历史**，刷新页面能看到。

### 11.4 剧本四：JVM 崩溃（自愈）

T=0 入队同剧本一。

| 时刻 | 动作 |
|------|------|
| T=100 | C 所在的节点 OOM，JVM 退出 |
| T=100+ | 没有任何 cancel/timeout/grant 执行 |
| T=100+ | Redis 里残留：`queue: {seq=101→C001}`，`entry:C001 TTL=约 7.9s`（示例配置） |
| T=200~7900 | 其他节点的 Lua 扫描时仍能看到 entry:C001 存在 → C001 还是会被算成"存活队头" |
| T=8000 | entry:C001 TTL 到期，Redis 自动 DEL |
| T=8100 | 其他节点下一次 Lua claim → `EXISTS entry:C001` 返回 0 → `ZREM C001` 当僵尸清掉 |
| T=8100+ | 队列自愈，下一个等待者顶上来 |

最坏情况下"自愈延迟" = `maxWaitMillis + ENTRY_TTL_BUFFER_MILLIS`。示例配置是 3s + 5s = 8s；当前 checked-in 配置是 15s + 5s，约 20s。

**permit 那一侧的自愈：** 如果崩的是已经 grant 的请求（持有 permit 的进程），permit 由 `leaseSeconds` 到期回收。当前 checked-in 配置是 30 秒；Java 兜底默认是 600 秒。这就是为什么 lease 时间是个 trade-off：太短会误回收正常长任务，太长会延长崩溃自愈时间。

---

## 十二、和"优惠券扣库存"模式的异同（你的对比）

你说"是不是先在 Redis 当中扣减，然后再异步落库"——回答：**思路有相通之处，但目标不同**。

| 维度 | 优惠券扣库存 | 本项目排队限流 |
|------|------------|---------------|
| 核心问题 | 库存不能超卖 | 并发不能超上限 |
| 资源性质 | 一次性（卖完就没） | 循环资源（用完归还） |
| 失败语义 | 抢光了，直接返回失败 | 抢光了，短暂等待，等不到再返回失败 |
| 落库时机 | Redis 扣减成功后异步落 MQ → DB | 不涉及落库（业务自己决定要不要落） |
| 公平性 | 通常不保证，看谁先到 Redis | **强保证**（全局 seq + 队头窗口） |
| Lua 脚本 | 检查库存 + 扣减 | 检查队头窗口 + 出队 + 清僵尸 |
| 释放路径 | 不释放（除非用户退款） | 必须释放（业务完成/异常/超时） |
| 状态机 | 通常不需要 | **必需**（三路 race） |

**最大的不同：** 优惠券是"扣了就完事"，本项目是"扣 → 用 → 还"的全周期管理。所以本项目的复杂度大部分来自"如何安全释放"——状态机、permitRef CAS、cleanup 幂等、Pub/Sub 唤醒等等，都是为了让"释放"这件事在任何 race 下都正确发生且只发生一次。

**相通的部分：** 都用 Redis Lua 解决"非原子操作组合的竞态"。在优惠券里是"读库存 + 写库存"，在这里是"查 rank + ZREM + 删 entry + 清僵尸"。把多步操作打包进 Lua，是 Redis 上做并发控制最经典的范式。

---

## 十三、SSE 事件协议（前后端契约）

| 事件 | 触发时机 | 数据 |
|------|---------|------|
| `meta` | `StreamChatEventHandler` 初始化时；当前发生在入队前 | `{conversationId, taskId}` |
| `message` | 模型流式回调到达 | `{type:"response"\|"think", content:"..."}` |
| `finish` | 生成正常完成 | `{messageId, title}` |
| `done` | SSE 连接终止信号 | `"[DONE]"` |
| `cancel` | 用户主动取消生成 | `{messageId, title}` |
| `reject` | 排队超时，本项目里就是被 Ticket.timeout 触发 | `{type:"response", content:"系统繁忙，请稍后再试"}` |

**注意：** 当前 `RAGChatServiceImpl` 在调用 `chatQueueLimiter.enqueue()` 之前就会创建 `StreamChatEventHandler`，构造函数里会立即发送一次 `meta` 并注册 `taskId`。因此正常排队期间前端已经能拿到会话与任务元信息，但不会收到 `message/finish/done`，直到拿到 permit 后才开始真正模型流式输出。拒绝路径会复用同一个 emitter 再发送一组 `meta → reject → finish → done`；这条拒绝 `meta` 的 `taskId` 是 `ChatQueueLimiter` 里重新生成的，可能和入队前那条 `meta` 不同。如果写历史失败，则至少发送 `done` 并关闭连接，避免前端一直挂起。

---

## 十四、设计亮点

| 设计点 | 说明 |
|--------|------|
| **Ticket 状态机** | 用一个 AtomicReference + CAS 把 grant/cancel/timeout 三条并发路径收敛成一条互斥的终态转移；业务回调最多触发一次 |
| **门面拆分** | `ChatQueueLimiter` 作为业务门面，`FairDistributedRateLimiter` 作为通用限流核心，两者解耦；后者可复用 |
| **Lua 原子 claim + 顺手清僵尸** | 一次 Lua 同时完成"算 live rank + ZREM 出队 + 删 entry + 清队头僵尸"，避免独立扫尾任务 |
| **Entry TTL 自愈** | 每个队列条目独立的存活标记，JVM 崩溃后 TTL 自然过期，Lua 在下次扫描时清掉 ZSET 残留 |
| **可过期信号量** | permit 有 lease，节点崩溃后 Redis 自动回收，不需要看门狗 |
| **原 score 重入队** | claim 成功但 permit 被抢时，按原始 score 重入队，保留排队位次，避免饿死 |
| **Pub/Sub + 周期轮询双轮驱动** | Pub/Sub 当快通道接近 0 延迟，200ms 轮询当慢通道兜底 |
| **PollNotifier 合并通知** | `firing` CAS + `pendingNotifications` 计数，短时间多次 publish 合并成一次扫描，避免风暴 |
| **permitRef CAS 双重释放保护** | grant 路径和 cleanup 路径都用 CAS 抢 permitRef，谁先成功谁释放 |
| **RejectedExecutionException 兜底** | 业务线程池满时不会泄漏 permit，显式降级走 timeout 路径 |
| **Consumer&lt;Runnable&gt; cancelBinder** | 依赖倒置，限流器不耦合 SseEmitter，可被任何流式入口复用 |
| **拒绝也写历史** | 排队超时的问答也写入会话历史，刷新页面有连续性 |

---

## 十五、设计缺陷与改进空间

| 缺陷 | 说明 | 改进方向 |
|------|------|---------|
| Redis 单点 | Redis 挂了限流系统整体不可用 | 增加本地 Semaphore 降级模式 |
| 无排队位置反馈 | 用户只知道在等，不知道排第几 | 可在 META 之前补一种"queue_position" 事件 |
| claim 与 acquire 非原子 | 可能 claim 成功但 permit 被抢 | 可用 Lua 整合"原子检查 ZSET + DECR semaphore counter"（但会失去 expirable lease） |
| 无用户级限流 | 只有全局并发，没有每用户 QPS | 加用户维度的滑动窗口计数器 |
| lease 需要按任务时长权衡 | 当前配置 30s，Java 兜底默认 600s；太短可能误回收长任务，太长会延长崩溃自愈时间 | 按线上 P99 生成耗时调整，必要时增加业务侧 renew |
| Lua slack=16 是硬编码 | 队头僵尸 > 16 时一次清不完 | 配置化或自适应 |

---

## 十六、面试高频追问预判

| 问题 | 回答要点 |
|------|---------|
| 为什么需要排队？只限流不行吗？ | 大模型慢但可以等几秒；短时排队比直接拒绝体验好 |
| 为什么用 ZSET 不用 List？ | ZSET 支持"查排名"（Lua 算 liveRank），List 只能 POP 头部 |
| Lua 脚本做了什么？ | 算 live rank + ZREM 出队 + 顺手清队头僵尸，三件事一次原子完成 |
| 为什么用可过期信号量？ | 节点崩溃后 lease 到期自动回收，普通 semaphore 会永久泄漏 |
| ENTRY 标记是干什么的？ | ZSET 成员的"存活证明"，TTL 到期后被 Lua 当僵尸清理 |
| 为什么 ENTRY 要先写、ZADD 后写？ | 反过来有 race 窗口：Lua 扫描可能误判刚入队的条目是僵尸 |
| 状态机为什么用 4 个状态？ | PENDING/GRANTED/TIMED_OUT/CANCELLED 覆盖所有终态，CAS 单点协调 |
| permitRef 为什么先 set 再 CAS state？ | 防止 CAS 成功后 cancel 看不到 permit；先 set 保证 cancel 路径能 CAS 出 permit |
| 为什么 cleanup 在 GRANTED 不释放 permit？ | permit 已被 try/finally 接管，跨界释放会导致并发超额 |
| Pub/Sub 起什么作用？ | 跨节点低延迟唤醒，节点 A release 后节点 B 立刻 fire poller |
| 为什么不能在 RTopic 回调里跑 poller？ | Netty IO 线程，跑 Redis 操作会阻塞整个 Redisson 客户端 |
| fire 的 do-while + CAS 有什么用？ | 通知合并 + 不丢通知：扫描期间到的新通知会再跑一轮 |
| claim 成功但 permit 失败怎么办？ | 用 claimedScore 原序号重入队，保留位次，避免饿死 |
| 重入队后为什么还要回查 state？ | 与 cancel 的 race：cancel 的 cleanup 可能在 claim 和重入队之间跑过，需要补偿删除 |
| permit 怎么保证只释放一次？ | `permitRef.getAndSet(null)` 原子操作；grant 和 cleanup 都用 CAS 抢 |
| Redis 挂了怎么办？ | 当前会卡住；可关闭 `globalEnabled` 降级 |
| 公平性怎么保证？ | 全局 AtomicLong 序号 + ZSET 排序 + Lua 只允许队头窗口 claim |
| 业务线程池满了怎么办？ | grant 内 catch RejectedExecutionException，显式 release + cleanup + onTimeout |
| SSE 事件有哪几种？ | meta/message/finish/done/cancel/reject 六种 |
| 排队期间用户关页面怎么清理？ | cancelBinder 把 ticket::cancel 挂到 emitter 三个回调，触发状态机 CANCELLED 路径 |
| 这套设计和优惠券扣库存有什么不同？ | 都用 Lua 解决竞态；本项目多了"循环资源 + 公平排队 + 安全释放"三层 |

---

## 十七、架构面试题（优先准备）

### Q1：让你从零设计一个保护大模型服务的限流方案，你会怎么拆？

**结论：**

至少分 5 层：

1. **建连层**（Controller）：建好 SSE 长连接，不做任何业务判断
2. **准入层**（AOP/门面）：决定这个请求是直接执行、排队等待还是直接拒绝
3. **分布式协调层**（FairDistributedRateLimiter + Redis）：管全局顺序、并发上限、跨节点唤醒
4. **业务执行层**（StreamChatPipeline）：真正调模型、回传内容
5. **回传层**（SSE 事件协议）：把"开始执行/拒绝/取消"明确告诉前端

**拆分动机：**

- Controller 不该知道排队，否则单元测试要 mock 整个 Redis
- 限流核心不该耦合 SseEmitter，否则无法在其他流式入口复用
- 业务执行不该感知 permit，否则到处都要写 try/finally

### Q2：为什么不能只用本地 Semaphore？

**结论：**

本地 Semaphore 只能保护单进程。多实例部署下：

- 每个实例独立限流 → 总并发会 = 实例数 × maxPermits，**不是真正的"全局上限"**
- 跨实例没法 FIFO，先到 A 的请求可能等很久，后到 B 的请求立刻拿到（不公平）
- 实例数变化时（扩容/缩容）总并发会跳变

Redis 是唯一足够轻量、能做"全局共享状态"的选择。MQ 太重（持久化语义不需要），网关层做不了流式任务的全生命周期管理。

### Q3：状态机为什么是单点 CAS，不直接用锁？

**结论：**

锁有三个问题：

1. **阻塞**：cancel 路径和 grant 路径互相等锁，可能阻塞 Tomcat HTTP 线程或 scheduler 线程
2. **死锁风险**：cleanup 内部还要 publish、unregister 等等，任何一处再申请别的锁都可能死锁
3. **可重入**问题难推理

CAS 是无锁的：所有路径都尝试 CAS 同一个 AtomicReference，胜出的负责后续动作，失败的直接 return。**没有阻塞、没有死锁、不需要可重入**。代价是要把所有状态相关的判断都收敛到一个 CAS 上——这正是"单 CAS 协调点"的设计目标。

### Q4：如果排队的请求数远超 maxPermits 会怎样？

**结论：**

队列长度本身没有上限（ZSET 理论上能放很多），但实际有三层自然约束：

1. **maxWaitMillis 超时**：排得太靠后的请求 N 秒后自己 timeout 出队，不会无限累积
2. **HTTP 连接超时**：服务端 `SseEmitter` 当前全局超时是 300000ms，客户端或代理也可能有自己的读超时；触发后会走 emitter 回调 → cancel → 出队
3. **服务端 Tomcat 连接数限制**：超过连接池上限，新请求根本到不了 enqueue 这一步

如果未来流量再涨，可以在准入层加一层"队列长度上限"（`queue.size() > N` 直接拒绝），避免 ZSET 无限增长导致 Redis 内存压力。

### Q5：选 Redis 的边界在哪？什么时候应该换方案？

**结论：**

当前 Redis 方案适用的前提：

- 等待时间是秒级（当前配置最长 15s，Java 兜底默认 20s）不是分钟级
- 队列规模可控（最多几百个 in-flight）
- 在线交互需要低延迟（毫秒级唤醒）

不适用的场景：

- 任务时长分钟级以上 → 改异步任务中心 + MQ
- 多租户配额隔离 → 网关层加用户维度限流
- 跨地域部署 → Redis 单集群不再适合，得用全局协调服务（etcd/zk）

演进方向：

1. **入口先粗粒度拦截**（网关层 IP/用户 QPS）
2. **准入层做细粒度配额**（按模型/租户分 permit 池）
3. **长任务改异步**（任务中心 + 状态查询）

---

## 十八、给自己的复习清单

读这套代码时按以下顺序，最容易抓住主线：

1. `RAGChatController.chat()` → SseEmitter 怎么返回
2. `RAGChatServiceImpl.streamChat()` → 业务包装成 onAcquire
3. `ChatQueueLimiter.enqueue()` → AcquireRequest 怎么构造、cancelBinder 怎么挂
4. `FairDistributedRateLimiter.acquire()` → 6 步主流程
5. `FairDistributedRateLimiter.Ticket` 状态机 → 4 个状态 + 3 条转移
6. `FairDistributedRateLimiter.tryAcquireIfReady()` → 10 步抢占核心
7. `queue_claim_atomic.lua` → liveRank 算法 + 僵尸清理
8. `FairDistributedRateLimiter.scheduleQueuePoll()` + `PollNotifier` → 双轮驱动
9. `FairDistributedRateLimiter.releaseHeldPermit()` + `cleanup()` → 幂等释放
10. `ChatQueueLimiter.handleReject()` → 拒绝写库 + SSE 拒绝事件
