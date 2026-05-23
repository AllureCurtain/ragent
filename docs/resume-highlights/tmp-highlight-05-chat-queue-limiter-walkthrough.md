# 临时梳理：亮点五与 ChatQueueLimiter 逐方法拆解

## 一、先给结论

亮点五讲的不是检索，也不是 Query Rewrite，而是：

> **如何在 SSE 流式聊天入口上做分布式排队限流，保护大模型调用并发，并把排队、拒绝、取消这些状态实时反馈给前端。**

所以它的关键词是：

- 分布式排队
- 并发限流
- 跨节点协调
- SSE 实时反馈
- 用户取消
- 资源释放

对应主角代码是：

- `bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/aop/ChatQueueLimiter.java`

## 二、highlight-05 文档整体对不对

整体判断：**主线是对的，核心设计没有写偏。**

文档里这些点是准确的：

1. 用 Redis `ZSET + Lua + RPermitExpirableSemaphore + Pub/Sub` 做分布式排队限流。
2. 入口就是 SSE 聊天接口 `/rag/v3/chat`。
3. `claim` 成功但没拿到 permit 时，会重新入队。
4. 跨节点取消用的是 `RTopic + RBucket` 双保险。
5. SSE 事件类型确实是 `meta / message / finish / done / cancel / reject`。

但有几个地方要记成更精确的版本：

### 2.1 排队阶段前端其实还没有 taskId

`META` 事件不是一入队就发，而是**真正进入业务 `streamChat()` 之后**，`StreamChatEventHandler.initialize()` 才发。

这意味着：

- 排队中的请求，前端还拿不到 `taskId`
- 因此也不能在排队阶段调用 `/rag/v3/stop?taskId=xxx`
- 排队阶段如果用户关闭页面，主要靠 `emitter.onCompletion/onTimeout/onError` 触发资源释放

### 2.2 Lua 脚本返回了 score，但当前实现没有拿它恢复原位置

Lua 脚本会返回原始 `score`，但当前 Java 实现重新入队时，申请的是**新的 seq**，所以会排到队尾，不会回到原位置。

### 2.3 “重入队排到队尾”不是插队，而是掉队

更准确地说是：

- 这条请求丢失了原始排队位置
- 然后被重新放到队尾

不是插队，而是相反。

### 2.4 Controller 创建了 SseEmitter，但真正业务不会立即执行

Controller 只是把连接先建立好。

真正的业务方法 `streamChat()` 因为有 `@ChatRateLimit`，会被切面拦截，必须等排队系统拿到 permit 后才会执行。

---

## 三、代码地图

按这几个文件看，逻辑最清楚：

1. `bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/controller/RAGChatController.java`
2. `bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/service/impl/RAGChatServiceImpl.java`
3. `bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/aop/ChatRateLimitAspect.java`
4. `bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/aop/ChatQueueLimiter.java`
5. `bootstrap/src/main/resources/lua/queue_claim_atomic.lua`
6. `bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/service/handler/StreamChatEventHandler.java`
7. `bootstrap/src/main/java/com/nageoffer/ai/ragent/rag/service/handler/StreamTaskManager.java`
8. `framework/src/main/java/com/nageoffer/ai/ragent/framework/web/SseEmitterSender.java`

---

## 四、完整流程先过一遍

### 4.1 请求从哪里进来

入口在：

- `RAGChatController.chat()`

这个方法做的事很简单：

1. 创建一个 `SseEmitter(0L)`，表示连接默认不超时
2. 调用 `ragChatService.streamChat(...)`
3. 把 `emitter` 返回给前端

也就是说，Controller 负责的是：

> **先把 SSE 通道搭起来。**

它不负责排队和限流。

### 4.2 为什么会进排队限流

因为 `RAGChatServiceImpl.streamChat()` 上挂了：

- `@ChatRateLimit`

所以真正执行前会先进：

- `ChatRateLimitAspect.limitStreamChat()`

切面做的事情是：

