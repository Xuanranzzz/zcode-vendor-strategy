#!/usr/bin/env node
/**
 * apply-retry.mjs — 在 ZCode 的 zcode.cjs 上应用/还原“模型请求重试策略”。
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
 * status: 只读打印当前状态，不修改任何文件。
 *
 * 安全机制：
 *   - 每个补丁片段必须是精确唯一匹配，状态不明时拒绝修改并报错；
 *   - 写入前先做编译级语法校验（vm.Script，等价于 node --check），通过后原子替换；
 *   - 全部替换可逆（standard ↔ aggressive 互为逆操作），不依赖备份文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// ---------- 补丁片段（与《ZCode重试策略修改说明》一致，均为精确字符串） ----------

const IRE_OLD = 'function ire(e,t,n){let o=e.baseDelayMs*e.backoffFactor**Math.max(0,t-1),s=Math.min(o,e.maxDelayMs);return y4s(n,o)?n:!e.jitter||s===0?s:Math.round(s*(.5+Math.random()*.5))}';
const IRE_NEW = 'function ire(e,t,n){let s=Math.min(Math.max(0,t),5)*1e3;return Math.min(y4s(n,s)?n:s,5e3)}';

const EDE_OLD = 'EDe={backoffFactor:2,baseDelayMs:2e3,jitter:!0,maxAttempts:11,maxDelayMs:6e4};';
const EDE_NEW = 'EDe={backoffFactor:1,baseDelayMs:1e3,jitter:!1,maxAttempts:1001,maxDelayMs:5e3};';

const NWO_OLD = 'function nWo(e,t=Math.random){let n=Math.min(kWa,wWa*2**(e-1));return Math.round(n*(.5+.5*t()))}';
const NWO_NEW = 'function nWo(e,t=Math.random){return Math.min(Math.max(0,e)*1e3,kWa)}';

const CONST_OLD = 'wWa=2e3,kWa=6e4;';
const CONST_NEW = 'wWa=1e3,kWa=5e3;';

const NS_OLD = '$Ns={code:Cs.ModelRateLimited,reason:_s.RateLimited,retryReason:Qc.RateLimited,retryable:!1}';
const NS_NEW = '$Ns={code:Cs.ModelRateLimited,reason:_s.RateLimited,retryReason:Qc.RateLimited,retryable:!0}';

const I4S_OLD = 'I4s=new Set(["1005","1308","1310","1313","1316","1317","1318","1319","1320","1321","2056","20097","insufficient_quota","credit_balance_exhausted","organization_spend_limit_exceeded","project_spend_limit_exceeded","organization_usage_limit_exceeded","exceeded_current_quota_error"])';
const I4S_NEW = 'I4s=new Set([])';

const STRATEGIES = {
  aggressive: [
    [IRE_OLD, IRE_NEW],
    [EDE_OLD, EDE_NEW],
    [NWO_OLD, NWO_NEW],
    [CONST_OLD, CONST_NEW],
    [NS_OLD, NS_NEW],
    [I4S_OLD, I4S_NEW],
  ],
  standard: [
    [IRE_NEW, IRE_OLD],
    [EDE_NEW, EDE_OLD],
    [NWO_NEW, NWO_OLD],
    [CONST_NEW, CONST_OLD],
    [NS_NEW, NS_OLD],
    [I4S_NEW, I4S_OLD],
  ],
};

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

// ---------- 核心替换逻辑 ----------

function countOf(content, needle) {
  if (needle === '') return 0;
  let n = 0;
  let i = content.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = content.indexOf(needle, i + needle.length);
  }
  return n;
}

function writeTargetAtomic(target, content) {
  // 语法校验：只编译不执行（等价于 node --check，且不受临时文件扩展名限制）
  try {
    new vm.Script(content, { filename: 'zcode.cjs' });
  } catch (e) {
    throw new Error(`语法校验失败，已回滚，未修改任何文件。\n${String(e && e.message ? e.message : e).slice(0, 800)}`);
  }
  const tmp = `${target}.tmp-check`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

function currentStrategyOf(content) {
  const aggressiveCount = countOf(content, EDE_NEW);
  const standardCount = countOf(content, EDE_OLD);
  const partial = STRATEGIES.aggressive.some(([from, to]) => countOf(content, from) > 0 && countOf(content, to) > 0);
  if (partial) return 'partial';
  if (aggressiveCount > 0 && standardCount === 0) return 'aggressive';
  if (standardCount > 0 && aggressiveCount === 0) return 'standard';
  return 'unknown';
}

// ---------- 各模式 ----------

function applyToState(target, strategy) {
  const original = fs.readFileSync(target, 'utf8');
  const pairs = STRATEGIES[strategy];
  let content = original;
  const messages = [];
  let changed = false;
  for (let idx = 0; idx < pairs.length; idx += 1) {
    const [from, to] = pairs[idx];
    const fromCount = countOf(content, from);
    const toCount = countOf(content, to);
    if (fromCount === 0 && toCount > 0) continue;
    if (fromCount === 0 && toCount === 0) {
      throw new Error(`片段 #${idx + 1} 既匹配不到原文也匹配不到目标串，目标文件可能已被 ZCode 更新改版。请勿手工强行修改，可运行 status 查看详情。`);
    }
    if (fromCount !== 1 || toCount > 0) {
      throw new Error(`片段 #${idx + 1} 状态不明（原文 ${fromCount} 次、目标 ${toCount} 次），拒绝修改。`);
    }
    content = content.split(from).join(to);
    messages.push(`片段 #${idx + 1}: 已替换`);
    changed = true;
  }
  if (changed) writeTargetAtomic(target, content);
  return { target, strategy, changed, messages };
}

function writeStatus(target, data) {
  const { status } = sideFiles(target);
  try {
    fs.writeFileSync(status, JSON.stringify({ ...data, at: new Date().toISOString() }, null, 2), 'utf8');
  } catch (e) {
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

// ---------- 入口 ----------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveTarget(args.file);

  if (args.mode === 'status') {
    const content = fs.readFileSync(target, 'utf8');
    const choice = readChoice(target);
    const current = currentStrategyOf(content);
    const out = {
      target,
      currentStrategy: current,
      savedChoice: choice ? choice.strategy : null,
      fileSizeBytes: Buffer.byteLength(content),
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
      strategy: args.strategy,
      changed: res.changed,
      message: res.changed
        ? `已应用「${args.strategy === 'aggressive' ? '激进' : '标准'}」策略（${res.messages.length} 处替换），语法校验通过，已原子写入。重启 ZCode 后生效。`
        : `目标文件已经是「${args.strategy === 'aggressive' ? '激进' : '标准'}」策略，无需修改。`,
      applied: res.messages,
    };
    writeStatus(target, summary);
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return 0;
  }

  if (args.mode === 'auto') {
    // 钩子模式：stdout 必须为空；任何异常都不阻塞会话，详情记入状态文件。
    try {
      const choice = readChoice(target);
      if (!choice) {
        writeStatus(target, { ok: true, applied: false, reason: 'no-saved-choice', target });
        return 0;
      }
      const res = applyToState(target, choice.strategy);
      writeStatus(target, {
        ok: true,
        target,
        strategy: choice.strategy,
        changed: res.changed,
        message: res.changed ? 'auto: 已保持所选策略' : 'auto: 已是最新状态',
      });
      return 0;
    } catch (e) {
      try {
        writeStatus(target, { ok: false, target, error: String(e && e.stack ? e.stack : e) });
      } catch { /* 忽略 */ }
      return 0;
    }
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
