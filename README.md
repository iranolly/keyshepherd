# keyshepherd · 多把 API 钥匙的本机中转

> A local reverse proxy that pools multiple provider API keys: it picks the key that is furthest
> behind its 5h / weekly / monthly quota schedule, and rotates on 429 / 401 / 403 / 5xx without
> dropping the request. It never parses the request body — whatever path follows the route name is
> forwarded upstream verbatim, so chat-completions, responses, anthropic-messages and gemini
> clients all work through the same pool. Node.js only, no dependencies, small web UI included.
>
> 一把钥匙不够用、几把钥匙又要盯着额度别浪费？这个本机中转替你决定「这次该用哪把」，
> 撞到限流或失效自动换下一把，任务不中断。零依赖，只有 Node 标准库。

服务地址 `http://127.0.0.1:18787` · 管理网页 `http://127.0.0.1:18787/`

现在默认接的是 opencode-go，但转发部分没有写死任何一家：`keys.json` 的 `routes` 是一张「名字 → 上游地址」表，
每把钥匙各自挑一条（`route` 字段），换供应商就是加一行地址、给钥匙改个 `route`
（网页加钥匙时固定写 opencode-go，别的供应商要改 `keys.json` 或走命令行）。和 opencode 绑死的只有额度查询这一个地址，
可用环境变量 `KP_QUOTA_URL` 换掉；模型同步脚本也是照着 opencode 目录写的，换供应商就不用再跑它。

作用：客户端（pi、SDK、curl 都行）的请求先到这里，中转按顺序挑一把钥匙发出去。撞到额度/并发上限（429）或钥匙失效（401/403）时，
自动换下一把重发，任务不中断。钥匙数量不限，随时增删，改完立即生效。

Windows 下用 `start.cmd` 启动（内部走 `run-hidden.vbs`，不弹黑窗）；放进「启动」文件夹即可开机自启。

## 能接哪些协议

中转不解析请求体，也不改写响应：它把 `/路由名/剩余路径` 里的「路由名」换成 `routes` 表里的上游地址，
剩余路径和查询串原样拼上去。所以能接哪种 API 不取决于本项目，取决于上游有没有那条路径。

| 客户端协议 | 打到本机的路径 | 实际请求的上游 |
| --- | --- | --- |
| OpenAI chat completions | `/opencode-go/openai/v1/chat/completions` | `https://opencode.ai/inference/go/openai/v1/chat/completions` |
| OpenAI responses | `/opencode-go/openai/v1/responses` | `https://opencode.ai/inference/go/openai/v1/responses` |
| Anthropic messages | `/opencode-go/anthropic/v1/messages` | `https://opencode.ai/inference/go/anthropic/v1/messages` |

pi 的 provider 里 `api` 写 `openai-completions`、`openai-responses`、`anthropic-messages` 都能用，
同一份 `models.json` 里还能按模型分别指定（见「pi 侧配置」）。`/responses` 已经在本机日志里成功跑过
（`OK ... path=/opencode-go/openai/v1/responses`），pi.dev 目录里的 5 个 `openai-responses` 模型走的就是这条。

所有协议共用的转发规则：

- 只有 `GET` / `HEAD` 原样转发，其余方法一律按 `POST` 发出去；请求体按字节透传，上限 8MB。
- 上游要求带 `x-opencode-session`。客户端没带时，中转会补一个**稳定**的值：先看客户端自己的 `session_id` / `x-client-request-id`，再看请求体里的 `prompt_cache_key`，最后用「同一段对话前缀」的指纹。
  一定要稳定：上游按这个号划分缓存，每次换号等于每次开新会话（实测：号固定时第二次起命中 96%～100%，每次换号全 0，输入按原价算）。要换名字用 `sessionHeader`，设成空会回到默认值。
- `/` 之后的第一段必须是 `routes` 里的名字，否则直接 404 并列出可选路由。
- 429 / 401 / 403 / 402 / 408 / 5xx 换钥匙；其余 4xx 是请求本身的问题，原样返回，不换。

和协议相关的两处边界：

- 流式收尾只认 `[DONE]`、`message_stop`、`"finish_reason"` 三个标记，responses 的 `response.completed` 不在其中。
  影响仅限于「客户端先断开」时日志记为 `CLIENT-ABORT`、这一次用量不入账，请求本身不受影响。