1. 拿到 `question / conversationId / emitter`
2. 把真正业务执行包装成一个 `Runnable onAcquire`
3. 调 `chatQueueLimiter.enqueue(...)`
4. 当前方法直接返回 `null`

注意这里的本质：

> **业务代码没有立刻执行，而是变成了“拿到 permit 以后再执行”的回调。**

### 4.3 真正的排队入口

在：

- `ChatQueueLimiter.enqueue(...)`

它的逻辑分五段：

1. 开关关闭 -> 直接执行 `onAcquire`
2. 生成 `requestId`，用 `RAtomicLong` 拿全局递增 `seq`
3. `queue.add(seq, requestId)` 加入 Redis ZSET 队列
4. 注册 `emitter.onCompletion/onTimeout/onError` 的释放回调
5. 先走一次快速路径 `tryAcquireIfReady()`，失败再进入排队轮询

### 4.4 什么叫快速路径

`tryAcquireIfReady()` 会做三件事：

1. 看现在还有没有可用 permit
2. 用 Lua 做原子 claim
3. 尝试拿 expirable semaphore 的 permit

三步都成功，才真正执行 `onAcquire`。

### 4.5 什么叫排队轮询

如果快速路径失败，就会进：

- `scheduleQueuePoll(...)`

它做的事情是：

1. 计算超时时间 `deadline`
2. 每隔 `pollIntervalMs` 执行一次 poller
3. 同时把 poller 注册到 `PollNotifier`

poller 每次只做三件事：

1. 已取消 -> 停止
2. 已超时 -> 出队，写拒绝会话，发 `REJECT`
3. 再次尝试 `tryAcquireIfReady()`

### 4.6 permit 释放后为什么不是纯轮询

因为纯轮询延迟高。

所以每次 permit 释放或队列状态变化时，都会：

- `publishQueueNotify()`

然后各节点订阅到消息后：

- `PollNotifier.fire()`

它会立刻触发所有已注册 poller 再试一次。

这里是：

> **轮询兜底 + Pub/Sub 降低等待延迟**

### 4.7 真正拿到执行权后去哪儿了

一旦 `tryAcquireIfReady()` 成功，就会：

- `chatEntryExecutor.execute(() -> runOnAcquire(onAcquire))`

而 `onAcquire` 本质上又会回到切面里，用反射执行原始的：

- `RAGChatServiceImpl.streamChat()`

所以从逻辑上说：

- 前面那一大段还只是“获得执行资格”
- 到这里才是真正开始跑聊天业务

### 4.8 真正开始流式回答后，SSE 事件在哪里发

`RAGChatServiceImpl.streamChat()` 一开始会创建：

- `StreamChatEventHandler`

这个 handler 构造时会：

1. 先发 `META`
2. 把任务注册进 `StreamTaskManager`

之后模型流式回调进来时：

- `onThinking()` -> 发 `MESSAGE(type=think)`
- `onContent()` -> 发 `MESSAGE(type=response)`
- `onComplete()` -> 落库，发 `FINISH` 和 `DONE`
- `onError()` -> 注销任务并关闭连接

### 4.9 用户取消是怎么生效的

前端点停止后会调：

- `/rag/v3/stop?taskId=xxx`

后台进：

- `StreamTaskManager.cancel(taskId)`

它会：

1. 先写 `RBucket(cancelKey)=true`
2. 再发 `RTopic(cancelTopic)`

本地或其他节点收到消息后：

- `cancelLocal(taskId)`

然后：

1. `handle.cancel()`
2. 发 `CANCEL`
3. 发 `DONE`
4. `sender.complete()`

后面连接完成后，又会回到 `ChatQueueLimiter` 之前注册的 `releaseOnce`，把 permit 释放掉。

---

## 五、ChatQueueLimiter 逐方法拆解

下面只讲 `ChatQueueLimiter` 这个类。

### 5.1 成员字段和这几个常量在干什么

关键常量：

