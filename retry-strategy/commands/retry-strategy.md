# 切换重试策略

帮用户把 ZCode 的模型请求重试策略在「标准」和「激进」之间切换。

## 两个选项

- **标准**（ZCode 原版行为）：指数退避 2s→4s→8s…，封顶 60s，带 50%~100% 随机抖动；最多重试 10 次；配额类限流错误（429 / insufficient_quota 等）不重试。
- **激进**：线性间隔 1-2-3-4-5 秒，封顶 5 秒，无抖动；最多重试 1000 次；配额类限流错误（429 / insufficient_quota 等）也会持续重试（若错误是长期性的余额/配额耗尽，最坏会重试约 83 分钟后放弃）。

## 执行步骤

1. 如果用户没有在命令后直接指定策略（例如「/retry-strategy 激进」），先向用户确认选「标准」还是「激进」，并简要说明两者区别。
2. 定位插件脚本（Windows 下用 Bash 执行；会同时找到本地市场源码和已安装副本，取第一个即可）：
   SCRIPT=$(find "$USERPROFILE/.zcode" -type f -name "apply-retry.mjs" 2>/dev/null | head -1)
   echo "$SCRIPT"
3. 执行（把 <strategy> 换成 standard 或 aggressive）：
   node "$SCRIPT" apply <strategy>
4. 查看输出：
   - 「已应用『激进/标准』策略（6 处替换），语法校验通过」→ 成功。
   - 「目标文件已经是『…』策略」→ 无需修改。
   - 报错（如「片段 #… 状态不明」「找不到 zcode.cjs」）→ 把报错原样展示给用户，不要强行修改文件。若提示找不到 zcode.cjs，引导用户通过 `--file <路径>`、环境变量 `ZCODE_RETRY_TARGET` 或配置文件 `~/.zcode/retry-strategy-config.json`（内容 `{"zcodeCjs": "<ZCode安装目录>\\resources\\glm\\zcode.cjs"}`）指定目标。
5. 成功后告知用户：**必须重启 ZCode 应用后生效**（正在运行的进程内存里还是旧代码）。之后每次启动 ZCode，插件会自动保持所选策略（包括 ZCode 更新覆盖后自动重新应用）。当前状态也可随时用 `node "$SCRIPT" status` 查看。
