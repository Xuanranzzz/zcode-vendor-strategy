/**
 * retry-patch.mjs — 重试策略补丁核心：锚点表、构建识别、应用/还原逻辑。
 *
 * 设计要点：
 *   - 锚点全部是「精确字符串」，并且要求在目标 zcode.cjs 中恰好出现 1 次；
 *   - 按 ZCode 构建分组：识别不出构建、片段状态不明时一律拒绝修改；
 *   - standard ↔ aggressive 互为逆操作，还原后与安装原版逐字节一致；
 *   - optional 片段只在部分构建中存在（缺失时跳过，不算异常）。
 *
 * ZCode 每次重新打包都会改掉压缩后的标识符（函数名/变量名），所以新增构建时
 * 需要按《ZCode重试策略修改说明》第十节重新提取锚点，再加一组 BUILDS 条目。
 */
import fs from 'node:fs';
import vm from 'node:vm';

/** needle 在 content 中出现的次数。 */
export function countOf(content, needle) {
  if (needle === '') return 0;
  let n = 0;
  let i = content.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = content.indexOf(needle, i + needle.length);
  }
  return n;
}

// ---------- 锚点常量 ----------

/** 配额类错误码短路集合的 18 个码（新旧构建完全一致）。 */
const QUOTA_CODES =
  '"1005","1308","1310","1313","1316","1317","1318","1319","1320","1321","2056","20097",' +
  '"insufficient_quota","credit_balance_exhausted","organization_spend_limit_exceeded",' +
  '"project_spend_limit_exceeded","organization_usage_limit_exceeded","exceeded_current_quota_error"';

const quotaSetStd = (v) => `${v}=new Set([${QUOTA_CODES}])`;
const quotaSetAgg = (v) => `${v}=new Set([])`;

/** 内联限流错误码条目（模型限流，新构建里独立成条且 retryable=false）。 */
const inlineRateLimited = (code, retryable) =>
  `["${code}",{code:Rs.ModelRateLimited,reason:vs.RateLimited,retryReason:el.RateLimited,retryable:${retryable}}]`;

// ---------- 构建 2026-10-10（当前版本，zcode.cjs 15,126,820 字节） ----------

const N = {
  // 延迟计算函数：原按 baseDelayMs × backoffFactor^(t-1) 指数退避 + 抖动
  delayStd:
    'function Moe(e,t,n){let o=e.baseDelayMs*e.backoffFactor**Math.max(0,t-1),i=Math.min(o,e.maxDelayMs);return iHs(n,o)?n:!e.jitter||i===0?i:Math.round(i*(.5+Math.random()*.5))}',
  delayAgg: 'function Moe(e,t,n){let s=Math.min(Math.max(0,t),5)*1e3;return Math.min(iHs(n,s)?n:s,5e3)}',
  // 默认重试参数（maxAttempts 含首次请求，1001 = 1000 次重试）
  paramsStd: 'PNe={backoffFactor:2,baseDelayMs:2e3,jitter:!0,maxAttempts:11,maxDelayMs:6e4};',
  paramsAgg: 'PNe={backoffFactor:1,baseDelayMs:1e3,jitter:!1,maxAttempts:1001,maxDelayMs:5e3};',
  // 配额类错误分类（被 14 个配额错误码共用）
  quotaClassStd: 'Aqs={code:Rs.ModelRateLimited,reason:vs.RateLimited,retryReason:el.RateLimited,retryable:!1}',
  quotaClassAgg: 'Aqs={code:Rs.ModelRateLimited,reason:vs.RateLimited,retryReason:el.RateLimited,retryable:!0}',
  quotaSetStd: quotaSetStd('hHs'),
  quotaSetAgg: quotaSetAgg('hHs'),
};

// ---------- 构建 2026-09-22（旧版本，保留兼容） ----------