- `SEMAPHORE_NAME = "rag:global:chat"`
- `QUEUE_KEY = "rag:global:chat:queue"`
- `QUEUE_SEQ_KEY = "rag:global:chat:queue:seq"`
- `NOTIFY_TOPIC = "rag:global:chat:queue:notify"`
- `CLAIM_LUA_PATH = "lua/queue_claim_atomic.lua"`

关键依赖：

- `RedissonClient`：操作 Redis
- `RAGRateLimitProperties`：限流配置
- `ConversationMemoryService`：排队超时后写会话
- `ConversationGroupService`：补标题
- `chatEntryExecutor`：拿到 permit 后真正执行业务

关键状态：

- `claimLua`：启动时读取 Lua 脚本内容
- `scheduler`：排队轮询定时器
- `pollNotifier`：Pub/Sub 唤醒器
- `notifyListenerId`：Redis topic 监听器 ID

这一层主要是把“排队、限流、通知、拒绝写会话”这些能力聚合在一个类里。

### 5.2 `subscribeQueueNotify()`

作用：

1. 创建 `PollNotifier`
2. 启动过期 poller 清理任务
3. 订阅 Redis topic
4. 收到通知后调用 `pollNotifier.fire()`

这一步是在 Bean 初始化后执行的。

它解决的问题是：

> **某个节点释放了 permit，其他节点上排队的请求也能立刻被唤醒重试。**

如果没有这个订阅，所有排队请求都只能靠固定轮询间隔慢慢等。

### 5.3 `enqueue(String question, String conversationId, SseEmitter emitter, Runnable onAcquire)`

这是整个类最核心的入口方法。

它的职责是：

1. 决定这次请求要不要限流
2. 如果要限流，就让它进入排队系统
3. 如果已经满足执行条件，就尽快放行

执行顺序如下：

#### 第一步：看开关

如果 `globalEnabled=false`，直接：

- `chatEntryExecutor.execute(onAcquire)`

这表示完全绕过排队限流。

#### 第二步：生成排队身份

这里会生成：

- `requestId`
- `seq`

然后执行：

- `queue.add(seq, requestId)`

这一步真正把请求放进 Redis ZSET。

#### 第三步：注册释放回调 `releaseOnce`

这是一个非常关键的闭环回调。

它会：

1. `cancelled.set(true)`
2. `queue.remove(requestId)`
3. `permitRef.getAndSet(null)` 拿出 permitId
4. 如果 permitId 不为空，就 `release(permitId)` 并 `publishQueueNotify()`

然后把它绑到：

- `emitter.onCompletion`
- `emitter.onTimeout`
- `emitter.onError`

这里要注意：

> **SSE 连接结束，不管是正常完成、异常还是超时，排队和 permit 资源都要收回。**

#### 第四步：先试快速路径

调用：

- `tryAcquireIfReady(...)`

如果成功，就不需要排队轮询，直接返回。

#### 第五步：快速路径失败，进入轮询

调用：

- `scheduleQueuePoll(...)`

这时请求进入“队列等待区”。

### 5.4 `scheduleQueuePoll(...)`

这个方法负责“真正排队等待”。

它会先算两个东西：

1. `deadline`：最大等待时间
2. `intervalMs`：轮询间隔，最少 50ms

然后构造一个 `poller`。

poller 每次跑的逻辑非常明确：

1. 如果 `cancelled=true`  
   -> 注销 poller，停掉 future

2. 如果当前时间已经超过 `deadline`  
   -> 从队列移除  
   -> 通知其他节点  
   -> 注销 poller  
   -> 记录拒绝会话  
   -> 给前端发 `REJECT`

3. 否则再次调用 `tryAcquireIfReady(...)`  
   -> 成功就注销并停止轮询

这里有一个实现细节：

- `futureRef[0]` 是为了让 poller 自己能够取消自己的定时任务

这是 Java 里典型的“回调里要拿 future，所以用数组包一层引用”的写法。

### 5.5 `tryAcquireIfReady(...)`

这是整个系统里最重要的方法。

它是在判断：

