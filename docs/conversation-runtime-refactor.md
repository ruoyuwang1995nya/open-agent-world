# Conversation 实时运行与消息投递重构说明

> **状态：待实现。** 本文是一份重构需求与验收说明，不代表下列功能已经实现。
> 本次文档 PR 不修改运行代码、数据库 schema 或插件接口。
> 下文保留提供的实施要求；其中的现状描述应在实现前按目标分支重新核对。

请对当前 `dev` 分支的 Open Agent World Conversation 系统做一次以运行体验、实时性和数据模型清晰度为目标的重构。

项目：
`https://github.com/theAfish/open-agent-world`
基于当前 `dev` 分支实现，不要脱离现有架构重新设计一套系统。

这次改造的核心原则是：

**Conversation 只负责长期有意义的对话历史；Run 负责一次 Agent 执行过程；WebSocket/Event 负责实时状态。不要把实时 UI 状态大量写入 durable conversation history。**

请先检查现有实现，尤其是：

- `frontend/src/cards/ConversationWorkspace.tsx`
- `frontend/src/state/useConversationTimeline.ts`
- `frontend/src/state/conversationActivity.ts`
- `frontend/src/api/client.ts`
- `backend/services.py`
- `backend/conversations/*`
- `backend/runs/*`
- `backend/agents/models.py`
- `plugins/codex/src/oaw_codex/runtime.py`

尽量复用现有 Run lifecycle、`run_id`、WebSocket events、`cancelRun()`、provider events、conversation timeline 等能力。

不要为了统一而删除已经正确工作的 provider-specific continuation/context 机制。

---

## 1. 分离 durable Conversation 与 live Run state

目前 Codex 等 runtime 在 streaming 时会不断产生中间文本。

例如真实 delta：

```text
"H"
"ello"
" world"
```

当前 runtime 会形成累计 snapshot：

```text
"H"
"Hello"
"Hello world"
```

这些 intermediate snapshot 不应该持续写入 Conversation DB。

重构后：

### Conversation durable history 只长期保存

- 用户消息
- Agent 最终完成后的 assistant message
- 必要的 system outcome message，例如 cancelled / failed / interrupted

不要将以下信息作为普通 ConversationMessage 高频持久化：

- token/delta streaming
- incomplete assistant snapshot
- reasoning/progress
- tool running state

最终目标：

```text
Provider
   ├── live events -> WebSocket -> frontend
   └── final result -> Conversation DB
```

Agent streaming output 应该主要属于 live Run state，而不是 unfinished ConversationMessage。

如果为了 reconnect/recovery 确实需要保留中间 output，可以使用 Run-level bounded checkpoint，例如：

```text
run.live_output
run.updated_at
```

并进行粗粒度更新，例如几秒一次或达到一定文本增量后更新。

不要每个 token / delta / full snapshot UPDATE SQLite。

如果当前需求不需要 refresh 后恢复半截回复，优先采用更简单的：

```text
stream -> WebSocket only
terminal -> persist final message
```

不要为了未来可能的需求提前增加复杂恢复机制。

---

## 2. 将 tool execution 从 ConversationMessage 中抽象成 Run Trace

现在 tool_started / tool_completed 会作为 conversation message 出现在 timeline 中。

这会让聊天记录越来越像 debug log。

重构为：

```text
Conversation
├── user message
└── final agent response

Run
├── lifecycle
├── progress
├── tool trace
└── live output
```

Tool execution 应属于 Run trace。

可以保留必要的 durable tool trace，用于：

- debug
- audit
- 查看 Agent 做过什么
- Run details
- execution history

但不要默认把每个 tool call 作为聊天消息平铺显示。

前端默认效果类似：

```text
Atlas
Worked for 32s · 5 tool calls ▸

最终回复……
```

展开后才显示类似：

```text
Read backend/services.py
Search assert_can_start
Read manager.py
...
```

tool arguments/results 默认折叠；大结果不要直接全部塞入主 DOM。