const O = {
  delayStd:
    'function ire(e,t,n){let o=e.baseDelayMs*e.backoffFactor**Math.max(0,t-1),s=Math.min(o,e.maxDelayMs);return y4s(n,o)?n:!e.jitter||s===0?s:Math.round(s*(.5+Math.random()*.5))}',
  delayAgg: 'function ire(e,t,n){let s=Math.min(Math.max(0,t),5)*1e3;return Math.min(y4s(n,s)?n:s,5e3)}',
  paramsStd: 'EDe={backoffFactor:2,baseDelayMs:2e3,jitter:!0,maxAttempts:11,maxDelayMs:6e4};',
  paramsAgg: 'EDe={backoffFactor:1,baseDelayMs:1e3,jitter:!1,maxAttempts:1001,maxDelayMs:5e3};',
  // 旧构建专有：动态工作流子代理的瞬态退避
  subDelayStd: 'function nWo(e,t=Math.random){let n=Math.min(kWa,wWa*2**(e-1));return Math.round(n*(.5+.5*t()))}',
  subDelayAgg: 'function nWo(e,t=Math.random){return Math.min(Math.max(0,e)*1e3,kWa)}',
  subConstStd: 'wWa=2e3,kWa=6e4;',
  subConstAgg: 'wWa=1e3,kWa=5e3;',
  quotaClassStd: '$Ns={code:Cs.ModelRateLimited,reason:_s.RateLimited,retryReason:Qc.RateLimited,retryable:!1}',
  quotaClassAgg: '$Ns={code:Cs.ModelRateLimited,reason:_s.RateLimited,retryReason:Qc.RateLimited,retryable:!0}',
  quotaSetStd: quotaSetStd('I4s'),
  quotaSetAgg: quotaSetAgg('I4s'),
};

// ---------- 构建表（新构建在前；识别时取匹配数最多的一组） ----------

export const BUILDS = [
  {
    id: '2026-10-10',
    note: 'ZCode 2026-10-10 构建（zcode.cjs 15,126,820 字节，函数名 Moe/PNe/Aqs/hHs）',
    segments: [
      { name: '延迟计算函数', std: N.delayStd, agg: N.delayAgg },
      { name: '默认重试参数', std: N.paramsStd, agg: N.paramsAgg },
      { name: '配额错误分类', std: N.quotaClassStd, agg: N.quotaClassAgg },
      { name: '配额码短路集合', std: N.quotaSetStd, agg: N.quotaSetAgg },
      // 以下三条补齐本次构建把 4 个配额码拆成内联条目后丢失的重试覆盖（1005 归类为
      // InvalidRequest，保持不重试；3008/3009/3010/1304 是 ZCode 的显式策略，不动）。
      { name: '限流码 1308', std: inlineRateLimited('1308', '!1'), agg: inlineRateLimited('1308', '!0'), optional: true },
      { name: '限流码 1310', std: inlineRateLimited('1310', '!1'), agg: inlineRateLimited('1310', '!0'), optional: true },
      { name: '限流码 1313', std: inlineRateLimited('1313', '!1'), agg: inlineRateLimited('1313', '!0'), optional: true },
    ],
  },
  {
    id: '2026-09-22',
    note: 'ZCode 2026-09-22 构建（函数名 ire/EDe/nWo/$Ns/I4s）',
    segments: [
      { name: '延迟计算函数', std: O.delayStd, agg: O.delayAgg },
      { name: '默认重试参数', std: O.paramsStd, agg: O.paramsAgg },
      { name: '子代理退避函数', std: O.subDelayStd, agg: O.subDelayAgg },
      { name: '子代理退避常量', std: O.subConstStd, agg: O.subConstAgg },
      { name: '配额错误分类', std: O.quotaClassStd, agg: O.quotaClassAgg },
      { name: '配额码短路集合', std: O.quotaSetStd, agg: O.quotaSetAgg },
    ],
  },
];

// ---------- 构建识别与状态 ----------

function scoreBuild(build, content) {
  let score = 0;
  for (const s of build.segments) {
    if (countOf(content, s.std) === 1 || countOf(content, s.agg) === 1) score += 1;
  }
  return score;
}

