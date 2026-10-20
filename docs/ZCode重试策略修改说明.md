# ZCode 重试策略修改说明

> 用途：记录 ZCode 工具（桌面客户端内置的 agent 运行时）模型请求重试策略的修改位置、改动内容与验证方法，便于后续再次调整。
> 最近修改日期：2026-10-20（第九节：适配 2026-10-19 构建）
> 说明：本仓库另有 `retry-strategy` 插件（`/retry-strategy` 命令）实现同样的标准/激进切换；本文档记录底层原理与手工修改参考。

---

## 一、本次修改目的

按需求调整**所有供应商**的模型请求重试策略：

| 参数 | 原值 | 新值 |
|---|---|---|
| 重试间隔 | 指数退避 2s→4s→8s…封顶 60s，带 50%~100% 随机抖动 | **1-2-3-4-5 秒，最大 5 秒**（线性，无抖动） |
| 重试次数 | 10 次（maxAttempts=11） | **1000 次**（maxAttempts=1001） |

---

## 二、涉及文件

| 文件 | 说明 |
|---|---|
| `<ZCode安装目录>\resources\glm\zcode.cjs` | **要修改的文件**。这是工具实际运行的 agent 运行时入口（见同目录 `.node-bundle-meta.json` 的 `"entry": "zcode.cjs"`，约 14.8MB 的打包 JS） |
| `<ZCode安装目录>\resources\glm\zcode.cjs.bak-<日期>` | 修改前的备份（建议手工修改前先备份） |
| ZCode 用户数据目录（`~/.zcode`） | **不包含**重试配置——重试策略硬编码在 `zcode.cjs` 里，不在任何 JSON 配置中 |

> 注意：`resources\app.asar`（约 326MB 客户端 UI）里也有 "retry" 字样，但那是界面相关，核心重试逻辑不在这里，**不要改它**。

---

## 三、重试机制架构（背景知识）

修改前先了解这套重试体系，都在 `zcode.cjs` 内：

1. **模型请求重试循环**（所有供应商共用）：
   - `lVr`（HTTP 传输）/ `wVr`（SSE 流式传输）两个循环：`for(尝试次数 _=1; _<=maxAttempts; _+=1)`，即总共 maxAttempts 次尝试 = maxAttempts-1 次重试。
2. **重试配置解析 `hzr()`**：优先级为「调用方传入参数 → 环境变量 `ZCODE_MODEL_RETRY_*` → 默认值 `EDe`」。修改 `EDe` 即可改变所有供应商的默认行为。
3. **重试间隔计算 `ire()`**（导出名 `calculateRetryDelay`）：根据当前是第几次重试算出等待毫秒数。
4. **动态工作流子代理瞬态重试 `nWo()`**（导出名 `transientBackoffMs`）：子代理模型请求瞬时失败后的重新调度退避。
5. AI SDK 内置的 `generateText`/`streamText`（内部默认重试 2 次）在 ZCode 核心代码里**只有定义、没有调用**，核心模型请求走的是上面的循环，因此无需修改。

---

## 四、具体修改内容（共两轮，旧代码 → 新代码）

在 `zcode.cjs` 中用精确字符串查找并替换，每处原文在文件中唯一出现。

### 第一轮：重试间隔与次数（初始需求）

### 1. 重试间隔计算 `ire`（所有供应商的等待时间）

旧：
```js
function ire(e,t,n){let o=e.baseDelayMs*e.backoffFactor**Math.max(0,t-1),s=Math.min(o,e.maxDelayMs);return y4s(n,o)?n:!e.jitter||s===0?s:Math.round(s*(.5+Math.random()*.5))}
```

新：
```js
function ire(e,t,n){let s=Math.min(Math.max(0,t),5)*1e3;return Math.min(y4s(n,s)?n:s,5e3)}
```

含义：第 1 次重试等 1s、第 2 次等 2s、…、第 5 次及以后等 5s；即使服务端返回 `Retry-After` 头，最终等待也被封顶在 5s。

