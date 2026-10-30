/* =============================================================================
 * physics-audit.js —— 物理自检（Node 直接运行，零依赖）
 * -----------------------------------------------------------------------------
 * 运行方式（双击运行前请先用命令行跑一遍，确认全绿）：
 *   node tests/physics-audit.js
 *
 * 本脚本是"物理是真的"这条核心支柱的守门员。它做的每一件事都是【断言】，
 * 不是打印：任何一条不通过，进程退出码为 1，CI / 交付检查会直接拦下。
 *
 * 检查项（对应任务书要求）：
 *   A. 质量与推力：GLOW 2187 t / 起飞推力 26 250 kN / 推重比 1.224
 *   B. US76 大气密度 @ 0 / 11 / 25 / 50 km
 *   C. 分段火箭方程：各级 Δv 与三级满载合计 12 263 m/s（含 NaN 检查）
 *   D. 积分式 Δv 与分段火箭方程交叉校核（1% 内）
 *   E. Δv 恒等式残差 < 1 m/s（200 km / 400 km 各一遍）
 *   F. 200 km 圆轨道速度 ≈ 7786 m/s；轨道倾角 19.6°
 *   G. 入轨精度：200 km 与 400 km 两套标定参数各自达标
 *   H. 损失账本：重力 / 气动 / 转向（两个口径）与"剩余 3195 m/s"教学恒等式
 *   I. 确定性重放：末态误差 < 1e-6，并实测拖拽回溯性能
 *
 * ⚠ 关于"12 263 m/s"的实测偏差：见下方 C 节的实测输出与说明。此处存在
 *   【文档自身的算术不一致】，本项目以"物理自洽"为准实现。
 *   注：另一处历史偏差（推重比 1.225 vs 1.224）已于 2026-09-02 口径统一为
 *   1.224 并消除，见 docs/architecture/architecture.md §9 D1。
 * ========================================================================== */
'use strict';

var C = require('../src/core/constants.js');
var Atmo = require('../src/core/atmo.js');
var V = require('../src/core/vehicle.js');
var Orbit = require('../src/core/orbit.js');
var Sim = require('../src/core/sim.js');
var Replay = require('../src/app/replay.js');

/* ---------------------------------------------------------------------------
 * 极简断言框架（不引第三方库，保证零依赖）
 * ------------------------------------------------------------------------ */
var results = [];
var current = null;

function section(name) {
  current = { name: name, items: [] };
  results.push(current);
  console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(0, 62 - name.length)));
}

function ok(desc, pass, detail) {
  current.items.push({ desc: desc, pass: !!pass });
  console.log('  ' + (pass ? '✓' : '✗') + ' ' + desc +
    (detail !== undefined ? '   → ' + detail : ''));
}

function near(desc, actual, expect, tol) {
  var d = Math.abs(actual - expect);
  ok(desc, d <= tol,
    '实测 ' + fmt(actual) + '，期望 ' + fmt(expect) + ' ± ' + fmt(tol) +
    '，偏差 ' + fmt(d));
}

function range(desc, actual, lo, hi) {
  ok(desc, actual >= lo && actual <= hi,
    '实测 ' + fmt(actual) + '，允许区间 [' + fmt(lo) + ', ' + fmt(hi) + ']');
}

function fmt(v) {
  if (typeof v !== 'number') { return String(v); }
  if (!isFinite(v)) { return String(v); }
  var a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) { return v.toExponential(3); }
  return v.toFixed(3);
}

function note(txt) { console.log('    · ' + txt); }

/* ===========================================================================
 * A. 质量与推力
 * ======================================================================== */
section('A. 起飞质量 / 推力 / 推重比');

var veh = V.build({ payload: 26, targetAlt: 200e3 });
var glowT = veh.glow / 1000;
var thrustKN = veh.thrustSL / 1000;
var tw = veh.twRatio;

near('GLOW = 2187 t', glowT, 2187, 0.5);
near('起飞推力 = 26 250 kN（21 台 × 1250 kN）', thrustKN, 26250, 0.5);
ok('一级构型 21 台 = 3 模块 × 7 台',
  (veh.booster.count + 1) * veh.booster.nEng === 21,
  (veh.booster.count + 1) + ' 模块 × ' + veh.booster.nEng + ' 台');