/** 识别当前文件属于哪个构建；识别不出返回 null。 */
export function detectBuild(content) {
  let best = null;
  for (const build of BUILDS) {
    const score = scoreBuild(build, content);
    if (score > 0 && (best === null || score > best.score)) best = { build, score };
  }
  return best;
}

/** 供 status 使用：每个构建、每个锚点的匹配计数。 */
export function buildReport(content) {
  return BUILDS.map((build) => ({
    id: build.id,
    note: build.note,
    matched: scoreBuild(build, content),
    segments: build.segments.map((s) => ({
      name: s.name,
      optional: s.optional === true,
      std: countOf(content, s.std),
      agg: countOf(content, s.agg),
    })),
  }));
}

/** 当前策略：standard / aggressive / partial / unknown。 */
export function currentStrategyOf(content) {
  const det = detectBuild(content);
  if (!det) return 'unknown';
  const required = det.build.segments.filter((s) => s.optional !== true);
  const std = required.filter((s) => countOf(content, s.std) === 1).length;
  const agg = required.filter((s) => countOf(content, s.agg) === 1).length;
  if (std === required.length && agg === 0) return 'standard';
  if (agg === required.length && std === 0) return 'aggressive';
  return 'partial';
}

// ---------- 应用 / 还原 ----------

/**
 * 纯函数：算出把 original 变成目标策略后的内容。
 * @returns {{build:string, changed:boolean, content:string, messages:string[]}}
 */
export function planApply(original, strategy) {
  if (strategy !== 'standard' && strategy !== 'aggressive') {
    throw new Error(`未知策略「${strategy}」，只能是 standard 或 aggressive。`);
  }
  const det = detectBuild(original);
  if (!det) {
    throw new Error(
      '未能识别当前 ZCode 构建：补丁锚点一个都匹配不到，目标文件可能已被 ZCode 更新改版。\n' +
        '请运行 status 查看每个锚点的匹配情况，并按《ZCode重试策略修改说明》第十节重新提取锚点。'
    );
  }
  const { build } = det;
  let content = original;
  const messages = [];
  for (const seg of build.segments) {
    const from = strategy === 'aggressive' ? seg.std : seg.agg;
    const to = strategy === 'aggressive' ? seg.agg : seg.std;
    const fromCount = countOf(content, from);
    const toCount = countOf(content, to);
    if (fromCount === 0 && toCount > 0) continue; // 已是目标状态
    if (fromCount === 0 && toCount === 0) {
      if (seg.optional === true) continue; // 该构建没有这个可选锚点
      throw new Error(
        `[${build.id}] 片段「${seg.name}」既匹配不到原文也匹配不到目标串，` +
          '目标文件可能已被 ZCode 更新改版。请勿手工强行修改，可运行 status 查看详情。'
      );
    }
    if (fromCount !== 1 || toCount > 0) {
      throw new Error(
        `[${build.id}] 片段「${seg.name}」状态不明（原文 ${fromCount} 次、目标 ${toCount} 次），拒绝修改。`
      );
    }
    content = content.split(from).join(to);
    messages.push(`${seg.name}: 已替换`);
  }
  return { build: build.id, changed: content !== original, content, messages };
}

/** 写入前做编译级语法校验（等价于 node --check），通过后原子替换。 */
export function writeTargetAtomic(target, content) {
  try {
    new vm.Script(content, { filename: 'zcode.cjs' });
  } catch (e) {
    throw new Error(
      `语法校验失败，已回滚，未修改任何文件。\n${String(e && e.message ? e.message : e).slice(0, 800)}`
    );
  }
  const tmp = `${target}.tmp-check`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

/** 对磁盘上的目标文件应用策略。 */
export function applyToState(target, strategy) {
  const original = fs.readFileSync(target, 'utf8');
  const plan = planApply(original, strategy);
  if (plan.changed) writeTargetAtomic(target, plan.content);
  return { target, strategy, build: plan.build, changed: plan.changed, messages: plan.messages };
}