### 2. 重试次数与退避默认值 `EDe`

旧：
```js
EDe={backoffFactor:2,baseDelayMs:2e3,jitter:!0,maxAttempts:11,maxDelayMs:6e4};
```

新：
```js
EDe={backoffFactor:1,baseDelayMs:1e3,jitter:!1,maxAttempts:1001,maxDelayMs:5e3};
```

含义：`maxAttempts: 1001` = 首次请求 + **1000 次重试**；其余字段（基础 1s、因子 1、无抖动、上限 5s）与新的线性间隔保持一致。

### 3. 动态工作流子代理瞬态重试 `nWo`（与 1-5s 策略保持一致）

旧：
```js
function nWo(e,t=Math.random){let n=Math.min(kWa,wWa*2**(e-1));return Math.round(n*(.5+.5*t()))}
```

新：
```js
function nWo(e,t=Math.random){return Math.min(Math.max(0,e)*1e3,kWa)}
```

含义：同样改为 1-5 秒线性封顶（`kWa` 即 5s 上限）。该机制本身没有次数上限（每次 ask 会归零计数，且只在可重试错误时触发），本次未加次数限制。

### 4. 相关常量

旧：
```js
wWa=2e3,kWa=6e4;
```

新：
```js
wWa=1e3,kWa=5e3;
```

含义：基础 1s / 上限 5s，与新策略对应（`kWa` 仍被 `nWo` 使用）。

### 第二轮：配额类限流错误（429）不重试的问题

**背景**：实际使用中发现报错 `provider_code=insufficient_quota reason=rate_limited status=429 retryable=false`（TraceID 已脱敏），即供应商返回 429 限流（如 "inference exceeds tpm/rpm limit"），但 ZCode 判定 `retryable=false`，一次都不重试，直接失败——第一轮改的次数/间隔完全没起作用。

**根因**：`zcode.cjs` 里有一张供应商业务错误码映射表 `GDe`（`vst` 函数查表），其中**配额类错误码被硬编码为不可重试**：

```js
$Ns={code:Cs.ModelRateLimited,reason:_s.RateLimited,retryReason:Qc.RateLimited,retryable:!1}
```

`insufficient_quota`、`credit_balance_exhausted`、`organization_spend_limit_exceeded`、`project_spend_limit_exceeded`、`organization_usage_limit_exceeded`、`exceeded_current_quota_error`、`2056`、`20097`、`1316`~`1321` 全部映射到 `$Ns`。它覆盖了 `Xcn` 里 "HTTP 429 → 可重试" 的通用规则，导致配额类 429 被放弃重试。

**主代理路径**走 `gqr(e)`：`return e.retryable && e.reason!==_s.Cancelled`，`retryable=false` 直接不重试。
**workflow 子代理路径**（预算为 Unbounded）走 `tVr`：providerCode 命中 `I4s` 集合 → `{decision:"stop",kind:"quota"}` 同样不重试。`I4s` 里也含上述全部配额码。

**本次修改共 2 处**：

#### 5. 配额类错误重试标志 `$Ns`（主代理路径）

旧：
```js
$Ns={code:Cs.ModelRateLimited,reason:_s.RateLimited,retryReason:Qc.RateLimited,retryable:!1}
```

新：
```js
$Ns={code:Cs.ModelRateLimited,reason:_s.RateLimited,retryReason:Qc.RateLimited,retryable:!0}
```

含义：所有映射到 `$Ns` 的配额类错误码（含 `insufficient_quota`）变为可重试，按第一轮的 1-2-3-4-5 秒、最多 1000 次执行。

#### 6. workflow 路径配额码集合 `I4s`（workflow 子代理路径）