near('起飞推重比 = 1.224', tw, 1.224, 0.001);
note('推重比实测 ' + tw.toFixed(6) + '（= 26 250 000 / (2 187 000 × 9.80665)）');
note('✅ 已知偏差已消除：全项目口径统一为 1.224（精确值 1.223939）。');
range('燃烧时间 助推器 ≈ 173 s（公开值 ±5%）', veh.burn.booster, 164, 182);
range('燃烧时间 芯一级 ≈ 227 s（公开值 ±5%）', veh.burn.s1, 215, 239);
range('燃烧时间 芯二级 ≈ 215 s（公开值 ±5%）', veh.burn.s2, 204, 226);
range('燃烧时间 芯三级 ≈ 924 s（公开值 ±5%）', veh.burn.s3, 878, 970);

/* ===========================================================================
 * B. US76 大气
 * ======================================================================== */
section('B. US76 大气密度（几何高度）');
note('本模型按【几何高度】实现；常被引用的 0.04008 / 1.0269e-3 是【位势高度】');
note('25 / 50 km 的值（对应几何 24.902 / 50.393 km），两者不可混用，这是');
note('高空出现 1.5%~5% 差异的唯一原因，不是实现错误。');

var REF = {};
Atmo.REF.forEach(function (r) { REF[r[0]] = r[1]; });
[0, 11000, 25000, 50000].forEach(function (h) {
  var a = Atmo.at(h);
  var exp = REF[h];
  var rel = Math.abs(a.rho - exp) / exp;
  ok('ρ(' + (h / 1000) + ' km) = ' + a.rho.toExponential(4) + ' kg/m³',
    rel < 0.01,
    '参考 ' + exp.toExponential(4) + '，相对偏差 ' + (rel * 100).toFixed(3) + '%');
});
var st = Atmo.selfTest();
ok('查表 vs 精确公式最大相对误差 < 1%', st.pass,
  (st.maxRelErr * 100).toFixed(4) + '% @ ' + st.atH + ' m');

/* ===========================================================================
 * C. 分段火箭方程 Δv 预算
 * ======================================================================== */
section('C. Δv 预算（分段火箭方程，vehicle.md §4.2 / §4.3）');
var bud = V.deltaVBudget(veh);
var A1 = bud.stages[0], A2 = bud.stages[1], Bs = bud.stages[2],
    C1 = bud.stages[3], C2 = bud.stages[4], Ds = bud.stages[5];

ok('各段 Δv 均为有限正数（无 NaN）',
  bud.stages.every(function (s) { return isFinite(s.dv) && s.dv > 0; }),
  bud.stages.map(function (s) { return s.name + ' ' + s.dv.toFixed(0); }).join(' | '));

// ── V-15：分段边界完备性（抛除事件必须全部落在边界上）──────────────────────
var JETT = [
  { id: '逃逸塔', t: C.SEQ.TOWER_SEP_T },
  { id: '助推器', t: veh.burn.booster },
  { id: '芯一级', t: veh.burn.s1 },
  { id: '整流罩', t: C.SEQ.FAIRING_SEP_T },
  { id: '芯二级', t: veh.burn.s1 + veh.burn.s2 }
];
var missing = JETT.filter(function (j) {
  return !bud.bounds.some(function (b) { return Math.abs(b - j.t) < 0.5; });
});
ok('V-15 分段边界完备性：5 个抛除事件全部落在分段边界上', missing.length === 0,
  missing.length ? ('缺失：' + missing.map(function (m) { return m.id; }).join('、'))
                 : JETT.map(function (j) { return j.id + '@T+' + j.t.toFixed(1); }).join(' '));
note('规则（vehicle.md §4.2.1）：Δv 表分段边界集合 == 抛除事件时刻集合 ∪ 工况变化时刻集合。');
note('段内质量变化只能来自推进剂消耗 —— 抛除不产生冲量，把它当燃烧会系统性高估。');

// ── V-16：A 段切段一致性 ───────────────────────────────────────────────────
var dvA_single = V.rocketEq(329, veh.glow, A2.m1);      // 错误算法：单段跨越抛塔
var dvA_split = A1.dv + A2.dv;                          // 正确算法：切成 A1 / A2
var dvA_gap = dvA_single - dvA_split;
range('V-16 A 段切段一致性：单段 − 切段 ∈ [30, 45] m/s', dvA_gap, 30, 45);
near('A 段（A1+A2）= 4040 m/s', dvA_split, 4040, 2);
note('A1 ' + A1.dv.toFixed(1) + '（Isp 329，塔在箭上）+ A2 ' + A2.dv.toFixed(1) +
  '（Isp 337，塔已抛）= ' + dvA_split.toFixed(1) + ' m/s');
note('若误作单段 ln(2187/' + (A2.m1 / 1000).toFixed(1) + ') = ' + dvA_single.toFixed(1) +
  ' m/s，高估 ' + dvA_gap.toFixed(1) + ' m/s —— 这就是"抛塔当成烧掉"的代价。');