- 用量统计同时认 `prompt_tokens`/`completion_tokens` 和 `input_tokens`/`output_tokens`，两类协议都能记账。

## 加钥匙 / 停用（推荐用网页）

浏览器打开 `http://127.0.0.1:18787/`，页面上直接添加、停用、删除、看冷却。

命令行同样可行：

```bat
node add-key.mjs 名字 钥匙内容
node add-key.mjs 名字 --disable
node add-key.mjs --list
```

也可以直接编辑 `keys.json`。三种方式都**立即生效**，不用重启。

`maxConcurrent` 是这把钥匙最多同时跑几个请求。网页和 `add-key.mjs` 加钥匙时默认写 10；直接在 `keys.json` 里不写这一项等于不限。想不被并发限流就调小，想跑得快就调大。

## 三档用量窗口

每把钥匙下面那三个小标签是平台的额度窗口：5h、周、月，数字是该档已用百分比，≥92% 变红、
比预期线高 3 个百分点以上变琥珀色。悬停能看到重置时间。左侧三条细条也对应这三档，浅色那段就是预期线。

数据来自 `GET https://opencode.ai/zen/go/v1/usage`（用各自钥匙查），缓存 3 分钟，后台每 60 秒刷一次。
这是转发之外唯一写死 opencode 的地址，换供应商时要设 `KP_QUOTA_URL`；查不到数据的钥匙不会因此被跳过，
只是不参与「预期线」打分。

## 选钥匙与换钥匙（routing.mjs）

每次请求给每把钥匙算一个「代价」，取最小的。代价的单位是**月度当量百分点**（把三档折算成同一把尺子）：

- 每档窗口取：已用 p%、本轮长度 T、已经过去 e。
- **预期线**：不用等窗口到期才烧完，提前收尾。月窗按 `targetShare=0.6`（30 天 → 预期 18 天用完），周窗按 `0.8`（7 天 → 5.6 天），5 小时档按 `1`（不压缩）。
  到预期时长时就是已用 100%，过了预期时长一律按 100% 算（「按预期你早该用完了」）。
- 偏差 = `p − 预期线`（预期线 = `min(100, 100·e ÷ (T×targetShare))`）。正数=烧得比预期快（会提前见底，少派活）；负数=预期该用掉的没用掉（要白扔，多派活）。
- 例外：**5h 实际用量还是 0% 时，预期线直接钉成 100%**。平台在没人用的时候不推进这档额度，按时间算出来的预期线会一直停在 0%（`5h 0% − 0% = 0`），这把钥匙看起来既不超前也不落后，闲着的池子就永远不上量。钉成 100% 之后，一点没用过的 5h 算落后 100 个点（`0% − 100% = −100%`，权重 0.2 就是 −20），先派活、先把额度烧掉。周、月两档不受影响，仍按时间算。
- 三档加权加总：`B = w5h×5h偏差 + w周×周偏差 + w月×月偏差`。权重默认是平台的容量占比 0.2 / 0.5 / 1，可在界面里改（`routing.windowWeights`）；改成 1/1/1 就是三档平权。
- 代价 = `B + 在途请求×0.3 + 近期失败×1.0`。
- 剔除条件只有一条：`R ≤ 0`，其中 `R = min(权重×剩余)`（默认 `0.2×5h剩余, 0.5×周剩余, 1×月剩余`），也就是「还能用多少」。没有 95%、99% 这种百分比红线；权重改了，R 跟着变。
- 两把钥匙代价差在 `tiePoints`（默认 0.3）内算并列：先看近期失败少的，再看**哪档先到期先烧哪把**，最后看在途请求少的。
- 全池都满了也不整池拒绝：仍然挑代价最低的一把，让上游自己判（429 会进冷却）。

为什么不用「预计停机小时」：那要拿一天的样本外推一个月，误差能翻十倍；而且 5 小时档最多停 5 小时、月档最多停 720 小时，两个量纲直接比大小，月度必然压死一切。B 只用「你烧得比时间快还是慢」，不外推、不用阈值、三档天然可比。

没有额度数据的钥匙按中性处理（B=0、R=∞），不加惩罚常数。

月档的窗口起点按「上个月同一天」推（不是减 30 天），观察到 resetsAt 变化后就用上一轮的重置点当精确起点；`fullHours` 由起点和重置点算出，所以 30 天、31 天的月份都算得对。