保留必要的数据安全/redaction 逻辑。

---

## 3. Conversation 正式显示 Active Run，并支持 Stop

目前 Conversation 已经能通过 runtime events 判断哪些 Agent 正在 responding，但主要只是显示 typing indicator。

请升级为真正的 Run surface。

Timeline / conversation state 应该能够获得：

```text
active_runs:
  - run_id
    agent_id
    status
    started_at
    awaiting?
```

不要只返回 `active_agent_ids`。

前端运行中显示类似：

```text
Atlas · Running
正在检查项目结构……
3 tool calls · Reading backend/services.py
[Stop]
```

这里不需要非常复杂的 UI，保持 Conversation 简洁。

Stop 必须绑定具体 `run_id`：

```text
worldApi.cancelRun(run_id)
```

不要使用 agent-level `stopAgent()` 代替，因为 Conversation 中停止的是**当前这一个 Run**，不是整个 Agent 的所有工作。

点击以后立即显示：

```text
Stopping…
```

收到 run cancelled 后更新状态。

复用现有：

- `RunManager.cancel_run`
- `/runs/{id}/cancel`
- run lifecycle events
- websocket refresh

不要重新实现第二套 cancellation 系统。

---

## 4. 增加 provider-neutral 的 Progress / Reasoning Summary

目前 runtime event 主要有：

- agent_message
- tool_started
- tool_completed
- completed
- error
- status

增加一个轻量 provider-neutral progress event，例如：

```text
agent_progress
```

payload 可以采用非常简单的形式：

```text
{
  kind: "status" | "plan" | "reasoning_summary",
  text: "正在定位 Conversation 的运行调度逻辑"
}
```

不同 runtime：

- 支持则发送
- 不支持则不发送

不要要求所有 plugin runtime 都必须提供 progress。

不要尝试保存或展示 raw hidden chain-of-thought。

对于支持 reasoning summary 的 provider，可以映射成 `reasoning_summary`。

前端显示类似：

```text
正在读取 Conversation 调度代码
找到 Run admission 限制
正在检查 cancellation API
```

默认只显示当前/latest progress。

详细历史可以放进 Run details，但不要让 reasoning/progress 淹没聊天记录。

默认 reasoning/progress 可以只通过 WebSocket/event plane 传输，不必写入 Conversation DB。

---

## 5. 支持 Agent 运行时继续发送消息，但不打断当前 Run

这是这次 UX 改造最重要的部分之一。

目标行为：

```text
User -> Run A starts
Agent is working on A

User sends B
User sends C

Run A continues unchanged

Run A finishes

Agent receives B/C
Next Run starts
```

用户在 Agent 正忙时，Conversation composer **不能被锁死**。

目前逻辑类似：

```text
post message
-> assert_can_start(agent)
-> save message
-> start_run
```

因此 busy Agent 会导致 message submission 被拒绝。

请改为：

```text
post message
-> persist user message immediately
-> create delivery for target Agent

if Agent idle:
    start Run
else:
    mark delivery queued
```

也就是说：

**message persistence 与 Agent admission 必须解耦。**

---

## 6. 增加轻量 per-Agent delivery queue

不要把 queue 做成一个新的通用 workflow/task engine。

它只是 Conversation message 到具体 Agent 的 delivery ledger。

建议最小模型类似：

```text
conversation_turn_queue

conversation_id
session_id
agent_id
message_id
status:
  queued
  claimed
  done
  cancelled

claimed_run_id?
enqueue_order
created_at
```

名称可以根据现有 store 风格调整。

一个 user message 如果 mention 多个 Agent，可以产生多个独立 delivery。

Agent Run terminal 后自动 drain 对应 queue。

必须保证：

- 一个 Agent 默认仍遵守现有 `max_concurrent_runs`
- queue 不绕过 RunManager concurrency
- delivery claim 必须避免 duplicate execution
- backend restart 后 queued message 不丢失
- terminal Run 不会重复 claim 同一个 delivery

