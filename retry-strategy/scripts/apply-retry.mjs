#!/usr/bin/env node
/**
 * apply-retry.mjs — 在 ZCode 的 zcode.cjs 上应用/还原“模型请求重试策略”（CLI）。
 *
 * 用法:
 *   node apply-retry.mjs apply <standard|aggressive> [--file <zcode.cjs 路径>]
 *   node apply-retry.mjs auto                        [--file <zcode.cjs 路径>]
 *   node apply-retry.mjs status                      [--file <zcode.cjs 路径>]
 *
 * apply : 按指定策略修改目标文件（幂等），并把选择写入 <目标目录>/retry-strategy-choice.json。
 * auto  : 供 SessionStart 钩子调用——按已保存的选择把目标文件保持到对应状态；
 *         无已保存选择或发生任何错误时均不改动文件、stdout 保持为空、退出码 0（绝不阻塞会话）。
 *         错误详情写入 <目标目录>/retry-strategy-status.json。
 * status: 只读打印当前状态与每个锚点的匹配计数，不修改任何文件。
 *
 * 补丁锚点、构建识别与替换逻辑见 scripts/retry-patch.mjs；
 * 离线往返自测见 scripts/selftest.mjs。
 */
import fs from 'node:fs';
import path from 'node:path';
import { applyToState, buildReport, currentStrategyOf, detectBuild } from './retry-patch.mjs';

// ---------- 目标文件定位 ----------

const USER_CONFIG_PATH = path.join(
  process.env.USERPROFILE || process.env.HOME || '.',
  '.zcode',
  'retry-strategy-config.json'
);

function readUserConfigTarget() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, 'utf8'));
    if (parsed && typeof parsed.zcodeCjs === 'string' && parsed.zcodeCjs) return parsed.zcodeCjs;
  } catch {
    /* 配置文件不存在或无效则忽略 */
  }
  return null;
}

function resolveTarget(flagValue) {
  const list = [
    flagValue ? path.resolve(flagValue) : null,
    process.env.ZCODE_RETRY_TARGET || null,
    readUserConfigTarget(),
  ].filter(Boolean);
  for (const c of list) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* 不存在则试下一个候选 */
    }
  }
  throw new Error(
    `找不到 zcode.cjs。请任选一种方式指定目标文件：\n` +
      `  1) --file <zcode.cjs 路径>\n` +
      `  2) 环境变量 ZCODE_RETRY_TARGET=<zcode.cjs 路径>\n` +
      `  3) 配置文件 ${USER_CONFIG_PATH}，内容 {"zcodeCjs": "<ZCode安装目录>\\\\resources\\\\glm\\\\zcode.cjs"}`
  );
}

function sideFiles(target) {
  const dir = path.dirname(target);
  return {
    choice: path.join(dir, 'retry-strategy-choice.json'),
    status: path.join(dir, 'retry-strategy-status.json'),
  };
}

function writeStatus(target, data) {
  const { status } = sideFiles(target);
  try {
    fs.writeFileSync(status, JSON.stringify({ ...data, at: new Date().toISOString() }, null, 2), 'utf8');
  } catch {
    // 状态文件写不进去不致命
  }
}

function readChoice(target) {
  const { choice } = sideFiles(target);
  try {
    const parsed = JSON.parse(fs.readFileSync(choice, 'utf8'));
    if (parsed && (parsed.strategy === 'standard' || parsed.strategy === 'aggressive')) return parsed;
    return null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = { mode: null, strategy: null, file: null };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--file') {
      out.file = argv[i + 1];
      i += 2;
    } else if (!a.startsWith('-')) {
      if (!out.mode) out.mode = a;
      else if (!out.strategy) out.strategy = a;
      else throw new Error(`无法识别的参数: ${a}`);
      i += 1;
    } else {
      throw new Error(`无法识别的参数: ${a}`);
    }
  }
  return out;
}

const labelOf = (strategy) => (strategy === 'aggressive' ? '激进' : '标准');

// ---------- 入口 ----------

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === 'auto') {
    // 钩子模式：stdout 必须为空；任何异常都不阻塞会话，详情记入状态文件。
    // 目标定位也放在 try 里：定位不到时同样只记录、不抛给 SessionStart。
    try {
      const target = resolveTarget(args.file);
      const choice = readChoice(target);
      if (!choice) {
        writeStatus(target, { ok: true, applied: false, reason: 'no-saved-choice', target });
        return 0;
      }
      const res = applyToState(target, choice.strategy);
      writeStatus(target, {
        ok: true,
        target,
        build: res.build,
        strategy: choice.strategy,
        changed: res.changed,
        message: res.changed ? 'auto: 已保持所选策略' : 'auto: 已是最新状态',
      });
      return 0;
    } catch (e) {
      try {
        const target = resolveTarget(args.file);
        writeStatus(target, { ok: false, target, error: String(e && e.stack ? e.stack : e) });
      } catch {
        /* 定位不到目标时无处写状态，静默忽略 */
      }
      return 0;
    }
  }

  const target = resolveTarget(args.file);

  if (args.mode === 'status') {
    const content = fs.readFileSync(target, 'utf8');
    const choice = readChoice(target);
    const det = detectBuild(content);
    const out = {
      target,
      currentStrategy: currentStrategyOf(content),
      detectedBuild: det ? det.build.id : null,
      savedChoice: choice ? choice.strategy : null,
      fileSizeBytes: Buffer.byteLength(content),
      builds: buildReport(content),
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  if (args.mode === 'apply') {
    if (args.strategy !== 'standard' && args.strategy !== 'aggressive') {
      throw new Error('apply 模式需要 <standard|aggressive>。');
    }
    const res = applyToState(target, args.strategy);
    const { choice } = sideFiles(target);
    fs.writeFileSync(choice, JSON.stringify({ strategy: args.strategy, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    const summary = {
      ok: true,
      target,
      build: res.build,
      strategy: args.strategy,
      changed: res.changed,
      message: res.changed
        ? `已应用「${labelOf(args.strategy)}」策略（${res.build} 构建，${res.messages.length} 处替换），语法校验通过，已原子写入。重启 ZCode 后生效。`
        : `目标文件已经是「${labelOf(args.strategy)}」策略，无需修改。`,
      applied: res.messages,
    };
    writeStatus(target, summary);
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return 0;
  }

  throw new Error('用法: apply <standard|aggressive> | auto | status [--file <path>]');
}

let exitCode = 0;
try {
  exitCode = main();
} catch (e) {
  process.stderr.write(`[apply-retry] ${e && e.stack ? e.stack : e}\n`);
  exitCode = 1;
}
process.exit(exitCode);