优先级从高到低：同会话粘住的钥匙 → 代价最低的钥匙。

## 界面里的预期与权重

右上角三横线打开配置条，两行分别写回 `keys.json` 的 `routing`：

- **预期**（`targetShare`）：每档预期多久用完，界面里直接写时间，拖动后自动换算成比例存回配置。默认 5h 5 小时、周 5.6 天、月 18 天（对应 100% / 80% / 60%）。
- **权重**（`windowWeights` / `loadPoints` / `failPoints`）：三档偏差各占多少份量，以及一个在途请求、一次失败折算多少个月度百分点。

悬停分数会列出每一档的算式，例如 `5h 20% − 84% = −64% × 0.2 −12.9`，直接对着界面就能验算。

5xx 和连接失败先在同一把钥匙上等 1.5 秒重试一次（`retrySameKeyMs`），还不行才换——避免上游打个嗝就丢掉缓存。

换钥匙的触发条件：

- 429（按 `retry-after`，没有就 30 秒起，翻倍）
- 401 / 403 / 402（10 分钟起，失败越多次越久；402 = 这把钥匙的账号没额度了）
- 5xx、408、连接失败、等响应超时 120 秒（8 秒起，翻倍）
- 200 但响应体里只有 error（仅非流式：整包读回来才能判）
- 流式开始后断掉：已经发出去的内容收不回，直接掐断客户端并让这把钥匙冷却，不自动重发

冷却采用指数退避加 ±25% 抖动，最长 10 分钟。冷却结束后的第一波只放 1 个并发去探（半开），探到了就立刻放开：

- 拿到 2xx 响应头（流式就是响应头到、模型开始出字）就算探通，马上恢复配置的并发上限；
- 20 秒还没回声（`probeMaxMs`，默认 20000，0 = 不放宽），先放宽到 3 个位，别让一个卡住的请求占着唯一槽位；
- 试探期间又失败就继续冷却，失败次数照常退避；
- 只剩一把钥匙能接活时不探——单点故障还把并发压到 1，等于整池停摆（2026-11-26 的卡死事故就是这个组合）。

探不通时的报错会写清现场：哪把在冷却、还剩多久，哪把在试跑、只放了几个，而不是笼统的“并发额度已满”。

所有钥匙都在冷却时，如果最近的一把 45 秒内能恢复（`queueOnCooldownMs`），请求会排队等，而不是直接回 429。

并发槽位靠两个动作保证不漏：槽位在请求进来的那一刻就挂上 close/finish 监听，客户端中途取消也能还回去（早先就是这里漏了，取消的请求把计数一直占着，最后所有钥匙显示 10/10、新请求排队到超时）；客户端已经断了才拿到槽位，也会立刻归还。

只有一把启用的钥匙时，冷却不会让它被跳过（照用不误）——冷却等于整池停摆，宁可让上游自己判（litellm 的做法）。

总时限到点是自己主动掐断的（客户端已收到 504），不算上游的错：不记失败、不冷却。以前这里把长对话记成钥匙故障，一次 285 秒的超时就把钥匙打进半开，接着整池一起卡住。

`GET` / `HEAD`（比如拉模型列表）不占并发名额，最多等 8 秒，避免列模型时被正在跑的对话堵住。

等槽位超时回 503：示例配置写的 45 秒，不写这一项就是 180 秒（`queueTimeoutMs`）。`active` 大于 0 不一定有问题：pi 会并行跑几条流，一条流几十秒很常见，看 `active` 要和日志里还没有 `OK` 的请求对得上。

网页上添加钥匙时会拿这把钥匙问一次用量接口，401/403 当场拒绝并说明原因；平台没响应则先存下。命令行 `add-key.mjs` 不验证，直接写入。

冷却、失败次数、计数器都写进 `state.json`，服务重启不清零。

失败次数只算**最近一小时**：一小时没再出错，退避和评分都从最短重来（成功一次也会清零）。
以前这个数是永久累计的，一周前那串 429 会一直压着这把钥匙的评分和并发。累计的成功/限流数只当历史看，不参与挑钥匙。

## 用量

每行右侧显示这把钥匙今天的输入 token、缓存命中率和折算花费（↑ 入 · 97% 命中 · $ 花费），顶部是全天合计。
数据存在 `usage.json`，保留 14 天明细，服务重启不清零。从响应体里读 usage 字段，流式和非流式都能读。