旧：
```js
I4s=new Set(["1005","1308","1310","1313","1316","1317","1318","1319","1320","1321","2056","20097","insufficient_quota","credit_balance_exhausted","organization_spend_limit_exceeded","project_spend_limit_exceeded","organization_usage_limit_exceeded","exceeded_current_quota_error"])
```

新：
```js
I4s=new Set([])
```

含义：清空配额码集合，使 workflow 子代理路径遇到这些错误时也走 `{decision:"retry"}`，与主代理行为一致。

> 未改动的保留项：`qNs`（错误码 1008/1314/1315，reason=Unknown，`retryable:!1`）——这类是"未知"错误，非限流，暂不改为可重试。如后续需要可同样把 `qNs` 的 `retryable` 改为 `!0`。

---

## 五、验证步骤（每次改完都做一遍）

在 Windows CMD 中执行：

**1. 先备份**
```cmd
copy "<ZCode安装目录>\resources\glm\zcode.cjs" "<ZCode安装目录>\resources\glm\zcode.cjs.bak-YYYYMMDD"
```

**2. 语法校验（必须通过，退出码 0）**
```cmd
node --check "<ZCode安装目录>\resources\glm\zcode.cjs"
```

**3. 确认旧代码已不存在、新代码已生效**（PowerShell）
```powershell
$p='<ZCode安装目录>\resources\glm\zcode.cjs'
$t=[IO.File]::ReadAllText($p)
# 期望全部为 0：
[regex]::Matches($t,[regex]::Escape('e.baseDelayMs*e.backoffFactor**')).Count   # 旧 ire
[regex]::Matches($t,[regex]::Escape('maxAttempts:11')).Count                    # 旧 EDe
[regex]::Matches($t,[regex]::Escape('wWa*2**')).Count                           # 旧 nWo
[regex]::Matches($t,[regex]::Escape('wWa=2e3')).Count                           # 旧常量
# 期望为 1：
[regex]::Matches($t,[regex]::Escape('maxAttempts:1001')).Count                  # 新 EDe
```

**4. 替换命令模板**（如需再次修改，按「六」调整字符串后执行）
```powershell
$p='<ZCode安装目录>\resources\glm\zcode.cjs'
$t=[IO.File]::ReadAllText($p)
$old='此处填旧字符串'
$new='此处填新字符串'
$cnt=([regex]::Matches($t,[regex]::Escape($old))).Count
if($cnt -ne 1){ Write-Output "ABORT: 旧字符串出现 $cnt 次，应为 1 次"; exit 1 }
$t=$t.Replace($old,$new)
[IO.File]::WriteAllText($p,$t,(New-Object System.Text.UTF8Encoding($false)))
Write-Output 'write-ok'
```

---

## 六、下次修改指南

| 想改什么 | 改哪里 |
|---|---|
| **重试次数**（比如改成 N 次） | 把 `EDe` 里的 `maxAttempts:1001` 改成 `N+1`（因为 maxAttempts 包含首次请求）。改 1000 次 → `maxAttempts:1001` |
| **重试间隔序列**（比如 1-2-3-4-5-6，最大 6 秒） | 改 `ire` 里的两个 `5`：`let s=Math.min(Math.max(0,t),6)*1e3;return Math.min(y4s(n,s)?n:s,6e3)` |
| **是否允许 Retry-After 头超过上限** | 去掉 `ire` 外层 `Math.min(...,5e3)` 即可恢复「服务端说了算」 |
| **恢复原版行为** | 直接用备份文件覆盖：`copy /Y "<ZCode安装目录>\resources\glm\zcode.cjs.bak-YYYYMMDD" "<ZCode安装目录>\resources\glm\zcode.cjs"`（或运行插件 `/retry-strategy 标准`） |
| **让某类供应商错误码可重试**（比如又遇到某码 429 不重试） | 错误码映射在 `GDe` 表（搜 `function vst(`），找到对应分类对象（`$Ns`/`WNs` 等）改其 `retryable`；workflow 路径还要看 `I4s` 集合（搜 `I4s=new Set`）。改完跑第五节的验证步骤 |

