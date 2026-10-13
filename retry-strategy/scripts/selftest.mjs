#!/usr/bin/env node
/**
 * selftest.mjs — 离线自测：不需要安装 ZCode，也不读写任何真实文件。
 *
 * 用每个已知构建的锚点拼出样本，验证补丁工具的核心不变量：
 *   1) 能识别出正确的构建；
 *   2) aggressive 能把全部必需片段替换成目标串，且重复执行幂等；
 *   3) standard 能逐字节还原（standard ↔ aggressive 互为逆操作）；
 *   4) 缺少可选锚点的构建仍能正常工作；
 *   5) 认不出的内容一律拒绝修改。
 *
 * 用法: node scripts/selftest.mjs
 */
import { BUILDS, currentStrategyOf, detectBuild, planApply } from './retry-patch.mjs';

let failed = 0;
let passed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
}

function fixture(build, { withOptional = true } = {}) {
  const parts = ['var head=1'];
  for (const s of build.segments) {
    if (s.optional === true && !withOptional) continue;
    parts.push(s.std);
  }
  return `/* fixture: ${build.id} */${parts.join(';')};var tail=2;`;
}

for (const build of BUILDS) {
  console.log(`构建 ${build.id}`);

  const sample = fixture(build);
  const det = detectBuild(sample);
  check('识别构建', det !== null && det.build.id === build.id, det ? det.build.id : 'null');
  check('初始状态为 standard', currentStrategyOf(sample) === 'standard', currentStrategyOf(sample));

  const agg = planApply(sample, 'aggressive');
  check('aggressive 有改动', agg.changed === true);
  check(
    'aggressive 替换了全部片段',
    agg.messages.length === build.segments.length,
    `${agg.messages.length}/${build.segments.length}`
  );
  check('aggressive 后状态为 aggressive', currentStrategyOf(agg.content) === 'aggressive', currentStrategyOf(agg.content));
  check(
    'aggressive 后原文锚点全部消失',
    build.segments.every((s) => !agg.content.includes(s.std)),
    build.segments.filter((s) => agg.content.includes(s.std)).map((s) => s.name).join(', ')
  );

  const again = planApply(agg.content, 'aggressive');
  check('重复应用幂等', again.changed === false && again.messages.length === 0);

  const back = planApply(agg.content, 'standard');
  check('standard 有改动', back.changed === true);
  check('standard 后状态为 standard', currentStrategyOf(back.content) === 'standard', currentStrategyOf(back.content));
  check('standard 逐字节还原', back.content === sample);

  if (build.segments.some((s) => s.optional === true)) {
    const lean = fixture(build, { withOptional: false });
    const leanAgg = planApply(lean, 'aggressive');
    const required = build.segments.filter((s) => s.optional !== true).length;
    check('缺少可选锚点时仍能应用', leanAgg.changed === true && leanAgg.messages.length === required, `${leanAgg.messages.length}/${required}`);
    check('缺少可选锚点时能逐字节还原', planApply(leanAgg.content, 'standard').content === lean);
  }
}

console.log('未知内容');
const unknown = 'var x=1;function unrelated(){}';
check('识别不出构建', detectBuild(unknown) === null);
check('识别不出时状态为 unknown', currentStrategyOf(unknown) === 'unknown');
let threw = false;
try {
  planApply(unknown, 'aggressive');
} catch {
  threw = true;
}
check('识别不出时拒绝修改', threw);

console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