缓存命中率 = 命中缓存的 token ÷ 输入总量。四家叫法都认：`cache_read_input_tokens`（anthropic，input 不含缓存）、
`prompt_tokens_details.cached_tokens`（openai chat）、`input_tokens_details.cached_tokens`（openai responses）、`prompt_cache_hit_tokens`（deepseek）、`cached_tokens`。

上游**没回**缓存字段的请求不算进分母（算了会把命中率摊薄成人造的低值），所以页面上可能先空着，等到有带缓存字段的请求才出现。
账本里存了 `cacheVer`：早期那版读不懂这些字段、落了一堆 0，启动时按版本号清掉，不会污染当天命中率。

## 复制钥匙

点一下打码的钥匙就复制完整钥匙（闪一下绿勾），页面上任何时候都不会把钥匙明文铺开。
但状态接口 `/api/state` 会把完整钥匙返回给本机页面，所以能访问 18787 端口的本机程序都读得到；
带着浏览器 `Origin` 头的跨站请求会被 403 拒掉。别把这个端口做转发或暴露到公网。

## 改名字 / 改并发上限

- 双击钥匙名字（或键盘选中后回车）→ 变成输入框，回车保存，Esc 取消。
- 双击"1/4"里的那个 4（或键盘选中后回车）→ 变成滑杆，回车保存。填 0 表示不限并发。

## 键盘也能用

- `Tab` 走到任一处，焦点位置会有一圈紫色描边。
- 分数：回车钉住算式面板，再回车或 `Esc` 收起；也可以直接用鼠标点一下钉住。
- 名字 / 并发数字 / 打码钥匙：回车分别进入改名、改并发、复制。
- 右上角时间：回车打开刷新间隔滑杆（1～10 秒，默认 5 秒；这个只管页面多久拉一次状态，和额度那个 60 秒刷新无关）。
- 月亮 / 太阳按钮：日间、夜间主题切换。

## 看状态

```
curl http://127.0.0.1:18787/health
```

每把钥匙的冷却剩余秒数、成功/限流/失效次数都能看到。

## 启停

```bat
start.cmd                  :: 后台启动（不弹窗）
node pool.mjs              :: 前台启动，日志直接打在窗口里，Ctrl+C 结束
```

端口被占用时后启动的那个会自己退出，不影响已在跑的实例。

## 超时与异常收尾

- 上游 120 秒不给响应头 → 换钥匙（`HEADER_TIMEOUT_MS`）。
- 上游给了响应头之后不动 → 空闲 180 秒就断开（`streamIdleTimeoutMs`，可在 keys.json 调小，最低 1 秒），当事上游进冷却，客户端不会无限等。
- 流式传到一半上游断掉 → 直接掐断客户端这一侧，让它立刻知道失败并重试，而不是挂着等一个永远不来的结束标记。
- 非流式响应超过 8MB → 回 502，不发半截内容；没到上限但中途断流 → 当作这把钥匙的故障，换下一把重发，全试完仍失败回 429。
- **总时限 285 秒**（`totalTimeoutMs`，可在 keys.json 调，最低 1 秒）：从收到请求开始算，连排队带传输一起算。到点还没完就断开、回 504、日志写 `TIMEOUT`。以前上游一边吐心跳一边不给结果时，这把钥匙的并发位会被吊住几分钟，正是它让 pi 每次都卡在 300 秒上限。
- 客户端先跑了（pi 等满 300 秒自己掐断）：以前这里什么都不写，日志里查不到；现在留一行 `CLIENT-ABORT key=… after=…s bytes=…`。

## 回归测试

```bat
node routing.test.mjs          :: 挑钥匙、冷却、抖动的纯函数测试
node lifecycle.test.mjs         :: 起一个假上游，跑八组场景：整包、流式、超 8MB、流中途断、server-timing、总时限、客户端提前断开、上游卡住
node usage.test.mjs             :: 五种上游格式的缓存字段解析、没带字段的请求不进分母、老存档升级
node failwindow.test.mjs        :: 失败计数会不会自己过期（把窗口调成 1.2 秒，1.6 秒后必须归零）
node probe.test.mjs             :: 半开（试探）的生命周期：只放 1 个位、没回声放宽到 3 个、拿到 2xx 就满速、只剩一把时不试探、没空位时 503 写清原因
```