---

## 七、注意事项

1. **必须重启 ZCode 应用**，改动才会生效（正在运行中的进程内存里还是旧代码）。
2. **应用更新可能覆盖此修改**——`zcode.cjs` 在安装目录内，升级后需重新修改（或由 retry-strategy 插件的启动钩子自动重新应用）；届时先对比新版本代码，因为内部函数名/结构可能变化。
3. **环境变量优先级高于默认值**：若设置了 `ZCODE_MODEL_RETRY_MAX_RETRIES`、`ZCODE_MODEL_RETRY_BASE_DELAY_MS`、`ZCODE_MODEL_RETRY_BACKOFF_FACTOR`、`ZCODE_MODEL_RETRY_MAX_DELAY_MS`，会覆盖 `EDe`。
4. **修改方式说明**：文件是打包压缩过的 JS，无法用常规方式格式化阅读；修改时用「精确字符串查找替换」（PowerShell 脚本），不要手动大段重写，避免破坏语法。
5. **激进策略的影响**：配额类 429（如余额不足、配额耗尽）现在也会持续重试——如果错误是"余额不足"这类长期问题，重试最多 1000 次（最长约 83 分钟）才会放弃；如果只是 tpm/rpm 限流（几秒到几分钟恢复），重试会自动等到恢复后继续。请确认这是期望行为。

---

## 八、2026-10-10 构建适配（v0.2）

> 适配日期：2026-10-13。目标文件：`<ZCode安装目录>\resources\glm\zcode.cjs`，构建时间 2026-10-10 15:02:26，15,126,820 字节（字符数 15,124,763）。

### 8.1 为什么 v0.1 的 6 处锚点全部失效

ZCode 重新压缩打包后，压缩后的标识符全部改名，旧的精确字符串一个都匹配不到（脚本会安全报错「片段 #1 既匹配不到原文也匹配不到目标串」，拒绝修改）：

| 旧名（2026-09-22） | 新名（2026-10-10） |
|---|---|
| `ire`（延迟计算） | `Moe`（辅助函数 `y4s` → `iHs`） |
| `EDe`（默认重试参数） | `PNe` |
| `$Ns`（配额错误分类） | `Aqs` |
| `I4s`（配额码短路集合） | `hHs` |
| `nWo` / `wWa` / `kWa`（第二套退避实现） | **已删除** |

关键点：新构建全文中 `baseDelayMs*` 只出现 1 次，即只剩 `Moe` 这一个延迟实现；旧构建里另一套独立的指数退避（`nWo` + `wWa`/`kWa` 常量）本版整体不存在，对应的 2 处补丁失去意义。所以新构建是 **4 处必需改动**，而不是把 6 处换个名字。

### 8.2 四处必需改动

**（1）延迟计算函数 `Moe`**（字符偏移 4,096,544，全文唯一）

改前：
```js
function Moe(e,t,n){let o=e.baseDelayMs*e.backoffFactor**Math.max(0,t-1),i=Math.min(o,e.maxDelayMs);return iHs(n,o)?n:!e.jitter||i===0?i:Math.round(i*(.5+Math.random()*.5))}
```

改后：
```js
function Moe(e,t,n){let s=Math.min(Math.max(0,t),5)*1e3;return Math.min(iHs(n,s)?n:s,5e3)}
```

含义：第 t 次重试等 t 秒、第 5 次起恒等 5 秒；不再读任何参数、没有随机抖动；外层 `Math.min(...,5e3)` 把服务端 `Retry-After` 头也压回 5s。

**（2）默认重试参数 `PNe`**（偏移 3,816,592）

改前：`PNe={backoffFactor:2,baseDelayMs:2e3,jitter:!0,maxAttempts:11,maxDelayMs:6e4};`
改后：`PNe={backoffFactor:1,baseDelayMs:1e3,jitter:!1,maxAttempts:1001,maxDelayMs:5e3};`

