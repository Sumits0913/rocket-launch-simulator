/* =============================================================================
 * vehicle.js —— 长征十号（CZ-10）基本型 + 梦舟载人飞船 的参数与质量模型
 * -----------------------------------------------------------------------------
 * 数据来源：design/gdd/vehicle.md §1 §2 §3 §6
 *           design/gdd/physics.md §10.1 发动机参数表
 *
 * 【重要】本文件只维护 质量 / 推进 / 比冲 / 燃烧时间。
 *         几何尺寸（全长、直径、分层长度）一律以 design/art/asset-spec.md §1.2
 *         为准，本文件不得出现第二套几何数字。
 *
 * 干重（45 / 54 / 22 / 10.5 t、整流罩 6 t、逃逸塔 9 t、适配器 5.5 t）为【近似】：
 * 官方未公开各级结构干重，vehicle.md §3 用"质量闭合 + 结构系数落在经验区间"
 * 两条约束反推得到。它是一组可行解，不是唯一解，但必须保持 Σ = 2187 t。
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var C = (typeof require === 'function' && typeof module === 'object')
    ? require('./constants.js')
    : root.RK.Constants;
  var api = factory(C);
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  (root.RK = root.RK || {}).Vehicle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  var G0 = C.G0;

  /* ---------------------------------------------------------------------------
   * 发动机参数表（physics.md §10.1）
   *   YF-100K/L：海平面 1250 kN / 301.6 s，真空 1396 kN / 337 s，节流 65%–105%
   *   YF-100M  ：真空 1460 kN / 352.3 s（高空型，无海平面工况，故取 Fsl=Fvac）
   *   YF-75E   ：真空  92.1 kN / 451.1 s（氢氧，不可节流【游戏】简化）
   * ------------------------------------------------------------------------ */
  var ENGINES = {
    YF100K: {
      name: 'YF-100K/L', prop: 'LOX/RP-1',
      Fsl: 1250e3, Ispsl: 301.6,
      Fvac: 1396e3, Ispvac: 337,
      throttle: true, source: '公开'
    },
    YF100M: {
      name: 'YF-100M', prop: 'LOX/RP-1',
      Fsl: 1460e3, Ispsl: 352.3,      // 一级以上点火，无海平面工况
      Fvac: 1460e3, Ispvac: 352.3,
      throttle: true, source: '公开'
    },
    YF75E: {
      name: 'YF-75E', prop: 'LOX/LH₂',
      Fsl: 92.1e3, Ispsl: 451.1,
      Fvac: 92.1e3, Ispvac: 451.1,
      throttle: false, source: '公开'
    }
  };

  /* ---------------------------------------------------------------------------
   * 级段构成（vehicle.md §2.2）
   *   助推器 ×2：每个 7 台 YF-100K，推进剂 520 t，干重 45 t
   *   芯一级    ：    7 台 YF-100K，推进剂 680 t，干重 54 t
   *   芯二级    ：    2 台 YF-100M，推进剂 185 t，干重 22 t
   *   芯三级    ：    3 台 YF-75E ，推进剂  59 t，干重 10.5 t
   *   整流罩 6 t / 逃逸塔 9 t / 船箭适配器 5.5 t
   * ------------------------------------------------------------------------ */
  var BASE = {
    tower:   { name: '逃逸塔',   dry: 9e3 },
    fairing: { name: '整流罩',   dry: 6e3 },
    adapter: { name: '船箭适配器', dry: 5.5e3 },
    booster: { name: '助推器',   dry: 45e3, prop: 520e3, count: 2, nEng: 7, eng: 'YF100K' },
    s1:      { name: '芯一级',   dry: 54e3, prop: 680e3, count: 1, nEng: 7, eng: 'YF100K' },
    s2:      { name: '芯二级',   dry: 22e3, prop: 185e3, count: 1, nEng: 2, eng: 'YF100M' },
    s3:      { name: '芯三级',   dry: 10.5e3, prop: 59e3, count: 1, nEng: 3, eng: 'YF75E' }
  };

  /* 梦舟载人飞船（vehicle.md §6）
   *
   * ⚠ 只有 26 t 一个构型。这里曾经还有 14 t（近地版）和 70 t（满载荷·教学用），
   *   但两者的弹道从未标定过，实测：
   *     · 14 t：远地点冲高到 252.30 km（目标 200 km，+52.3 km），结果
   *       198.91 × 414.59 km、e = 1.61e-2，successHa = 245 km 判【未入轨】，
   *       54.5 分 C。全程无任何失败事件 —— 学生看到的是"飞得好好的，
   *       最后判我没入轨"，最伤教学体验。
   *     · 70 t：重力转弯程序是按 26 t 调的，70 t 下二级关机严重偏低，
   *       200 km 目标下永远等不到远地点（vr 不过零）、动压数值发散到 2e12 kPa；
   *       演示模式（禁用全部失败判定）里会判"入轨"，实测 hp = −6368.63 km、
   *       ha = −153.69 km、e = 9.97e-1 —— 整条轨道在地心以下。
   *   两个构型已于 2026-09-03 从 UI 与配置层一并删除，不保留不可达分支。
   *   标定它们是另一件事（需要重调重力转弯程序），不是加回选项就能用。 */
  var PAYLOADS = {
    26: { name: '梦舟 · 深空版', mass: 26e3, note: '3 名航天员，登月构型。本次任务到入轨为止。' }
  };

  /* ---------------------------------------------------------------------------
   * 构造一辆具体的运载器
   * @param {object} opts { payload: 26 (t), targetAlt: 200e3|400e3 }
   * ------------------------------------------------------------------------ */
  function build(opts) {
    opts = opts || {};
    var payT = opts.payload || 26;
    var pay = PAYLOADS[payT] || PAYLOADS[26];
    // 上面的 `|| PAYLOADS[26]` 是防御性的：载荷固定 26 t 之后，传入任何别的
    // 数值都只可能是脏数据（老存档、笔误），兜回唯一标定过的构型而不是崩掉。
    var targetAlt = opts.targetAlt || 200e3;

    var v = {
      payload: pay,
      targetAlt: targetAlt,
      tower:   { dry: BASE.tower.dry, attached: true },
      fairing: { dry: BASE.fairing.dry, attached: true },
      adapter: { dry: BASE.adapter.dry, attached: true },
      booster: { dry: BASE.booster.dry, prop0: BASE.booster.prop, count: BASE.booster.count,
                 eng: ENGINES.YF100K, nEng: BASE.booster.nEng, attached: true },
      s1:      { dry: BASE.s1.dry, prop0: BASE.s1.prop, eng: ENGINES.YF100K, nEng: BASE.s1.nEng, attached: true },
      s2:      { dry: BASE.s2.dry, prop0: BASE.s2.prop, eng: ENGINES.YF100M, nEng: BASE.s2.nEng, attached: true },
      s3:      { dry: BASE.s3.dry, prop0: BASE.s3.prop, eng: ENGINES.YF75E, nEng: BASE.s3.nEng, attached: true }
    };

    // 起飞质量 GLOW
    v.glow = v.tower.dry + v.fairing.dry + v.adapter.dry + pay.mass
      + v.booster.count * (v.booster.dry + v.booster.prop0)
      + (v.s1.dry + v.s1.prop0)
      + (v.s2.dry + v.s2.prop0)
      + (v.s3.dry + v.s3.prop0);

    // 起飞推力（海平面，21 台 = 3 模块 × 7 台，每模块 8750 kN）
    v.thrustSL = (v.booster.count + 1) * v.booster.nEng * v.booster.eng.Fsl;
    v.thrustVac = (v.booster.count + 1) * v.booster.nEng * v.booster.eng.Fvac;
    v.twRatio = v.thrustSL / (v.glow * G0);

    // 各级理论燃烧时间（vehicle.md §5.1：以 F 与 Isp 推 ṁ，再由装填量求时间）
    // 一级取海平面工况（pr=1）的 ṁ，二三级取真空工况（pr=0）
    var md1 = mdotFirstModule(v.booster.eng, 1.0, 1.0);       // ≈ 2957.7 kg/s
    v.burn = {
      booster: v.booster.prop0 / md1,          // ≈ 175.8 s（公开 173 s，+1.7%）
      s1: v.s1.prop0 / md1,                    // ≈ 229.9 s（公开 227 s，+1.3%）
      s2: v.s2.prop0 / mdotStage(v.s2, 0, 1),  // ≈ 218.9 s（公开 215 s，+1.9%）
      s3: v.s3.prop0 / mdotStage(v.s3, 0, 1)   // ≈ 944 s（公开 924 s，+2.2%）
    };
    // 芯一级从 T+0 一直烧到 T+230，故"累计燃烧时间"= 自身推进剂对应时间
    v.burn.s1Total = v.burn.s1;

    return v;
  }

  /* ---------------------------------------------------------------------------
   * 推力 / 比冲 / 质量流率（physics.md §5）
   *
   *   Isp(h) = Isp_vac − (Isp_vac − Isp_sl)·(p/p₀)
   *   F(h)   = F_vac   − (F_vac   − F_sl  )·(p/p₀)
   *   ṁ      = F / (Isp·g₀)          ← F 与 Isp 同步变化，故 ṁ 全程几乎恒定
   *   节流：F = η·F(h)，Isp = Isp(h)·(1 − 0.15(1−η)²)
   * ------------------------------------------------------------------------ */

  /** 单个发动机在给定气压比与节流下的 {F, Isp, mdot}（单位：N, s, kg/s） */
  function engineState(eng, pr, eta) {
    if (pr < 0) { pr = 0; } else if (pr > 1) { pr = 1; }
    var F = eng.Fvac - (eng.Fvac - eng.Fsl) * pr;
    var Isp = eng.Ispvac - (eng.Ispvac - eng.Ispsl) * pr;
    if (eng.throttle && eta !== 1) {
      F *= eta;
      Isp *= (1 - C.ISP_THROTTLE_LOSS * (1 - eta) * (1 - eta));
    }
    return { F: F, Isp: Isp, mdot: F / (Isp * G0) };
  }

  /** 一级模块（7 台 YF-100K）的总质量流率 kg/s */
  function mdotFirstModule(eng, pr, eta) {
    return 7 * engineState(eng, pr, eta).mdot;
  }

  /** 二级/三级整级的质量流率 */
  function mdotStage(st, pr, eta) {
    if (eta === undefined) { eta = 1; }
    return st.nEng * engineState(st.eng, pr === undefined ? 0 : pr, eta).mdot;
  }

  /** 一级模块（7 台）的总推力 */
  function thrustFirstModule(eng, pr, eta) {
    return 7 * engineState(eng, pr, eta).F;
  }

  /* ---------------------------------------------------------------------------
   * 分段火箭方程（vehicle.md §4.2）—— 只用于任务前的静态预算核对与 UI 理论值
   * 实时显示的 Δv 一律用积分形式 ∫(F/m)dt，因为 Isp 随高度变化且存在节流。
   * ------------------------------------------------------------------------ */
  function rocketEq(Isp, m0, m1) {
    return Isp * G0 * Math.log(m0 / m1);
  }

  /* ---------------------------------------------------------------------------
   * 完整 Δv 预算（vehicle.md §4.2 + §4.3）
   * Isp_eff 取文档给出的时间加权有效值：一级 329 s（因高度变化）、
   * 二三级直接用真空比冲。
   * ------------------------------------------------------------------------ */
  /**
   * 完整 Δv 预算（vehicle.md §4.2 供给侧表 + §4.3 三级满载表）
   *
   * ⚠⚠ 分段边界规则（vehicle.md §4.2.1，验收项 V-15）——本函数最容易写错的地方
   * ---------------------------------------------------------------------------
   *   Δv 表的分段边界集合  ==  抛除事件时刻集合  ∪  发动机工况变化时刻集合
   *   即：**任何一段内部，质量变化只能来自推进剂消耗。**
   *
   *   原因是：抛除事件本身【不产生任何 Δv】。被抛物体以零排气速度离开箭体，
   *   不提供冲量，只能通过"降低后续段的起始质量"间接获益。若把含抛除事件的
   *   区间当作单段，等价于假设被抛物【是被当推进剂烧掉的】——而"烧掉"比"扔掉"
   *   值钱（推进剂能提供冲量，死重不能），会系统性高估。
   *
   *   本箭 5 个抛除事件：T+170 逃逸塔 / T+175.8 助推 / T+229.9 芯一级 /
   *   T+260 整流罩 / T+448.9 芯二级 —— 每一个都必须是分段边界。
   *
   * 历史 bug（两次，同一类，都曾实装过）：
   *   ① A 段曾当作单段跨越 T+170 抛塔 → 高估 37 m/s（V-16 断言防回归）
   *   ② B 段曾当作单段跨越抛罩 → 高估 43 m/s。抛罩原为【纯高度判据】，
   *      在 T+198（芯一级单独燃烧段内）就触发；现已改为高度 ∧ 时刻取较晚者
   *      （C.SEQ.FAIRING_SEP_T = 260），落在二级燃烧段内，与 §4.2 表一致。
   * ------------------------------------------------------------------------ */
  function deltaVBudget(v) {
    var m = v.glow;
    var Seq = C.SEQ;
    var stages = [];

    // 一级三个模块【并联同时烧】，每个模块 7 台、流量相同。
    // 故助推器烧掉 520 t 的这段时间里，芯一级也正好烧掉 520 t（不是 680 t）。
    // 早期版本写成 mB × (s1.prop0 / booster.prop0)，等于假设两者同时耗尽，
    // 会让段末质量变成负值，火箭方程直接出 NaN（见 tests/physics-audit.js
    // 的"Δv 预算完整性"一项）。
    var m1inA = v.booster.prop0;                 // 同期芯一级烧掉的（= 单模块同期）
    var mdModule = mdotFirstModule(v.booster.eng, 1.0, 1.0);   // 单模块 kg/s
    var md3 = 3 * mdModule;                      // 三模块并联
    var md2 = mdotStage(v.s2, 0, 1);             // 二级（真空工况）

    /* ---- A. 三模块并联：T+0 → 助推器推进剂耗尽 ----------------------------
     * T+170 抛逃逸塔落在本段内部 → 必须切成 A1 / A2。
     * Isp：A1 覆盖海平面 → 约 72 km，取时间加权有效值 329 s；
     *      A2 已近真空，取真空值 337 s。时间加权平均 329.3 s，
     *      与原文档"一级有效 Isp 329 s"的标定口径一致（§4.2.1）。
     * -------------------------------------------------------------------- */
    var tTower = Seq.TOWER_SEP_T;
    var tBoostEnd = v.burn.booster;
    var mA1_end = m - md3 * tTower;                            // 塔还在箭上
    var mA2_start = mA1_end - v.tower.dry;                      // ← T+170 抛塔
    var mA2_end = mA2_start - md3 * (tBoostEnd - tTower);
    stages.push({ id: 'A1', name: '一级·三模块（抛塔前）', Isp: 329, m0: m, m1: mA1_end,
                  t0: 0, t1: tTower });
    stages.push({ id: 'A2', name: '一级·三模块（抛塔后）', Isp: 337, m0: mA2_start, m1: mA2_end,
                  t0: tTower, t1: tBoostEnd, jettison: 'tower' });

    /* ---- B. 抛助推器（2×45 t）后，芯一级单独烧到推进剂耗尽 ---------------
     * T+175.8 抛助推器是本段的起点（边界 ✓）。
     * 段内【不含】任何抛除事件 —— 抛罩已由 C.SEQ.FAIRING_SEP_T 推迟到
     * T+260，落在二级燃烧段内（见文件头的第二次历史 bug 说明）。
     * -------------------------------------------------------------------- */
    var mB_start = mA2_end - v.booster.count * v.booster.dry;
    var mB_end = mB_start - (v.s1.prop0 - m1inA);
    stages.push({ id: 'B', name: '一级·芯级单独', Isp: 337, m0: mB_start, m1: mB_end,
                  t0: tBoostEnd, t1: v.burn.s1, jettison: 'booster' });

    /* ---- C. 抛芯一级（54 t）后二级点火 → 二级推进剂耗尽 ------------------
     * T+260 抛整流罩落在本段内部 → 必须切成 C1 / C2。
     * C1 的推进剂消耗量【由模型推导】：二级流量 × (抛罩时刻 − 二级点火时刻)，
     * 不再硬编码 25400 kg。
     * -------------------------------------------------------------------- */
    var mC_start = mB_end - v.s1.dry;
    var propC1 = md2 * (Seq.FAIRING_SEP_T - v.burn.s1);         // 抛罩前烧掉的
    var mC1_end = mC_start - propC1;
    stages.push({ id: 'C1', name: '二级·抛罩前', Isp: 352.3, m0: mC_start, m1: mC1_end,
                  t0: v.burn.s1, t1: Seq.FAIRING_SEP_T, jettison: 's1' });

    var mC2_start = mC1_end - v.fairing.dry;                     // ← T+260 抛罩
    var mC2_end = mC2_start - (v.s2.prop0 - propC1);
    stages.push({ id: 'C2', name: '二级·抛罩后', Isp: 352.3, m0: mC2_start, m1: mC2_end,
                  t0: Seq.FAIRING_SEP_T, t1: v.burn.s1 + v.burn.s2, jettison: 'fairing' });

    /* ---- D. 抛芯二级（22 t）后三级满载（59 t，登月任务剖面）-------------- */
    var mD_start = mC2_end - v.s2.dry;
    var mD_end = mD_start - v.s3.prop0;
    stages.push({ id: 'D', name: '三级·满载', Isp: 451.1, m0: mD_start, m1: mD_end,
                  t0: v.burn.s1 + v.burn.s2, t1: null, jettison: 's2' });

    var total = 0;
    stages.forEach(function (s) { s.dv = rocketEq(s.Isp, s.m0, s.m1); total += s.dv; });

    /* ---- 分段边界集合（V-15 用：抛除事件必须全部落在边界上）--------------
     * 边界 = 各段的起止时刻。V-15 的判据是"每个抛除事件时刻 ∈ 边界集合"。
     * -------------------------------------------------------------------- */
    var bounds = [];
    stages.forEach(function (s) {
      if (s.t0 !== null && s.t0 !== undefined) { bounds.push(s.t0); }
      if (s.t1 !== null && s.t1 !== undefined) { bounds.push(s.t1); }
    });

    return {
      stages: stages,
      bounds: bounds,
      total: total,
      first: stages[0].dv + stages[1].dv + stages[2].dv,   // A1 + A2 + B
      second: stages[3].dv + stages[4].dv,                 // C1 + C2
      third: stages[5].dv                                  // D
    };
  }

  /**
   * 三级在给定推进剂消耗量下能提供的 Δv（vehicle.md §4.2 D 段：LEO 剖面烧 18 t）
   * @param {object} v       build() 的返回值
   * @param {number} propKg  三级烧掉的推进剂 kg
   * @returns {{m0:number, m1:number, dv:number}} 段起止质量（kg）与 Δv（m/s）
   */
  function thirdStageDv(v, propKg) {
    var b = deltaVBudget(v);
    var m0 = b.stages[5].m0;
    var m1 = m0 - Math.min(propKg, v.s3.prop0);
    return { m0: m0, m1: m1, dv: rocketEq(v.s3.eng.Ispvac, m0, m1) };
  }

  return {
    ENGINES: ENGINES,
    BASE: BASE,
    PAYLOADS: PAYLOADS,
    build: build,
    engineState: engineState,
    mdotFirstModule: mdotFirstModule,
    mdotStage: mdotStage,
    thrustFirstModule: thrustFirstModule,
    rocketEq: rocketEq,
    deltaVBudget: deltaVBudget,
    thirdStageDv: thirdStageDv
  };
});