`lifecycle.test.mjs` 用临时目录放配置、状态、日志和用量，不会碰到线上的 keys.json。它断言的是两件事：客户端一定能在超时内收尾，以及每个场景结束后并发槽位归零。改动 pool.mjs 后先跑这两个，再重启服务。

## 日志

`keypool.log`：每次请求一行 `OK` / `ROTATE` / `FAIL`，含用了哪把钥匙、状态码、耗时；另有启动时的 `START` 行。出现 `ROTATE` 就是发生了换钥匙。

每行 `OK` 后面跟着 `gw=` 和 `up=` 两个数，取自 opencode 自己在响应头里报的 `server-timing`：

- `gw=` 它家网关排队的时间（毫秒）——输入越长它越离谱，实测 1.5 万 token 有过 121 秒、4.5 万 token 185 秒；
- `up=` 模型真正出字的时间（毫秒）——同一句“回答一个字”，实测 0.5 秒到 61 秒不等。

这两个数加起来和总耗时的差值，才是本机中转的开销（实测 0.6～1.6 秒，主要是每次重新和 opencode 握手）。所以看到 `ms=` 很大时先看 `gw=` / `up=`：是它家排队还是它家模型慢，而不是猜。

## 同步模型清单

pi 的 opencode-go 目录是随版本内置的（可用 `pi update --models` 从 pi.dev 拉新目录覆盖），
每个模型用哪种协议、地址、价格、上下文都写在这份目录里。

```bat
node sync-models.mjs --dry   :: 先看会增删哪些
node sync-models.mjs         :: 写入 models.json（自动备份）
```

脚本直接读 pi 用的同一份目录 `pi.dev/api/models/providers/opencode-go`，把目录里 `type=chat` 的模型
（当前 31 个）搬进 `opencode-pool` 这个 provider。每个模型保留自己的 `api`（现在四类：
openai-completions 19 个、openai-responses 5 个、anthropic-messages 6 个、google-generative-ai 1 个），
只把 `baseUrl` 改指向本机中转。provider 上的 `api: openai-completions` 只是兜底默认值，
模型自己的 `api` 优先，所以 responses 模型不会被改回 completions。

脚本直接打印到窗口；挂到系统计划任务时自己重定向到文件。没有变化时只打印一行「无需更新」，不产生备份；
有变化才写，并保留最近 5 份备份。

- 手动：`node sync-models.mjs`（加 `--dry` 只预览）
- 改端口或换机器后要重跑一次（地址里带端口）。
- `PINNED` 里钉住的字段不会被目录覆盖，例如 deepseek-v4.1-flash 的 400k 上下文。

## pi 侧配置

`%USERPROFILE%\.pi\agent\models.json` 里加一个提供方，`baseUrl` 指向本中转，然后把默认模型指过去。
`api` 写哪种协议都行——中转不看协议、路径原样转发，所以 `openai-completions`、`openai-responses`、
`anthropic-messages` 都能用。provider 级的 `api` 只是默认值，单个模型可以覆盖它
（现在 `deepseek-v4.1-flash` 就是 `openai-responses`）。原来的 `opencode-go` 配置留着，可随时切回。

注意：只有改过地址的客户端才经过钥匙池。其他工具如果自己直连 opencode，
要把各自的地址改成 `http://127.0.0.1:18787/opencode-go/openai/v1` 才会走这里；
responses 客户端用同一个 `baseUrl`，它会自己拼 `/responses`。

## 文件

- `pool.mjs` 中转主程序 · `ui.mjs` 网页界面与 `/api/*` 管理接口
- `routing.mjs` 选钥匙/冷却的纯逻辑 · `routing.test.mjs` 回归测试（`node routing.test.mjs`）
- `keys.json` 钥匙清单（唯一需要你动的文件；从 `keys.example.json` 复制一份改名即可）
- `add-key.mjs` 命令行加钥匙小工具 · `sync-models.mjs` 把目录里的模型同步进 `models.json`
- `keypool.log` 运行日志 · `usage.json` 用量账本 · `state.json` 冷却与失败计数（重启不清零）
- `lifecycle.test.mjs` 端到端回归（假上游，八组场景）
- `start.cmd` / `run-hidden.vbs` 应急启动
- 环境变量可换路径：`KP_CONFIG` / `KP_STATE` / `KP_LOG` / `KP_USAGE` / `KP_QUOTA_URL`
