# retry-strategy 插件

在 ZCode 的「标准 / 激进」两套模型请求重试策略之间切换，并在每次启动时自动保持所选策略。

## 两个策略

| | 标准（原版） | 激进 |
|---|---|---|
| 重试间隔 | 指数退避 2s→4s→8s…，封顶 60s，带 50%~100% 抖动 | 线性 1-2-3-4-5s，封顶 5s，无抖动 |
| 最大重试次数 | 10 次 | 1000 次 |
| 配额类限流错误（429 / insufficient_quota 等） | 不重试，直接失败 | 持续重试（长期性配额耗尽最坏约 83 分钟后放弃） |

## 用法

1. 安装插件后，在输入框输入 `/retry-strategy`（或 `/retry-strategy 激进`），按提示选择「标准」或「激进」。
2. 脚本会对 `zcode.cjs` 做**精确字符串替换**（共 6 处），写入前做编译级语法校验，通过后原子写入。
3. **重启 ZCode 后生效**（正在运行的进程内存里仍是旧代码）。
4. 之后每次启动 ZCode，SessionStart 钩子会按上次的选择自动保持状态——即使 ZCode 更新把 `zcode.cjs` 覆盖回原版，也会自动重新应用。

## 配置目标文件

脚本默认不知道 `zcode.cjs` 在哪（不同机器安装目录不同），按以下顺序定位，满足其一即可：

1. 命令行 `--file <zcode.cjs 路径>`；
2. 环境变量 `ZCODE_RETRY_TARGET=<zcode.cjs 路径>`；
3. 用户配置文件 `~/.zcode/retry-strategy-config.json`：
   ```json
   { "zcodeCjs": "<ZCode安装目录>\\resources\\glm\\zcode.cjs" }
   ```

推荐方式 3：配置文件在用户数据目录，不随 ZCode 更新/插件更新丢失，钩子（`auto` 模式）也会自动读取。

## 目录结构

- `commands/retry-strategy.md` — `/retry-strategy` 命令：交互式选择并应用策略。
- `hooks/hooks.json` — SessionStart 钩子（matcher: startup）：启动时以 `auto` 模式运行脚本。
- `scripts/apply-retry.mjs` — 核心脚本，三种模式：
  - `apply <standard|aggressive> [--file <路径>]`：应用策略并把选择存入目标目录的 `retry-strategy-choice.json`。
  - `auto [--file <路径>]`：按已保存的选择保持状态；无选择/出错时不动文件、退出码 0、无输出。
  - `status [--file <路径>]`：只读查看当前状态。

## 涉及文件

- 目标：`<ZCode安装目录>\resources\glm\zcode.cjs`（重试参数硬编码在打包的运行时里，无 JSON 配置可改）。
- 选择记录：目标同目录的 `retry-strategy-choice.json`
- 状态记录：目标同目录的 `retry-strategy-status.json`

## 安全机制

- 每个补丁片段必须精确唯一匹配；状态不明（找不到/多次出现）时拒绝修改并报错，绝不强行替换。
- 修改前用 `vm.Script` 做编译级语法校验，失败则回滚（不写入）。
- 标准 ↔ 激进互为逆操作，随时可切换回来；切换标准后与安装原版**逐字节一致**（已验证）。

## 注意事项

- 钩子通过 PATH 上的 `node` 运行脚本（`hooks/hooks.json` 里 `command: "node"`）。如果 hook 环境里找不到 node，把该值改成 node 的绝对路径。
- 若 ZCode 更新后补丁片段匹配不上，脚本会安全地报"片段状态不明"并拒绝修改——届时运行 `/retry-strategy` 查看具体报错，不要手工乱改打包文件。
- 应用更新不会覆盖插件（插件安装在用户数据目录，不在 ZCode 安装目录内）；但更新会覆盖 `zcode.cjs`，这正是钩子自动重新应用的原因。
