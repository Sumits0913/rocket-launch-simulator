/* =============================================================================
 * score.js —— 评分与成就
 * -----------------------------------------------------------------------------
 * 依据：design/gdd/modes.md §2.4 评分、§2.5 成就系统
 *
 * 评分原则（modes.md §2.4 原文）：
 *   "成功入轨"本身不计分也不扣分，分数量的是"飞得好不好"。
 *   这样第一次打的学生不会因为"分数低"而丧失成就感。
 * 所以下面 evaluate() 的入轨判定（ok）与总分（total）是【两条独立的线】：
 * 没入轨也给分（只要不是坠毁），只是评级低。
 *
 * 四项的满分条件（照抄文档，未做任何"手感调整"）：
 *   入轨精度 40 = 40 × (1 − |h_p−H|/60 − |h_a−H|/60)，下限 0
 *   Δv 效率   30 = 30 × min(1, 预算 t / 实际消耗 t)
 *   Max-Q 控制 15 = 15 × clamp((40 − q_peak kPa)/15, 0, 1)
 *   过载控制   15 = 15 × clamp((6.0 − a_max g)/1.5, 0, 1)
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var isNode = (typeof require === 'function' && typeof module === 'object');
  var C = isNode ? require('../core/constants.js') : root.RK.Constants;
  var api = factory(C);
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  (root.RK = root.RK || {}).Score = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  var BEST_KEY = 'launchsim.best.v1';
  var ACH_KEY = 'launchsim.achievements.v1';

  /* ---- 存档（隐私模式下 localStorage 会抛异常 → 降级为内存）-------------- */
  var mem = {};
  function readRaw(k) {
    try { return window.localStorage.getItem(k); }
    catch (e) { return mem[k] || null; }
  }
  function writeRaw(k, v) {
    try { window.localStorage.setItem(k, v); } catch (e) { mem[k] = v; }
  }
  function readJSON(k, dft) {
    var raw = readRaw(k);
    if (!raw) { return dft; }
    try { return JSON.parse(raw) || dft; } catch (e) { return dft; }
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ---------------------------------------------------------------------------
   * 评分
   * @param {object} sim   Sim 实例（应处于 orbit / complete / failed）
   * @param {object} opt   { targetAlt, s3BudgetKg }
   * @returns {object} { ok, total, parts, grade, gradeText, detail }
   * ------------------------------------------------------------------------ */
  function evaluate(sim, opt) {
    opt = opt || {};
    var el = sim.tele.el || sim.orbitEl;
    var targetM = opt.targetAlt || (sim.veh && sim.veh.targetAlt) || 200e3;
    var budgetT = (opt.s3BudgetKg || (sim.target && sim.target.s3Budget) || 18e3) / 1000;
    var s3t = sim.s3PropUsed / 1000;

    var ok = false, soft = false;
    var hp = el ? el.hp : -1e9, ha = el ? el.ha : Infinity;
    var okCfg = sim.orbitOk || C.ORBIT_OK;
    if (el && !el.hyperbolic) {
      soft = hp >= (okCfg.softHp || 100e3);
      ok = hp >= (okCfg.successHp || 180e3) && ha <= (okCfg.successHa || 245e3);
    }

    // 1) 入轨精度：近/远地点各自按 60 km 容扣分（modes.md §2.4）
    var prec = 0;
    if (el && isFinite(ha)) {
      prec = 40 * (1 - Math.abs(hp - targetM) / 60e3 - Math.abs(ha - targetM) / 60e3);
      if (!(prec > 0)) { prec = 0; }
    }

    // 2) Δv 效率：以目标轨道的三级预算为基准
    var dvEff = s3t > 0 ? 30 * Math.min(1, budgetT / s3t) : 30;

    // 3) Max-Q 控制：峰值 ≤ 25 kPa 满分
    var qScore = 15 * clamp((40 - sim.peakQ / 1000) / 15, 0, 1);

    // 4) 过载控制：峰值 ≤ 4.5 g 满分
    var gScore = 15 * clamp((6.0 - sim.peakG) / 1.5, 0, 1);

    var total = prec + dvEff + qScore + gScore;
    if (!isFinite(total)) { total = 0; }

    var grade = 'D', gradeText = '成功就是成功。再试一次会更好。';
    if (total >= 90) { grade = 'S'; gradeText = '完美的飞行。中国航天需要你。'; }
    else if (total >= 75) { grade = 'A'; gradeText = '轨道精度与燃料效率都很好。'; }
    else if (total >= 60) { grade = 'B'; gradeText = '成功入轨，还有优化空间。'; }
    else if (total >= 40) { grade = 'C'; gradeText = '入轨了，但浪费了不少推进剂。'; }

    return {
      ok: ok, soft: soft, total: total, grade: grade, gradeText: gradeText,
      parts: { precision: prec, dvEff: dvEff, maxQ: qScore, gForce: gScore },
      detail: {
        hp: hp, ha: ha, s3t: s3t, budgetT: budgetT,
        peakQ: sim.peakQ, peakG: sim.peakG,
        dvGrav: sim.tele.dvGrav, dvDrag: sim.tele.dvDrag,
        dvSteerSelf: sim.tele.dvSteerSelf,
        residual: sim.tele.residual
      }
    };
  }

  /* ---------------------------------------------------------------------------
   * 成就（modes.md §2.5，按"理解程度"设计，不按通关次数）
   * ------------------------------------------------------------------------ */
  var ACH = [
    { id: 'A1', name: '首次入轨', desc: '完成第一次成功入轨' },
    { id: 'A2', name: '精确入轨', desc: '入轨精度分 ≥ 36（近/远地点偏差 ≤ 12 km）' },
    { id: 'A3', name: '高效飞行', desc: '三级消耗 ≤ 16 t' },
    { id: 'A4', name: '平稳飞行', desc: '最大过载 ≤ 4.5 g' },
    { id: 'A5', name: 'Max-Q 大师', desc: '动压峰值 ≤ 25 kPa' },
    { id: 'A6', name: '教科书式转弯', desc: '重力损失 ≤ 1450 m/s' },
    { id: 'A7', name: '手动飞行', desc: '关闭自动驾驶（全手动）完成入轨' },
    /* A8 换过一次定义。原定义是「满载荷：用 70 t 载荷完成入轨」，但 70 t 构型
     * 的弹道从未标定，载荷选项删除后它永远不可能解锁（2026-09-03）。
     * 现改为「400 km 目标轨道完成入轨」：400 km 有独立标定的制导参数
     * （实测 hp 370.5 / ha 400.0 km、三级实耗 21.77 t），确实可达；而且比
     * 200 km 多花约 7.4 t 推进剂，是一个真实的挑战梯度，不是白送。
     *
     * ⚠ 为什么必须补回来而不是留空：运行说明与 UI 徽章区都是按 A1–A10 十格
     *   排的，少一个学生对着说明书数一遍就发现对不上 —— 那比一个难拿的
     *   勋章更刺眼。id 不重编号，A9 / A10 保持原值。 */
    { id: 'A8', name: '空间站轨道', desc: '在 400 km 目标轨道完成入轨' },
    { id: 'A9', name: '数据核验员', desc: '在核验面板累计停留 3 分钟' },
    { id: 'A10', name: '教员', desc: '演示模式累计播放 10 次' }
  ];
  var ACH_BY_ID = {};
  ACH.forEach(function (a) { ACH_BY_ID[a.id] = a; });

  function unlocked() { return readJSON(ACH_KEY, {}); }

  /**
   * 检查本次飞行解锁了哪些成就。
   * @param {object} ctx { result, sim, targetAlt, manual, demoPlays, checkMinutes }
   * @returns {Array} 新解锁的成就对象数组
   */
  function check(ctx) {
    var have = unlocked();
    var got = [];
    var res = ctx.result || {};
    var d = res.detail || {};

    function give(id) { if (!have[id]) { have[id] = Date.now(); got.push(ACH_BY_ID[id]); } }

    if (res.ok) {
      give('A1');
      if ((res.parts && res.parts.precision >= 36)) { give('A2'); }
      if (d.s3t > 0 && d.s3t <= 16) { give('A3'); }
      if (d.peakG <= 4.5) { give('A4'); }
      if (d.peakQ <= 25e3) { give('A5'); }
      if (d.dvGrav <= 1450) { give('A6'); }
      if (ctx.manual) { give('A7'); }
      /* A8：400 km 目标轨道入轨。
       * 判据跟着 res.ok 走（hp ≥ 370 km 且 ha ≤ 460 km 的 400 km 专属门槛），
       * 所以"勉强蹭上去"不算，得真入轨。
       * 演示模式不会走到这里 —— main.js 的 `mode !== 'demo'` 守卫把整个计分与
       * 成就块都包住了，演示那条分支传的 result 是 null，res.ok 为 falsy。 */
      if (ctx.targetAlt >= 400e3) { give('A8'); }
    }
    if ((ctx.checkMinutes || 0) >= 3) { give('A9'); }
    if ((ctx.demoPlays || 0) >= 10) { give('A10'); }

    if (got.length) { writeRaw(ACH_KEY, JSON.stringify(have)); }
    return got;
  }

  /** 最佳成绩：按 "难度@目标高度" 分组记录 */
  function best(difficulty, targetKm) {
    var all = readJSON(BEST_KEY, {});
    return all[difficulty + '@' + targetKm] || null;
  }

  function submit(difficulty, targetKm, score, grade) {
    var all = readJSON(BEST_KEY, {});
    var key = difficulty + '@' + targetKm;
    var prev = all[key];
    var isNew = !prev || score > prev.score;
    if (isNew) {
      all[key] = { score: score, grade: grade, at: Date.now() };
      writeRaw(BEST_KEY, JSON.stringify(all));
    }
    return { isNew: isNew, best: all[key] };
  }

  return {
    ACH: ACH,
    ACH_BY_ID: ACH_BY_ID,
    evaluate: evaluate,
    check: check,
    unlocked: unlocked,
    best: best,
    submit: submit
  };
});
