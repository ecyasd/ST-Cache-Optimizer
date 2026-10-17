# Izumi 1016 与 shujuku 适配记录

用户关心同一角色卡、世界书与预设下，连续增加楼层并发送不同内容时的缓存表现。目前尚未取得可确认“真实 API 缓存始终为 0”的请求与响应证据。重复发送相同楼层的相同请求只能证明服务端能够复用重复请求，不能证明连续对话已稳定前缀。

源码审查基线：[缓存插件 bc7be9d](https://github.com/pzwtxdy831-commits/ST-Cache-Optimizer/tree/bc7be9d2e01a3bfe2fc54226acc3401e0a9e98db)、[shujuku 85eaa78](https://github.com/AlbusKen/shujuku/tree/85eaa78ab6908adc84a2ef5c5278f25e8d296317)。

用户使用的流程是：数据库辅助模型先处理输入、召回纪要词条，再由 Vertex 的 `gemini-4-argon` 生成正文。辅助模型不是正文模型，两类请求必须分开比较；召回结果每轮可能变化，也不能由此断言所有数据表每轮都会更新。

用户随后明确不使用泉的记忆功能。因此下文关于 `IZM7` 的内容仅是可选功能的静态审计证据，不作为本次实际使用的故障原因；本版 `compatIzumi` 默认关闭。普通 Izumi 预设和数据库召回仍按各自实际来源处理。

本次只读审查了用户提供的 `Izumi 1016.json`，未执行其中的脚本，也未修改原文件。它包含 232 个 prompt，当前顺序启用 61 个；启用项没有 `injection_position=1` 的深度注入。名为“测试1”“测试2”的深度注入条目均已禁用，不能据此判断用户正在使用测试配置。实际角色卡、关联世界书、浏览器运行时开关和最终请求仍需另外核对。

## 预设中会变化的位置

- `nsfw` / “信息结束”，顺序索引 129：`<Master_input>` 内使用 `{{lastUserMessage}}`。它在 `chatHistory`（127）之后，原本已经位于尾部。
- `f2bd9e18-e94f-401a-9fec-a96f03b72f6a` / “🌏Izumi世界系统”，索引 130：`<customfunction>` 中包含当前 token 数和当前目录。脚本用 `IZW7_izumi_world_next_<实例 UUID>_<每轮 epoch>` 替换目录占位符，这一段原本也在历史后面。
- 已启用的“泉此方悬浮窗”脚本会将当前聊天记忆投影为原生世界书条目，`position=1`、`order=999`、`role=0`。在此预设中它可经 `worldInfoAfter`（122）进入历史前面。正文形状为 `<!-- IZM7_izumi_world_next_<实例 UUID>_<每轮 epoch> -->`，紧接完整的 `<KonataExtraInformation>…</KonataExtraInformation>`。即使记忆文字相同，每轮 epoch 也会变化；这是需要处理的早期动态内容。
- 多数 `setvar/getvar` 用来组装固定规则，启用状态不变时通常稳定。宏的存在本身不能证明每轮变化，应比较渲染后的请求。
- 可选 Advice 功能会将用户输入搬到上一条 assistant 的 `<advice>`，并把当前 user 改成固定句；可选关键词处理还可能按楼层阈值改变处理范围。两项代码默认关闭，实际设置保存在浏览器中，不能只根据导出文件推断。按深度运行的正则也可能让历史消息在经过阈值时改变。

## 兼容约束

旧有的“只检查 system”策略看不到其他角色中的数据库注入；反过来，把所有 user/assistant 都当成动态内容也不安全。Izumi 的“🔴指南”是固定的 user 预设消息，“接”“创意加强2”“神秘”等含固定 assistant 伪对话；这些角色和相对语义需要保留。shujuku 生成的数据库快照应按明确的来源及边界识别，不能把正常聊天里提到数据库的文字一起搬走。

shujuku 的内部条目可带 `ACU-[…]-` 前缀，去掉该前缀后的名字为 `TavernDB-ACU-*`、`重要人物条目*`、`总结条目*`、`小总结条目*`。应排除 `TavernDB-ACU-AgentGreenlight`，以及没有所有权标记的“外部导入-”条目。自定义表导出用 `<!-- ACU_CUSTOM_TABLE_EXPORT_V1 {…} -->` 记录版本、`kind: custom_table_export`、表名和 `role` 等元数据；不能仅凭正文中出现表格就判定来源。动态 constant 条目及召回结果可能在固定世界书位置进入正文请求的前部。

`IZM7` 和 `IZW7` 是预设脚本的授权凭据。脚本在 `CHAT_COMPLETION_SETTINGS_READY` 最后验证完整正文、每轮标记恰好一次及 `system` 角色；失败时会撤下相关正文。不要删除、改名、稳定化标记，或把它们改成 user/assistant。若调整位置，必须完整保留授权块及角色，并验证脚本的最终授权仍成功。仅匹配 `<KonataExtraInformation>` 不足以证明来源，因为预设说明本身也提及这个标签。

世界系统先注册目录放置监听，再注册 Advice / 关键词处理，最后重新绑定授权监听；它还处理 `CHAT_COMPLETION_PROMPT_READY` 和 `GENERATE_AFTER_DATA`。其他扩展若在优化后再次改写请求，前缀仍可能变化，因此诊断需要覆盖尽可能靠近发送的阶段，并标明观察阶段。

shujuku 在 `CHAT_COMPLETION_SETTINGS_READY` 使用 `makeLast`，还会处理 `db/sql/if/random` 模板及追加 `finalPrompts`。仅观察较早的 `CHAT_COMPLETION_PROMPT_READY` 无法证明最终正文请求稳定。网络旁观通常只能覆盖当前页面经 `window.fetch` 发往宿主的请求；其他传输和不受当前页面控制的链路不能保证覆盖。不要把未观察到响应当成缓存为零。

用户描述对应的普通 LLM 时间召回先在 `GENERATION_AFTER_COMMANDS` 生成 `<recall>` 中的 `AMxxxx` 编码，再由世界书关键词扫描激活 `TavernDB-ACU-CustomExport-纪要-N`。默认包裹是 `<记忆回溯>`，索引是 `<已发生的事件概览>`，默认深度为 999/1000；包裹上下、表头和索引应与纪要一起路由。向量分支还可能把本轮选中条目切为 constant 或更新纪要索引，因此识别不能依赖 constant。内部辅助 fetch 标记为 `init[Symbol.for('acu.internal-generation-fetch')]`；此版排除它，同时按真实请求体的来源、模型与接口分组。零层正文转发也可能带此标记，诊断不覆盖该模式。

## 验证方法与边界

`tests/fixtures/izumi-shujuku.json` 是小型人工合成样本，保留真实启用顺序中的相关 ID、角色和授权标记形状；未复制完整预设或内嵌脚本。连续楼层用例应保持角色、固定世界书和预设一致，每轮换用户输入，加入上一轮实际回复，同时改变记忆 epoch、token 数或数据库快照。还应覆盖静态伪对话、普通文本中的同名标签、媒体及工具消息等边界。

检查结果应分别报告：优化前后相邻请求的公共前缀、首个差异位置、角色/内容是否保真，以及 API 原始 usage 中明确返回的缓存 token。前缀稳定性属于本地验证；真实缓存命中受模型、端点、代理路由、最小缓存长度和服务端策略影响。本地测试通过、模拟缓存计数或工具面板统计，均不等于真实 Google/Vertex 命中。没有运行真实 API 请求时，不应承诺命中率或宣称已复现并解决服务端的 0 缓存。
