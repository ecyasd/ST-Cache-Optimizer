# 离线连续楼层测试

2.6.7 已通过 174 项离线回归测试。常驻世界书前移的合成来源与边界用例位于 `tests/static-lore-prefix.test.cjs`；下面的默认连续楼层夹具主要验证动态召回、不同输入/回复和历史保真，不能替代真实宿主中常驻前缀前移的前后对照。本版现场数据尚未填入此说明。

2.6.7 的结构保护允许有限前移 `depth > 0`、system 角色的常驻世界书字面连续前缀。加载来源、本轮实际激活、宿主同深度同角色组装结果与最终消息必须完整对应，只跨已确认的历史，保留原文、角色及固定内容的全局顺序，未知尾巴留在原位。宏或来源不能完整证明时跳过，不重跑模板；扫描准入、`order`、预算和保存文件不变。固定头强化仍是默认关闭的独立实验，普通结构保护不需要它的角色改写或占位布局。

运行连续楼层夹具：

```powershell
node tools/offline-runner.cjs --turns 6 --out offline-report.json --chat-out synthetic-chat.jsonl
node --test tests/offline-runner.test.cjs
```

每轮增加一个 user 楼层，再将不同的公版文章节选加入 assistant 楼层；六轮共 13 个楼层（含 assistant 开场）。文章已下载并收录在 offline-replies.json，执行测试不访问网页。JSONL 可导入隔离酒馆，只有合成设定和公版文章。

工具原样载入 index.js，按 START → 辅助任务清理 → 正式 generate_interceptor → 世界书 → PROMPT_READY → SETTINGS_READY → 扩展 fetch → END 调用。每轮输入、模拟回复、记忆、数据库召回和目录都不同，历史持续增长。fetch 只接受内存中的指定生成路径，返回本地文章；其他路径直接抛出 OFFLINE_NETWORK_BLOCKED。

默认比较关闭优化与保留预设结构两种模式。保留模式开启泉记忆兼容以覆盖样本的 IZM7 记忆块，固定头实验保持关闭。用 `--compare-experimental` 另加实验对照；样本有记忆授权标记时，扩展可能保守跳过固定头重排，因此该选项不表示实验必然生效。

原生 Google/Vertex 提示词转换优先使用 `D:\SillyTavern\src\prompt-converters.js`，其次是工作区 reference/sillytavern 副本；可用 `--converter <本地文件>` 指定。报告记录源 SHA256。转换函数保持原样，仅用默认配置夹具替换 util.js 导入，避免初始化服务器。没有转换器时测试失败，不使用手写转换器替代。浏览器预设展开、世界书投影与召回由脱敏夹具控制；此测试不能证明当前酒馆脚本运行结果，也不能证明服务端缓存命中。

报告仅含 SHA256、字符数、一致前部消息数、首差异字段路径，以及固定规则、角色、相对顺序、历史和动态块是否各保留一次。每组前缀比较同时输出 `commonPrefixChars`、`currentChars` 和 `commonPrefixPercent`；百分比为前两者相除乘以 100，按从开头到首个不同字符统计，后方再次相同的文字不计入。该工具使用逐消息规范化 JSON 连接的字符口径；字符前缀是诊断值，不能当作 token 缓存率。模拟响应完全没有 usage 字段，API 缓存结果为未知。

可附加 `--captures <文件或目录>` 分析已有 JSON，也可用 `--replay-ui <文件或目录>` 尝试重放其中的前端 messages 请求。捕获文件仅当 JSON 数据读取，不执行提示词或嵌入脚本，不输出正文或历史 usage。明确的辅助生成、模型、工具及生成设置分组比较；缺少来源证据的系列标为连续性未验证。

`round-XX-ui.json` 通常只有诊断，不含原请求，无法独立重放；`round-XX-native.json` 已是 provider 请求，无法恢复原预设角色，因此只分析前缀。没有正式历史证据的前端请求经扩展重放时会保守跳过整理。所有此类记录均标为历史分析，不能当作本次现场截获。