> **这条请求现在能不能从排队态进入真正执行态。**

执行顺序如下。

#### 第一步：如果已经 cancelled，直接失败

避免无意义继续尝试。

#### 第二步：看当前还剩多少 permit

调用：

- `availablePermits()`

如果没有剩余 permit，就直接返回 false。

#### 第三步：Lua 原子 claim

调用：

- `claimIfReady(queue, requestId, availablePermits)`

只有当请求在“队头窗口”里时，claim 才会成功。

什么叫队头窗口？

例如：

- 当前可用 permit = 3

那么只有 rank 为 `0、1、2` 的请求才有资格 claim。  
rank 为 `3` 或后面的请求，即使排在前面，也还不能动。

#### 第四步：拿 permit

调用：

- `tryAcquirePermit()`

如果没拿到 permit，当前代码会：

1. 申请一个新的 `seq`
2. 重新 `queue.add(newSeq, requestId)`
3. `publishQueueNotify()`
4. 返回 false

这是整个类最关键的边界处理之一。

原因是：

- Lua claim 和 semaphore acquire 不是原子操作
- 两个请求可能都 claim 成功
- 但只有一个最终拿到了 permit

没拿到 permit 的那个必须重新入队，否则就会丢请求。

要注意：

> 当前实现重新入队是**排到队尾**，不是回到原来的位置。

#### 第五步：把 permitId 放进 `permitRef`

后面释放资源时要用。

#### 第六步：如果此时已经 cancelled

说明在“拿到 permit”这一瞬间，请求又被关闭了。  
这时会立刻：

- `releasePermit(permitId, permitRef)`

然后返回 false。

这是另一个很好的细节：

> **拿到 permit 不代表就一定能执行，中间还要再看一眼请求是否已经被取消。**

#### 第七步：通知其他节点并执行真正业务

先：

- `publishQueueNotify()`

这是因为当前请求已经从排队态进入执行态，队列前面的窗口发生了变化，其他排队请求可以重试。

然后：

- `chatEntryExecutor.execute(() -> runOnAcquire(onAcquire))`

如果提交线程池失败，还会：

1. 释放 permit
2. 未取消就重新入队
3. 打日志

这又是一层补偿逻辑。

### 5.6 `tryAcquirePermit()`

作用是从 Redis 的可过期信号量里拿一个 permit。

它会先：

- `trySetPermits(globalMaxConcurrent)`

然后：

- `tryAcquire(0, leaseSeconds, TimeUnit.SECONDS)`

关键点有两个：

1. `trySetPermits()` 每次都调用，是为了 Redis 重启后自愈；它本身是幂等的。
2. 用的是 `RPermitExpirableSemaphore`，不是普通 semaphore。

为什么是 expirable semaphore？

因为普通 semaphore 一旦持有者崩溃，permit 容易永久泄漏；  
而 expirable semaphore 的 permit 自带 lease，到期 Redis 会自动回收。

### 5.7 `availablePermits()`

作用很单一：

1. 同样先 `trySetPermits()`
2. 再返回当前可用 permit 数

它本质上是 `tryAcquireIfReady()` 的前置判断。

这一步虽然简单，但很重要，因为它决定了当前“队头窗口”的大小。

### 5.8 `claimIfReady(...)`

作用是调用 Lua 脚本执行原子 claim。

它内部做的事：

1. 用 `RScript.eval()` 执行 `claimLua`
2. 传入：
   - 队列 key
   - requestId
   - availablePermits
3. 解析返回值

返回结果会被封装成：

- `ClaimResult(claimed, score)`

注意：

- `score` 当前只是在结果里保留下来了
- 当前 Java 逻辑没有拿它做原位置重入队

所以它更像是“为未来扩展保留了信息”。

### 5.9 `parseLong(Object value)`

小工具方法。

作用：

- 兼容 Lua 返回值可能是 Number，也可能是 String
- 统一解析成 long

它不是业务难点，只是脚本结果解析的兼容层。

### 5.10 `nextQueueSeq()`

作用：