含义：`maxAttempts:1001` = 首次请求 + 1000 次重试，是这一处的关键；其余四项改后不再被 `Moe` 读取，一并改掉是为了语义自洽，也防止未来其他调用点误用旧值。

**（3）配额错误分类 `Aqs`**（偏移 4,010,010）

改前：`Aqs={code:Rs.ModelRateLimited,reason:vs.RateLimited,retryReason:el.RateLimited,retryable:!1}`
改后：`Aqs={code:Rs.ModelRateLimited,reason:vs.RateLimited,retryReason:el.RateLimited,retryable:!0}`

含义：`Aqs` 是分类表 `YNe`（`function uut(e){return YNe.get(e)}`）里 14 个配额错误码的共同分类，覆盖 `insufficient_quota`、`credit_balance_exhausted`、四个 `*_spend_limit_exceeded`、`exceeded_current_quota_error`、`2056`、`20097`、`1316`~`1321`。

**（4）配额码短路集合 `hHs`**（偏移 4,108,088）

改前：`hHs=new Set(["1005",…,"exceeded_current_quota_error"])`（18 个码）
改后：`hHs=new Set([])`

含义：`Ueo` 的第二个分支 `t!==void 0&&hHs.has(t)?{decision:"stop",kind:"quota"}` 优先级高于一切分类；清空后这些错误码才会继续往下走、进入分类判定。

（3）和（4）**缺一不可**：

```
providerCode 命中 hHs ?   → {decision:"stop",kind:"quota"}      ← 改动（4）清空它
                     ↓ 否
reason ∈ {Cancelled, AuthFailed, ProviderNotConfigured, ModelNotFound,
          ContextExceeded, InvalidRequest} ?  → 各自 stop
                     ↓ 否
                 {decision:"retry"}
```

调用方 `Hut(e,t,n)`：预算为 Unbounded（`RNe(e){return e===UH.Unbounded}`）时走 `Ueo`，否则走主代理路径 `KXr(e){return e.retryable&&e.reason!==vs.Cancelled}`。

- 只做（4）不做（3）：短路没了，但 `KXr` 读到 `retryable:!1` 仍然不重试；
- 只做（3）不做（4）：`Ueo` 的 quota 分支先命中，直接停，`retryable` 根本轮不到被读。

### 8.3 三处可选改动：补回 1308 / 1310 / 1313

新构建把 18 个配额码中的 4 个拆成了独立的内联条目，`retryable` 仍是 `!1`：

```js
["1005",{code:Rs.ModelRequestFailed,reason:vs.InvalidRequest,retryReason:el.NetworkError,retryable:!1}]
["1308",{code:Rs.ModelRateLimited,reason:vs.RateLimited,retryReason:el.RateLimited,retryable:!1}]
["1310",{code:Rs.ModelRateLimited,reason:vs.RateLimited,retryReason:el.RateLimited,retryable:!1}]
["1313",{code:Rs.ModelRateLimited,reason:vs.RateLimited,retryReason:el.RateLimited,retryable:!1}]
```

这 4 个码原本都在旧构建的 `I4s` 里：旧版激进策略是靠 `$Ns` 的 `retryable` 改动让它们重试的，新构建拆表后这条路没了——只做 8.2 的 4 处，会**丢掉这三类限流错误的重试**。因此插件把 1308/1310/1313 三条的 `retryable` 一并改成 `!0`，并与标准态互为逆操作；这三条在插件里标记为可选片段，换构建后条目不存在也不会连累其余补丁。

- `1005` 保持 `!1`：新构建把它归类为 `InvalidRequest`（不再是 RateLimited），`Ueo` 无论如何都会 `stop/invalid_request`；改成可重试只会在主路径上反复重试无效请求。
- `3008`/`3009`/`3010`/`1304`（同为 `ModelRateLimited`，但从未进过 `I4s`）是 ZCode 的显式策略，**不动**。