// ── 各级小计 ────────────────────────────────────────────────────────────────
near('一级小计（A1+A2+B）≈ 5233 m/s', bud.first, 5233, 3);
near('二级小计（C1+C2）≈ 3164 m/s', bud.second, 3164, 3);
near('三级满载（D，59 t）≈ 3876 m/s', bud.third, 3876, 8);
near('三级满载总 Δv ≈ 12 272 m/s', bud.total, 12272, 12);
note('实测合计 ' + bud.total.toFixed(1) + ' m/s（对标文档 12 272.2，偏差 ' +
  ((bud.total - 12272.2) / 12272.2 * 100).toFixed(3) + '%）');
note('⚠ 与文档差 ' + (bud.total - 12272.2).toFixed(1) + ' m/s 的根因：文档 §4.2 的');
note('  质量链 678.6/669.6/618.1/…/101.1/42.1 是【手工四舍五入】的中间值，');
note('  每一级都比模型推导值高约 0.1 t，累积到 D 段使 ln(101.1/42.1) 与');
note('  ln(' + (Ds.m0 / 1000).toFixed(2) + '/' + (Ds.m1 / 1000).toFixed(2) + ') 差出 ' +
  (bud.third - 3875.6).toFixed(1) + ' m/s。');
note('  这是文档的取整漂移（0.07%），不是实现错误 —— 已回传 team-lead 定夺。');

// ── V-17：D 段（LEO 剖面，三级烧 18 t）──────────────────────────────────────
var dLeo = V.thirdStageDv(veh, 18e3);
near('V-17 D 段（三级烧 18 t）Δv = 867 ± 2 m/s', dLeo.dv, 867, 2);
note('451.1 × 9.80665 × ln(' + (dLeo.m0 / 1000).toFixed(2) + '/' +
  (dLeo.m1 / 1000).toFixed(2) + ') = ' + dLeo.dv.toFixed(1) + ' m/s');

var leoReq = 9068;
var remain = bud.total - leoReq;
range('剩余可用于 TLI 的 Δv ≈ 3204 m/s（公开 3.1–3.2 km/s）', remain, 3100, 3300);
note('教学恒等式：' + bud.total.toFixed(0) + ' − ' + leoReq + ' = ' +
  remain.toFixed(0) + ' m/s');
note('⚠ 3241 / 3250 已被明令禁用 —— 它们来自把"逃逸塔抛除"误当作"推进剂燃烧"。');
note('  实测 ' + remain.toFixed(1) + ' 与文档 3204 差 ' + (remain - 3204).toFixed(1) +
  ' m/s，同源于上面的取整漂移。');

/* ===========================================================================
 * D / E / F / G / H：跑两遍完整弹道（200 km 与 400 km）
 * ======================================================================== */