- 通过 Redis `RAtomicLong` 全局自增，生成排队序号

这是公平排队的基础。

因为是 Redis 上的全局序号，所以多节点情况下也能保持统一顺序，不会每台机器各排各的。

### 5.11 `cancelFuture(ScheduledFuture<?> future)`

作用：

- 停掉轮询定时任务

它只是对 `future.cancel(false)` 的小封装。

### 5.12 `publishQueueNotify()`

作用：

- 往 `rag:global:chat:queue:notify` topic 发一条固定消息 `"permit_released"`

这里名字虽然叫 `permit_released`，但实际用途不只是在 release permit 时通知。

当前代码里以下场景也会调用它：

1. permit 释放后
2. 排队超时出队后
3. 成功拿到 permit 后
4. claim 成功但 permit 失败、重新入队后

它本质上表示的不是“permit 一定释放了”，而是：

> **队列或执行窗口状态发生了变化，大家可以再试一次。**

### 5.13 `recordRejectedConversation(...)`

这个方法负责排队超时后的“业务补偿”。

它会做这些事：

1. 如果没 userId，尝试从 Sa-Token 再拿一次
2. 确定实际 `conversationId`
3. 判断是不是新会话
4. 把用户问题写入 memory
5. 把 assistant 的拒绝消息 `"系统繁忙，请稍后再试"` 也写入 memory
6. 补一个标题
7. 返回 `RejectedContext`

这一步的意义是：

> **即使请求没真正进模型，用户的问题和系统拒绝结果也能在会话里看见。**

这比单纯前端弹个错误要更完整。

### 5.14 `resolveTitle(...)`

作用：

- 从 `ConversationGroupService` 里查当前会话标题

只是 `recordRejectedConversation()` 的小辅助方法。

### 5.15 `buildFallbackTitle(...)`

作用：

- 如果会话标题还没生成出来，就用用户问题截断一个默认标题

它依赖 `memoryProperties.getTitleMaxLength()`。

### 5.16 `sendRejectEvents(SseEmitter emitter, RejectedContext rejectedContext)`

这是排队超时后真正往前端发 SSE 的地方。

它会构造一个新的 `SseEmitterSender`，然后按顺序发：

1. `META`
2. `REJECT`
3. `FINISH`
4. `DONE`
5. `complete()`

这里有两个要点：

1. 被拒绝的请求也会有完整事件协议，不是直接断连接。
2. 这里发的 `taskId` 是新生成的 reject taskId，不是实际执行过模型的任务 taskId。

### 5.17 `releasePermit(String permitId, AtomicReference<String> permitRef)`

这个方法负责安全释放 permit。

它先做：

- `permitRef.compareAndSet(permitId, null)`

只有 CAS 成功，才真的：

- `release(permitId)`
- `publishQueueNotify()`

这个设计的作用是：

> **防止同一个 permit 被重复释放。**

这也是整个类里 exactly-once 语义的一个体现。

### 5.18 `loadLuaScript()`

作用：

- 从 classpath 加载 `lua/queue_claim_atomic.lua`

启动时如果读不到，直接抛异常，说明这套排队机制无法正常工作。

### 5.19 `runOnAcquire(Runnable onAcquire)`

这个方法很简单：

- 执行 `onAcquire`
- 捕获异常并打日志

它的存在主要是给线程池回调再包一层防护，避免异常直接炸出线程池边界。

### 5.20 `resolveUserId()`

作用：

1. 先从 `UserContext` 取 userId
2. 如果没有，再尝试 `StpUtil.getLoginIdAsString()`
3. 都拿不到就返回 null

这个 userId 主要用于排队超时写会话时补全上下文。

### 5.21 `shutdown()`

Bean 销毁时做清理：

1. 移除 Redis topic 监听
2. 关闭 scheduler
3. 等待 scheduler 结束
4. 关闭 `pollNotifier`

这是避免应用停机时残留后台线程。

### 5.22 `awaitSchedulerShutdown()`

小工具方法。

