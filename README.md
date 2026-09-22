# ZCode 重试策略（zcode-vendor-strategy）

ZCode 桌面客户端内置 agent 运行时的**模型请求重试策略切换插件**：在「标准」与「激进」两套重试行为之间一键切换，并在每次启动 ZCode 时自动保持所选策略——即使 ZCode 更新把运行时文件覆盖回原版，也会自动重新应用。

## 背景

ZCode 的模型请求重试参数**硬编码**在安装目录的 `resources/glm/zcode.cjs`（约 14.8MB 的打包 JS 运行时）里，没有任何公开配置项。默认（标准）行为：

- 重试间隔：指数退避 2s→4s→8s…，封顶 60s，带 50%~100% 随机抖动
- 最多重试 10 次
- 配额类限流错误（429 / `insufficient_quota` 等）**不重试**，直接失败

在实际使用中，供应商的 tpm/rpm 限流（几秒到几分钟恢复）会让请求直接失败，因此需要一个更激进的策略。

## 两个策略

| | 标准（ZCode 原版） | 激进 |
|---|---|---|
| 重试间隔 | 指数退避 2s→4s→8s…，封顶 60s，带抖动 | 线性 1-2-3-4-5s，封顶 5s，无抖动 |
| 最大重试次数 | 10 次 | 1000 次 |
| 配额类限流错误（429 / insufficient_quota 等） | 不重试，直接失败 | 持续重试（若是"余额不足"这类长期问题，最坏约 83 分钟后放弃） |

## 目录结构

```
zcode-vendor-strategy/
├── marketplace.json                    # 本地市场清单（dev-retry-strategy）
├── docs/ZCode重试策略修改说明.md        # 底层原理与手工修改手册
└── retry-strategy/                     # 插件本体
    ├── .zcode-plugin/plugin.json       # 插件清单
    ├── commands/retry-strategy.md      # /retry-strategy 命令
    ├── hooks/hooks.json                # SessionStart 钩子（启动时自动保持策略）
    ├── scripts/apply-retry.mjs         # 核心脚本（apply / auto / status）
    └── README.md                       # 插件内说明
```

## 安装

1. 把本仓库 clone（或下载）到本地目录；
2. 打开 ZCode 的**插件市场 → 添加 → 添加插件市场**，粘贴该目录；
3. 到**个人**里找到市场 `dev-retry-strategy` → 插件 **Retry Strategy（重试策略）** → 点击**安装**；
4. 安装后可在 **设置 → 插件** 中管理。

## 使用

1. 在输入框输入 `/retry-strategy`（或直接 `/retry-strategy 激进`），按提示选择「标准」或「激进」；
2. 脚本会对目标 `zcode.cjs` 做 6 处精确字符串替换，写入前做编译级语法校验、失败自动回滚；
3. **重启 ZCode 后生效**（正在运行的进程内存里仍是旧代码）；
4. 之后每次启动 ZCode，SessionStart 钩子自动保持所选策略。

随时用 `/retry-strategy 标准` 切回原版行为（切换后与安装原版逐字节一致）。

## 目标文件配置

脚本默认不知道 `zcode.cjs` 在哪个安装目录，按以下顺序定位，满足其一即可：

1. 命令行参数：`node apply-retry.mjs apply aggressive --file <zcode.cjs 路径>`
2. 环境变量：`ZCODE_RETRY_TARGET=<zcode.cjs 路径>`
3. 用户配置文件 `~/.zcode/retry-strategy-config.json`（推荐，钩子也会读取）：
   ```json
   { "zcodeCjs": "<ZCode安装目录>\\resources\\glm\\zcode.cjs" }
   ```

## 核心脚本用法

```bash
node scripts/apply-retry.mjs apply <standard|aggressive> [--file <路径>]   # 应用并保存选择
node scripts/apply-retry.mjs auto                          [--file <路径>]   # 按保存的选择保持（钩子用，无输出）
node scripts/apply-retry.mjs status                        [--file <路径>]   # 只读查看当前状态
```

安全机制：每个补丁片段必须精确唯一匹配，状态不明时拒绝修改；写入前 `vm.Script` 编译校验；标准 ↔ 激进互为逆操作、可随时切换。

## 开发与迭代

1. 修改插件源码（补丁片段常量在 `scripts/apply-retry.mjs` 顶部，对应 `docs/ZCode重试策略修改说明.md` 中的 6 处）；
2. 同步递增 `retry-strategy/.zcode-plugin/plugin.json` 和 `marketplace.json` 里的版本号；
3. 提交推送；在 ZCode **市场源**里刷新市场，再到**个人**页点击**更新**。

## 注意事项

- **必须重启 ZCode**，修改才会生效；
- ZCode 更新会覆盖 `resources/glm/zcode.cjs`——这是钩子每次启动自动重新应用的原因；
- 若 ZCode 更新后补丁片段匹配不上，脚本会安全报错并拒绝修改，届时需按新版运行时重新提取字符串（见 `docs/` 手册）；
- 钩子通过 PATH 上的 `node` 运行脚本，若运行环境找不到 node，把 `hooks/hooks.json` 里的 `"node"` 改成 node 的绝对路径。