### 8.4 生效后的重试时间轴

| 第几次重试 | 等待 | 累计 |
|---|---|---|
| 1 | 1s | 1s |
| 2 | 2s | 3s |
| 3 | 3s | 6s |
| 4 | 4s | 10s |
| 5 | 5s | 15s |
| 6 及以后 | 5s | 20s、25s… |
| 第 10 次 | 5s | 40s |
| 第 100 次 | 5s | 490s（8.2 分钟） |
| 第 1000 次 | 5s | 4990s（约 83 分钟） |

对比改前：2s→4s→8s→16s→32s→60s→60s…，10 次累计 362s（计入 0.5×~1.0× 抖动为 181~362s）。

> 注意：如果错误是「余额不足 / 配额耗尽」这类长期性问题，现在会重试约 83 分钟才放弃，而不是立刻报出来。这是激进模式的既定取舍。

### 8.5 验证记录（2026-10-13 实测）

| # | 检查项 | 结果 |
|---|---|---|
| 1 | 应用前 `status` | `currentStrategy:"standard"`、`detectedBuild:"2026-10-10"`，7 个锚点 std 计数均为 1 |
| 2 | `apply aggressive` | 7 处替换全部成功，`vm.Script` 编译校验通过 |
| 3 | 文件字节数 | 15,126,820 → **15,126,473**（净 −347 = −83 +2 +0 −266；3 处内联码长度不变） |
| 4 | 重复 `apply aggressive` | `changed:false`，幂等，未二次写入 |
| 5 | 往返 `apply standard` | 回到 15,126,820 字节，SHA256 与原文件**逐字节一致**（`B816E386…96DA6E`） |
| 6 | 还原后再次 `apply aggressive` | 回到 15,126,473（SHA256 `1572C489…40CC34`） |
| 7 | `node --check zcode.cjs` | 退出码 0 |
| 8 | 邻近代码完整性 | `Ueo` 短路门、`KXr`、`this.retry=JJr(t.retry,this.env)`、4 个 `ZCODE_MODEL_RETRY_*` 环境变量名均原样完好 |
| 9 | SessionStart 钩子 `auto` | 「保持」与「定位不到目标」两种情况均为退出码 0、stdout/stderr 皆空 |
| 10 | 离线自测 | `node retry-strategy/scripts/selftest.mjs`：两种构建 25 项断言全部通过 |

### 8.6 ZCode 再次更新时怎么办

每次重新打包都会改名，先按下面的方法找锚点（找到后填进 `retry-strategy/scripts/retry-patch.mjs` 的 `BUILDS`，新构建加一组即可，旧构建条目保留不动）：

```powershell
$t = [IO.File]::ReadAllText('<ZCode安装目录>\resources\glm\zcode.cjs')

$t.IndexOf('backoffFactor:2,baseDelayMs:2e3')   # 默认参数对象，形如 XXX={...}
$t.IndexOf('baseDelayMs*')                       # 延迟计算函数，前溯到 function XXX(
$t.IndexOf('retryable:!1}")]')                   # 内联分类表
$t.IndexOf('insufficient_quota")')               # 短路集合（new Set 里）

[regex]::Matches($t, 'jitter').Count             # 出现次数很少（默认值/解析/延迟函数，另有 1 处无关提示文案）
                                                 # 说明只有一套退避实现；若明显变多，可能又有了第二套
```

确认锚点后：

```powershell
node retry-strategy/scripts/apply-retry.mjs status            # 按构建列出每个锚点的匹配计数
node retry-strategy/scripts/apply-retry.mjs apply aggressive
node retry-strategy/scripts/apply-retry.mjs status            # 对应构建的必需锚点应全部 agg=1
```

脚本在**识别不出构建**或**任一必需片段状态不明**时会拒绝修改，不会写出坏文件——这一点无需绕过。

### 8.7 如何还原