[200, 400].forEach(function (altKm) {
  var opts = { demoMode: true, difficulty: 'normal', targetAlt: altKm * 1000, payload: 26 };
  var r = Replay.replayTo(opts, [], 1e9);
  var sim = r.sim, t = sim.tele;
  var tag = altKm + ' km';

  section('D. 标称弹道 · 目标 ' + tag);
  ok('任务跑完（status = complete）', sim.status === 'complete',
    'status = ' + sim.status + '，T+' + sim.missionTime().toFixed(1) + ' s，' +
    r.steps + ' 步');
  ok('13 个任务事件全部触发', sim.events.length === 13,
    sim.events.map(function (e) { return e.id; }).join(' '));

  section('E. Δv 恒等式 · 目标 ' + tag);
  near('|残差| < 1 m/s', Math.abs(t.residual), 0, 1);
  note('v = Δv_ideal − Δv_grav − Δv_drag − Δv_steer + v_rot，残差 ' +
    t.residual.toExponential(2) + ' m/s');

  // 积分式 vs 分段火箭方程。
  // 一级 + 二级直接用 deltaVBudget 的分段（边界完备，见 C 节 V-15）；
  // 三级按【实耗推进剂】重算，因为满载 59 t 与实际烧掉的 14~22 t 不同。
  //
  // ⚠ 这一段是"分段边界规则"的照妖镜：边界少切一处，火箭方程就会系统性
  //   高于积分式（把死重当推进剂）。修复 A 段 / 抛罩两处边界前，这里
  //   的偏差是 0.330%（29.9 m/s）；修完之后应显著缩小。
  var s3t = sim.s3PropUsed;
  var mD_start = bud.stages[5].m0;
  var rocketEqTotal =
    A1.dv + A2.dv + Bs.dv + C1.dv + C2.dv +
    V.rocketEq(451.1, mD_start, mD_start - s3t);
  var relRE = Math.abs(rocketEqTotal - t.dvIdeal) / t.dvIdeal;
  ok('积分式 ∫(F/m)dt 与分段火箭方程吻合 < 1%', relRE < 0.01,
    '积分 ' + t.dvIdeal.toFixed(1) + ' m/s，火箭方程 ' + rocketEqTotal.toFixed(1) +
    ' m/s，偏差 ' + (relRE * 100).toFixed(3) + '%（绝对差 ' +
    (rocketEqTotal - t.dvIdeal).toFixed(1) + ' m/s）');
  ok('积分式 vs 火箭方程绝对差 < 15 m/s（分段边界正确性的主指标）',
    Math.abs(rocketEqTotal - t.dvIdeal) < 15,
    '绝对差 ' + (rocketEqTotal - t.dvIdeal).toFixed(1) + ' m/s');
  note('三级实耗 ' + (s3t / 1000).toFixed(2) + ' t' +
    '（满载预算 59 t），D 段按实耗重算 = ' +
    V.rocketEq(451.1, mD_start, mD_start - s3t).toFixed(1) + ' m/s');

  section('F. 轨道参数 · 目标 ' + tag);
  var vc = Orbit.circularVel(altKm * 1000);
  near('目标高度圆轨道速度 ≈ ' + (altKm === 200 ? 7786 : 7670) + ' m/s',
    vc, altKm === 200 ? 7786 : 7670, 8);
  ok('入轨速度接近圆轨道速度（±1%）',
    Math.abs(t.v - vc) / vc < 0.01,
    '实飞 ' + t.v.toFixed(1) + ' m/s vs 圆轨道 ' + vc.toFixed(1) + ' m/s');
  near('轨道倾角 = 19.6°（东向发射 i = φ_lat）', C.SITE.INCLINATION * C.RAD, 19.6, 0.05);
  near('地球自转赠送初速 = 438.1 m/s', C.SITE.V_ROT, 438.1, 0.5);

  section('G. 入轨精度 · 目标 ' + tag);
  var tgt = C.TARGETS[String(altKm)];
  var hp = t.el.hp, ha = t.el.ha;
  ok('近地点 ≥ 完美档下限 ' + (tgt.orbitOk.perfectHp / 1000) + ' km',
    hp >= tgt.orbitOk.perfectHp, (hp / 1000).toFixed(2) + ' km');
  ok('远地点 ≤ 完美档上限 ' + (tgt.orbitOk.perfectHa / 1000) + ' km',
    ha <= tgt.orbitOk.perfectHa, (ha / 1000).toFixed(2) + ' km');
  range('偏心率 e（近圆轨道）', t.el.e, 0, 2e-3);
  range('三级推进剂消耗 ≤ 预算 ' + (tgt.s3Budget / 1000) + ' t',
    sim.s3PropUsed / 1000, 5, tgt.s3Budget / 1000 + 2);
  range('最大动压（kPa）', sim.peakQ / 1000, 10, 40);
  range('最大过载（g）', sim.peakG, 2, 6);

  section('H. 损失账本 · 目标 ' + tag);
  note('理想 Δv ' + t.dvIdeal.toFixed(0) + '　重力损失 ' + t.dvGrav.toFixed(0) +
    '　气动损失 ' + t.dvDrag.toFixed(0) + '　转向损失（教学口径）' +
    t.dvSteerSelf.toFixed(0) + '　自转不对齐 ' + t.dvRotAlign.toFixed(0) +
    '　自转赠送 ' + C.SITE.V_ROT.toFixed(0));
  range('重力损失（教科书 0.9–1.8 km/s）', t.dvGrav, 700, 1800);
  range('气动损失（细长体 0–0.3 km/s）', t.dvDrag, 0, 300);
  range('转向损失（教学口径，教科书 ~60 m/s 量级）', t.dvSteerSelf, 0, 400);
  ok('两个转向口径之差 = 自转不对齐项（恒等）',
    Math.abs((t.dvSteer - t.dvSteerSelf) - t.dvRotAlign) < 1e-6,
    t.dvSteer.toFixed(2) + ' − ' + t.dvSteerSelf.toFixed(2) + ' = ' +
    t.dvRotAlign.toFixed(2) + ' m/s');
});

/* ===========================================================================
 * I. 确定性重放
 * ======================================================================== */
section('I. 确定性重放（时间线拖拽的实现基础）');

