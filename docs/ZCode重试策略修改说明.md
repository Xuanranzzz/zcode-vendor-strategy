# ZCode 重试策略修改说明

> 用途：记录 ZCode 工具（桌面客户端内置的 agent 运行时）模型请求重试策略的修改位置、改动内容与验证方法，便于后续再次调整。
> 最近修改日期：2026-09-22
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