```powershell
node retry-strategy/scripts/apply-retry.mjs apply standard
```

无需备份文件：各片段互为逆操作，脚本内建唯一匹配校验，状态不明会拒绝修改。还原后文件字节数应为 **15,126,820**，**同样需要重启 ZCode**。


## 九、2026-10-19 构建适配（v0.3）

> 适配日期：2026-10-20。目标文件：`<ZCode安装目录>\resources\glm\zcode.cjs`，构建时间 2026-10-19 20:51:20，15,243,891 字节（字符数 15,241,826）。

### 9.1 为什么 v0.2 的 7 处锚点全部失效

ZCode 再次重新打包，压缩后的标识符又一次全部改名，v0.2（2026-10-10 构建）的锚点一个都匹配不到（插件安全报错「未能识别当前 ZCode 构建」并拒绝修改）。与上次不同，这次连**枚举命名空间**都换了（`Rs/vs/el` → `as/bs/tl`）：

| 旧名（2026-10-10） | 新名（2026-10-19） |
|---|---|
| `Moe`（延迟计算，辅助函数 `iHs`） | `_ie`（辅助函数 `CHs`） |
| `PNe`（默认重试参数） | `$Le` |
| `Aqs`（配额错误分类） | `Z9s`（预置的可重试变体是 `X9s`，注意区分） |
| `hHs`（配额码短路集合） | `FHs` |
| 枚举 `Rs` / `vs` / `el` | 枚举 `as` / `bs` / `tl` |

结构上与 2026-10-10 构建完全一致：全文 `baseDelayMs*` 只有 1 处（即 `_ie` 一个延迟实现）；子代理瞬态退避（`nWo`/`wWa`/`kWa`）仍不存在；1308/1310/1313 三个限流码仍是独立内联条目且 `retryable:!1`；`1005` 仍归类 `InvalidRequest`、`1304`/`3008`/`3009`/`3010` 仍为 ZCode 显式策略。所以改动仍是 **4 处必需 + 3 处可选**。

### 9.2 四处必需改动

**（1）延迟计算函数 `_ie`**（偏移 4,136,157，全文唯一）

改前：
```js
function _ie(e,t,n){let o=e.baseDelayMs*e.backoffFactor**Math.max(0,t-1),i=Math.min(o,e.maxDelayMs);return CHs(n,o)?n:!e.jitter||i===0?i:Math.round(i*(.5+Math.random()*.5))}
```

改后：
```js
function _ie(e,t,n){let s=Math.min(Math.max(0,t),5)*1e3;return Math.min(CHs(n,s)?n:s,5e3)}
```

含义同 8.2（1）：第 t 次重试等 t 秒、第 5 次起恒等 5 秒，外层 `Math.min(...,5e3)` 把服务端 `Retry-After` 头也压回 5s。

**（2）默认重试参数 `$Le`**（偏移 3,853,548）

改前：`$Le={backoffFactor:2,baseDelayMs:2e3,jitter:!0,maxAttempts:11,maxDelayMs:6e4};`
改后：`$Le={backoffFactor:1,baseDelayMs:1e3,jitter:!1,maxAttempts:1001,maxDelayMs:5e3};`

含义同 8.2（2）：`maxAttempts:1001` = 首次请求 + 1000 次重试。

**（3）配额错误分类 `Z9s`**（偏移 4,046,965）

改前：`Z9s={code:as.ModelRateLimited,reason:bs.RateLimited,retryReason:tl.RateLimited,retryable:!1}`
改后：`Z9s={code:as.ModelRateLimited,reason:bs.RateLimited,retryReason:tl.RateLimited,retryable:!0}`

含义同 8.2（3）：`Z9s` 是分类表里 14 个配额错误码的共同分类；注意 `X9s` 是预置的可重试变体（`rate_limit_reached_error` 等使用），别把 `Z9s` 的替换字符串写成 `X9s`。