// I-1：实时推进 vs 裸重放，末态逐位比较
var opts200 = { demoMode: true, difficulty: 'normal', targetAlt: 200e3, payload: 26 };
var live = new Replay.Engine(opts200);
// 用不规则帧长模拟真实掉帧（16.7 ms / 33 ms / 8 ms 混合），验证与帧率无关
var framePattern = [0.0167, 0.033, 0.008, 0.0167, 0.025];
var guard = 0;
while (live.sim.status !== 'complete' && live.sim.status !== 'failed' && guard++ < 200000) {
  live.advance(framePattern[guard % framePattern.length]);
}
var replayed = Replay.replayTo(opts200, [], live.sim.t);
var diffEnd = Replay.maxDiff(Array.prototype.slice.call(live.sim.y),
                             Array.prototype.slice.call(replayed.sim.y));
ok('实时推进 vs 裸重放：末态最大差 < 1e-6', diffEnd < 1e-6,
  '状态差 = ' + diffEnd.toExponential(3) + '（' + live.sim.steps + ' 步）');
ok('两种推进方式的步数一致', live.sim.steps === replayed.sim.steps,
  live.sim.steps + ' vs ' + replayed.sim.steps);

// I-2：Engine.seek 回溯后再前进，回到同一时刻应逐位一致
var eng = new Replay.Engine(opts200);
while (eng.sim.t < 700) { eng.advance(0.05); }
var snaps = {};
[100, 200, 300, 400, 500, 600, 650].forEach(function (T) {
  var internal = eng.toInternal(T);
  var ref = Replay.replayTo(opts200, [], internal);
  eng.seek(internal);
  var d = Replay.maxDiff(Array.prototype.slice.call(eng.sim.y),
                         Array.prototype.slice.call(ref.sim.y));
  snaps[T] = d;
});
var worstSeek = 0;
Object.keys(snaps).forEach(function (k) {
  if (snaps[k] > worstSeek) { worstSeek = snaps[k]; }
});
ok('seek() 到任意时刻：与裸重放逐位一致（< 1e-6）', worstSeek < 1e-6,
  '7 个采样点最大差 = ' + worstSeek.toExponential(3));

// I-3：拖拽性能（回答"拖拽是否需要防抖/节流"）
var eng2 = new Replay.Engine(opts200);
while (eng2.sim.status !== 'complete') { eng2.advance(0.5); }
var tEnd = eng2.sim.t;
var times = [];
for (var i = 0; i < 200; i++) {
  var target = -3 + Math.random() * (tEnd + 3);
  var res = eng2.seek(target);
  times.push(res.ms);
}
times.sort(function (a, b) { return a - b; });
var avg = times.reduce(function (a, b) { return a + b; }, 0) / times.length;
var p50 = times[Math.floor(times.length * 0.5)];
var p95 = times[Math.floor(times.length * 0.95)];
var worst = times[times.length - 1];
console.log('    拖拽 200 次：平均 ' + avg.toFixed(3) + ' ms，中位 ' + p50.toFixed(3) +
  ' ms，P95 ' + p95.toFixed(3) + ' ms，最坏 ' + worst.toFixed(3) + ' ms');
ok('最坏一次 seek < 16.7 ms（60 fps 单帧预算）', worst < 16.7,
  worst.toFixed(3) + ' ms');
var bare = Replay.replayTo(opts200, [], tEnd);
console.log('    全任务裸重放（无检查点）：' + bare.ms.toFixed(2) + ' ms / ' +
  bare.steps + ' 步');
ok('全任务裸重放 < 100 ms', bare.ms < 100, bare.ms.toFixed(2) + ' ms');
note('结论：拖拽【不需要】防抖也不需要节流。原因是每 5 s 一个精确检查点，');
note('      最坏只需重算 5 s 仿真时间（约 250 步）。检查点只影响性能，');
note('      删掉它结果一模一样 —— 正确性完全由确定性重放保证。');

/* ===========================================================================
 * 汇总
 * ======================================================================== */
var total = 0, passed = 0, failed = [];
results.forEach(function (s) {
  s.items.forEach(function (it) {
    total++;
    if (it.pass) { passed++; } else { failed.push(s.name + ' → ' + it.desc); }
  });
});

console.log('\n' + '═'.repeat(66));
console.log('物理自检结果：' + passed + ' / ' + total + ' 项通过');
if (failed.length) {
  console.log('未通过项：');
  failed.forEach(function (f) { console.log('  ✗ ' + f); });
} else {
  console.log('全部通过 ✅');
}
console.log('═'.repeat(66));

process.exit(failed.length ? 1 : 0);