作用：

- 优雅等待 scheduler 结束
- 超时就 `shutdownNow()`

### 5.23 内部类 `PollNotifier`

这个内部类是第五点另一个很重要的实现点。

它的职责是：

> **把 Redis Pub/Sub 通知转成“本节点所有排队请求的重试动作”。**

#### 5.23.1 字段在干什么

- `permitSupplier`：查询当前还有没有 permit
- `notifyExecutor`：专门跑通知回调，避免阻塞 Redis 回调线程
- `pollers`：保存当前所有注册的 poller
- `firing`：防止并发 fire 重入
- `cleanupExecutor`：定时清理长时间没注销的 poller
- `pendingNotifications`：合并短时间内的多个通知

#### 5.23.2 `register(requestId, poller)`

作用：

- 把一个排队请求的 poller 注册进去

这样 Pub/Sub 来消息时，它才知道该唤醒哪些等待者。

#### 5.23.3 `unregister(requestId)`

作用：

- 把请求对应的 poller 从表里删掉

在这些场景会调用：

- 请求拿到执行权
- 请求超时
- 请求取消

#### 5.23.4 `fire()`

这是 `PollNotifier` 里最难的一个方法。

它解决两个目标：

1. 多个通知不要重复无意义遍历
2. 不能丢通知

它的执行逻辑是：

1. `pendingNotifications.incrementAndGet()`
2. 如果已经有人在 firing，就直接返回
3. 否则提交到 `notifyExecutor`
4. 在执行线程里：
   - 先把 `pendingNotifications` 清零
   - 如果当前没有 permit，直接继续下一轮判断
   - 有 permit 才遍历所有 poller 执行
5. 最后如果遍历过程中又来了新通知，就再跑一轮

这段 `do-while + CAS` 的意义就是：

> **把多个通知合并起来，但又不吞掉后来者。**

#### 5.23.5 `shutdown()`

作用：

1. 停掉 cleanup 和 notify 两个线程池
2. 等待结束
3. 清空所有 poller

#### 5.23.6 `awaitExecutorShutdown(...)`

小工具方法。

和外层的 `awaitSchedulerShutdown()` 是同一个目的：

- 优雅关闭
- 超时强停

#### 5.23.7 `startCleanup()`

作用：

- 每分钟清理一次注册超过 5 分钟的 poller

这不是正常路径的一部分，而是防泄漏措施。

说明作者考虑过“异常情况下 poller 没正常注销”的脏状态。

---

## 六、第五点里最值得掌握的 6 个难点

1. **为什么要 AOP 包 `streamChat()`**
   - 因为业务必须延迟到“拿到 permit 后”再执行

2. **为什么要 ZSET + Lua**
   - 因为要原子完成“查排名 + 出队”

3. **为什么 claim 成功还可能失败**
   - 因为 claim 和 permit acquire 不是原子操作

4. **为什么必须是可过期信号量**
   - 防 permit 泄漏，保证崩溃自愈

5. **为什么要 Pub/Sub + 轮询双保险**
   - Pub/Sub 降低延迟，轮询负责兜底

6. **为什么取消要 Topic + Bucket**
   - 解决任务注册和取消消息之间的时序竞争

---

## 七、你接下来应该怎么对着代码看

如果你现在要真正读明白，我建议严格按下面顺序跳：

1. `RAGChatController.chat()`
2. `RAGChatServiceImpl.streamChat()`
3. `ChatRateLimitAspect.limitStreamChat()`
4. `ChatQueueLimiter.enqueue()`
5. `ChatQueueLimiter.tryAcquireIfReady()`
6. `queue_claim_atomic.lua`
7. `ChatQueueLimiter.scheduleQueuePoll()`
8. `ChatQueueLimiter.PollNotifier.fire()`
9. `StreamChatEventHandler.initialize()/onContent()/onComplete()`
10. `StreamTaskManager.cancel()/cancelLocal()`

按这个顺序看，你会一直处在“一个请求真实流转”的视角里，不容易散。