**（4）配额码短路集合 `FHs`**（偏移 4,147,799）

改前：`FHs=new Set(["1005","1308","1310","1313","1316","1317","1318","1319","1320","1321","2056","20097","insufficient_quota","credit_balance_exhausted","organization_spend_limit_exceeded","project_spend_limit_exceeded","organization_usage_limit_exceeded","exceeded_current_quota_error"])`
改后：`FHs=new Set([])`

含义同 8.2（4）：`xpt` 的第二个分支 `t!==void 0&&FHs.has(t)?{decision:"stop",kind:"quota"}` 优先级高于一切分类，清空后这些错误码才会继续往下走、进入分类判定。

（3）和（4）缺一不可，调用链同 8.2：预算为 Unbounded 时 `Tpt` 走 `xpt`（决策函数，含 `FHs` 短路门），否则走主代理路径 `Bro`（读 `retryable`）。

### 9.3 三处可选改动：补回 1308 / 1310 / 1313

同 8.3 的来龙去脉，本版只是枚举名换成 `as/bs/tl`：

```js
["1308",{code:as.ModelRateLimited,reason:bs.RateLimited,retryReason:tl.RateLimited,retryable:!1}]  →  retryable:!0
["1310",{code:as.ModelRateLimited,reason:bs.RateLimited,retryReason:tl.RateLimited,retryable:!1}]  →  retryable:!0
["1313",{code:as.ModelRateLimited,reason:bs.RateLimited,retryReason:tl.RateLimited,retryable:!1}]  →  retryable:!0
```

`1005` 保持 `!1`（`InvalidRequest`）；`3008`/`3009`/`3010`/`1304` 不动，理由同 8.3。

### 9.4 生效后的重试时间轴

同 8.4：1-2-3-4-5s 线性、封顶 5s、无抖动、最多 1000 次重试（长期性问题最坏约 83 分钟后放弃）。

### 9.5 验证记录（2026-10-20 实测）

| # | 检查项 | 结果 |
|---|---|---|
| 1 | 应用前 `status` | `currentStrategy:"standard"`、`detectedBuild:"2026-10-19"`，7 个锚点 std 计数均为 1 |
| 2 | `apply aggressive` | 7 处替换全部成功，`vm.Script` 编译校验通过 |
| 3 | 文件字节数 | 15,243,891 → **15,243,544**（净 −347，与 2026-10-10 构建的 −347 一致） |
| 4 | 重复 `apply aggressive` | `changed:false`，幂等，未二次写入 |
| 5 | 往返 `apply standard` | 回到 15,243,891 字节，SHA256 与原文件**逐字节一致**（`A055234A…AE0DE1`） |
| 6 | 还原后再次 `apply aggressive` | 回到 15,243,544（SHA256 `37AAC175…46B22`） |
| 7 | `node --check zcode.cjs` | 退出码 0 |
| 8 | 邻近代码完整性 | `xpt` 短路门、`Tpt`、`this.retry=jQr(t.retry,this.env)`、4 个 `ZCODE_MODEL_RETRY_*` 环境变量名均原样完好 |
| 9 | 离线自测 | `node retry-strategy/scripts/selftest.mjs`：三种构建 37 项断言全部通过 |

### 9.6 ZCode 再次更新时怎么办

同 8.6：每次重新打包都会改名（有时连枚举命名空间都换），找到新锚点后在 `retry-strategy/scripts/retry-patch.mjs` 的 `BUILDS` **最前面**加一组即可，旧构建条目保留不动。定位锚点的方法见 8.6（搜 `backoffFactor:2,baseDelayMs:2e3` / `baseDelayMs*` / `retryable:!1}"]` / `insufficient_quota"`），注意分类表与短路集合里的枚举名随构建变化。

### 9.7 如何还原

```powershell
node retry-strategy/scripts/apply-retry.mjs apply standard
```

还原后文件字节数应为 **15,243,891**，同样需要重启 ZCode。