尽量利用 SQLite transaction / existing store patterns 实现，不要额外引入 message broker。

---

## 7. 区分 UI 时间顺序与 Agent delivery/context 顺序

这是一个重要 correctness requirement。

例如真实 Conversation timeline：

```text
10:00 User: 做 A
10:01 User: 顺便不要修改 API
10:02 Agent: A 做完了
```

UI 必须仍然按真实发生时间展示：

```text
User A
User B
Assistant A
```

但如果 User B 是在 Run A 已经开始之后才发送的，那么 Agent 下一轮理解的逻辑必须是：

```text
User A
Assistant A
User B
```

不能让 Agent 误以为最终回答 A 已经考虑了 B。

因此不要简单地用 canonical Conversation message sequence 直接重新构造 provider context。

delivery queue 必须能够表达：

```text
message existed before Run A finished
但 delivery to Agent happens after Run A
```

请检查 OAW-managed context 和 plugin/provider-owned continuation 两条路径，保证这个语义成立。

不要为了这个问题完全替换现有 provider continuation。

---

## 8. 合并 queued burst，避免不必要的多次模型调用

如果 Agent 正忙时，用户连续发送：

```text
另外不要改 schema
测试也补一下
前端样式先不要动
```

Run A 结束以后，不要默认启动三个独立 Runs。

同一 Agent + session 当前等待的一批 queued deliveries，可以合并成一个 next turn。

例如：

```text
Additional messages received while you were working:

1. 另外不要改 schema
2. 测试也补一下
3. 前端样式先不要动
```

但：

- Conversation 中仍保持三条独立 user messages
- delivery ledger 仍知道哪些 message 被这个 Run consumed
- 不要修改用户原始消息内容

只在构造下一轮 input 时合并。

如果多个 Agent 被 mention，它们各自独立维护 delivery。

---

## 9. Frontend Conversation UX

Conversation 应该始终保持“聊天优先”，而不是 execution dashboard。

建议运行态：

```text
Atlas · Running                     [Stop]

正在检查后端消息调度……
▸ 4 tool calls
```

streaming assistant output 可以正常实时显示。

Run terminal 后自动压缩为：

```text
Atlas
▸ Worked for 38s · 4 tool calls

最终回答……
```

queued user message 可以有非常轻量的状态提示：

```text
Queued for Atlas
```

不要：

- 增加大量状态 badge
- 给普通用户展示 run_id
- 把每个 tool event 单独铺成 message
- 增加复杂 Run 管理 sidebar
- 增加新的用户配置项来控制这些默认行为

这应该是开箱即用的 Conversation 默认体验。

---

## 10. Streaming 性能

重点检查：

`plugins/codex/src/oaw_codex/runtime.py`

目前 `item/agentMessage/delta` 会累计：

```python
texts[item_id] += delta
```

随后向 host 发 full-text snapshot。

这个行为作为 UI snapshot 可以保留，但不要导致每次 snapshot 都持久化到 SQLite。

Frontend 应避免因为每个 token event：

- 重载完整 timeline
- REST refetch
- 重建全部 message DOM

优先：

```text
WebSocket live event
-> local Run state patch
```

而不是：

```text
WebSocket event
-> REST reload timeline
-> rerender history
```

Durable history 仍然以 REST 为 authoritative source。

Live Run state 是短生命周期的 overlay。

Run terminal 后再触发 durable timeline refresh。

如果需要对 streaming UI 更新进行 throttle，可以做轻量 requestAnimationFrame / ~50-100ms 合并，但不要增加复杂 buffering framework。

---

## 11. 保留现有 reconnect / repair 思路

当前 `useConversationTimeline` 已经采用：

- WebSocket healthy：event-driven
- slow repair poll
- WebSocket down：更快 REST repair

这套思路合理，不需要推翻。

新的 live Run state 应同样遵循：

```text
WebSocket = realtime
REST = durable truth / reconnect repair
```

不要把轮询频率继续提高。

