/* =============================================================================
 * atmo.js —— US Standard Atmosphere 1976 分层大气模型
 * -----------------------------------------------------------------------------
 * 依据：design/gdd/physics.md §3
 *
 * 为什么不用 ρ = ρ₀·exp(−h/H)：等温近似在 30 km 以上误差可达 3–10 倍，
 * 会严重扭曲阻力与动压曲线，直接破坏"物理是真的"这条核心支柱。
 *
 * 实现：
 *   1) exact(h)   —— 精确分层公式（§3.3），是全部数值的权威来源与自检基准
 *   2) table      —— 启动时预计算 0–100 km 每 100 m 一点（§3.5），线性插值
 *   3) selfTest() —— 启动时抽查 20 点，查表与精确值误差 > 1% 则报错
 *
 * 高度基准：几何高度（非位势高度）。与 US76 官方表有 1–5% 差异属正常，
 * 本项目全链路统一用几何高度即可自洽（physics.md §3.6 注）。
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var C = (typeof require === 'function' && typeof module === 'object')
    ? require('./constants.js')
    : root.RK.Constants;
  var api = factory(C);
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  (root.RK = root.RK || {}).Atmo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  var LAYERS = C.ATMO_LAYERS;
  var TOP = C.ATMO_TOP;
  var G0 = C.G0, M = C.M_AIR, RS = C.R_STAR, RA = C.R_AIR, GAM = C.GAMMA_AIR;

  /* -------------------------------------------------------------------------
   * 精确分层公式（physics.md §3.3）
   *   L ≠ 0:  p = p_b · (T/T_b)^( −g₀·M / (R*·L) )
   *   L = 0:  p = p_b · exp( −g₀·M·Δh / (R*·T_b) )
   *   ρ = p·M / (R*·T)
   *   a = sqrt(γ·R_air·T)
   * ---------------------------------------------------------------------- */
  function exact(h) {
    var T, p;

    if (h <= TOP.h) {
      // 找到所在层（从高到低找第一个 hb <= h）
      var i = LAYERS.length - 1;
      while (i > 0 && LAYERS[i].hb > h) { i--; }
      var L = LAYERS[i];
      var dh = h - L.hb;
      T = L.Tb + L.L * dh;
      if (L.L === 0) {
        p = L.pb * Math.exp(-G0 * M * dh / (RS * L.Tb));
      } else {
        var expo = -G0 * M / (RS * L.L);
        p = L.pb * Math.pow(T / L.Tb, expo);
      }
    } else {
      // 84.852 km 以上：指数外推（§3.4）。US76 在此进入稀薄气体层，
      // 连续介质假设失效，任何"精确"密度都无物理意义。
      T = TOP.T;
      p = TOP.p * Math.exp(-(h - TOP.h) / TOP.H);
    }

    // h > 120 km：动压 < 0.3 Pa，对仿真无影响，直接置零避免下溢
    if (h > 120000) { return { T: T, p: 0, rho: 0, a: Math.sqrt(GAM * RA * T) }; }

    return { T: T, p: p, rho: p * M / (RS * T), a: Math.sqrt(GAM * RA * T) };
  }

  /* -------------------------------------------------------------------------
   * 查表：0–100 km，步长 100 m，共 1001 点（§3.5）
   * 100 km 以上直接走精确公式（此时基本真空，调用频率低）。
   * ---------------------------------------------------------------------- */
  var STEP = 100;
  var N = 1001;                       // 0 .. 100000 m
  var tRho = new Float64Array(N);
  var tP = new Float64Array(N);
  var tA = new Float64Array(N);

  function buildTable() {
    for (var i = 0; i < N; i++) {
      var s = exact(i * STEP);
      tRho[i] = s.rho; tP[i] = s.p; tA[i] = s.a;
    }
  }
  buildTable();

  /** 查表 + 线性插值（插值误差 < 0.01%） */
  function lookup(h) {
    if (h >= (N - 1) * STEP) { return exact(h); }
    if (h <= 0) { return { rho: tRho[0], p: tP[0], a: tA[0], T: tP[0] * M / (RS * tRho[0]) }; }
    var f = h / STEP;
    var i = f | 0;                    // 向下取整
    var w = f - i;
    var j = i + 1;
    return {
      rho: tRho[i] + (tRho[j] - tRho[i]) * w,
      p: tP[i] + (tP[j] - tP[i]) * w,
      a: tA[i] + (tA[j] - tA[i]) * w,
      T: 0                            // 热仿真不需要，按需用 p/(ρ·R_air) 现算
    };
  }

  /** 温度（只给气动热与马赫数显示用，调用频率低，走精确公式） */
  function temperature(h) { return exact(h).T; }

  /* -------------------------------------------------------------------------
   * 自检（§3.5 第 4 条）：抽查 20 点，查表 vs 精确
   * ---------------------------------------------------------------------- */
  function selfTest() {
    var worst = 0, worstH = 0;
    for (var k = 0; k <= 20; k++) {
      var h = k * 5000;                       // 0 .. 100 km
      var a = lookup(h), b = exact(h);
      if (b.rho < 1e-12) { continue; }
      var e = Math.abs(a.rho - b.rho) / b.rho;
      if (e > worst) { worst = e; worstH = h; }
    }
    return { maxRelErr: worst, atH: worstH, pass: worst < 0.01 };
  }

  /* -------------------------------------------------------------------------
   * physics.md §3.6 参考密度（用于实现自检，见 tests/physics-audit.js）
   * ---------------------------------------------------------------------- */
  var REF = [
    [0, 1.225], [5000, 0.7364], [10000, 0.4127], [11000, 0.3639],
    [15000, 0.1937], [20000, 0.08802], [25000, 0.03947], [30000, 0.01802],
    [40000, 3.86e-3], [50000, 9.78e-4], [60000, 2.89e-4], [70000, 7.39e-5],
    [80000, 1.85e-5], [86000, 6.96e-6]
  ];

  return {
    exact: exact,
    at: lookup,
    temperature: temperature,
    pressureRatio: function (h) { var p = lookup(h).p / C.P0; return p < 0 ? 0 : (p > 1 ? 1 : p); },
    selfTest: selfTest,
    REF: REF,
    TABLE_STEP: STEP
  };
});