---

## 12. Run terminal outcome

保持 Conversation 中 terminal outcome 明确可见。

成功：

```text
final assistant message
```

取消：

```text
Atlas's response was stopped.
```

失败：

```text
Atlas could not respond: ...
```

中断/restart：

明确提示 interrupted。

这些 terminal notices 可以 durable persist。

但不要 persist 大量 intermediate progress。

---

## 13. 数据模型边界

最终请尽量保持如下职责：

```text
Conversation
├── user messages             durable
├── final assistant messages durable
└── terminal notices         durable

Run
├── status                   durable
├── lifecycle                durable
├── tool trace               durable / bounded
├── delivery/message refs    durable
├── live output              ephemeral or coarse checkpoint
└── progress                 ephemeral

WebSocket/EventHub
├── text streaming
├── progress
├── tool activity
├── run status
└── queue status
```

不要把这些职责重新混在一张 ConversationMessage 表里。

---

## 14. Backward compatibility / plugin behavior

重点确认以下 runtime：

- OAW core / Google ADK
- Codex plugin
- mock/test runtimes

新的 progress event 应 optional。

一个旧 plugin 即使只实现：

```text
message
tool_started
tool_completed
completed
```

也必须正常工作。

不要要求第三方 plugin 为此次 Conversation UX 改造全部更新。

---

## 15. 测试

请补足至少以下测试。

Backend：

1. busy Agent 时用户消息仍然成功 durable persist
2. busy Agent 时不会启动第二个 Run
3. 当前 Run terminal 后自动 claim queued delivery
4. 连续 queued messages 被一个 next Run consume
5. queued delivery 不重复执行
6. cancellation 后 queue 可以继续 drain
7. backend restart 后 queued delivery 可恢复
8. multiple agents mention 时 delivery 独立
9. streaming snapshot 不再产生高频 Conversation DB writes
10. final assistant message 正确 durable persist
11. cancelled / failed Run outcome 正确

Frontend：

1. active Run 显示 Stop
2. Stop 调用 `cancelRun(run_id)` 而不是 `stopAgent`
3. Agent busy 时 composer 仍然可发送
4. queued message 正确显示
5. progress event 能实时更新
6. tool trace 默认折叠
7. final response 到达后 Run surface 正确结束
8. reconnect 后 REST 可以恢复 active run / queued 状态
9. live streaming 不导致整条 timeline 高频重新拉取

---

## 16. 实现约束

优先原则：

1. 复用已有 RunManager
2. 复用 EventHub/WebSocket
3. 复用现有 Conversation store
4. 新增最小 delivery queue
5. 不新增新的通用 scheduler/framework
6. 不引入 Redis/Kafka/message broker
7. 不增加用户配置复杂度
8. 不因为“未来可能需要”提前实现完整 replay/event sourcing
9. 不进行与这次目标无关的大规模重构

如果现有某个机制因为历史原因导致本次实现明显复杂，请优先判断它是否应该删除或简化，而不是继续叠加兼容层。

---

## 17. 开始实现前

先检查当前代码，并给出一个简短 implementation plan，明确：

- 哪些现有能力可以直接复用
- 哪些数据当前错误地属于 ConversationMessage
- queue 最小需要新增哪些 schema/state
- active run 如何通过 REST + WebSocket 暴露
- Codex streaming persistence 如何修改
- 哪些文件预计需要修改

然后直接实施。

完成后请给出：

1. 修改了什么
2. 关键数据流变化
3. schema / migration 变化
4. 对现有 plugin compatibility 的影响
5. 性能变化
6. 测试结果
7. 尚未解决但值得后续处理的问题

最终目标不是增加更多功能模块，而是让 Conversation 获得一种统一体验：

**Agent 工作时用户仍然可以继续交流；当前工作不会被新消息意外打断；用户能看到 Agent 正在做什么并可停止它；实时运行数据不会污染长期聊天记录；Run 结束后新的消息自然进入下一轮上下文。**
