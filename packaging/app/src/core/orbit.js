/* =============================================================================
 * orbit.js —— 由 (r⃗, v⃗) 实时反算轨道根数
 * -----------------------------------------------------------------------------
 * 依据：design/gdd/physics.md §9.3
 *
 *   ε     = v²/2 − μ/r                        比机械能
 *   a     = −μ / (2ε)                         半长轴
 *   e⃗     = ((v² − μ/r)·r⃗ − (r⃗·v⃗)·v⃗) / μ     偏心率矢量
 *   r_p   = a(1 − e)，r_a = a(1 + e)
 *   h_p   = r_p − R_REF，h_a = r_a − R_REF    （注意：UI 必须写"高度"不是"半径"）
 *   T     = 2π·sqrt(a³/μ)
 *   i     = 19.6°（几何值，东向发射 i = φ_lat，不走仿真）
 *
 * 自检：r_p + r_a = 2a，误差应 < 1 m。
 *
 * ⚠ 参考球必须唯一（实现补正，已回传 team-lead）
 *   physics.md 里同时出现了两个"地球半径"：§1.2 的发射点地心距 R0 = 6377.30 km
 *   （WGS84 文昌纬度处的地心距）与 §10.4 用于轨道换算的 R_E = 6371 km。
 *   若高度用 R0 减、近/远地点用 R_E 减，同一时刻会出现 6.3 km 的固定偏差
 *   （实测：h=179.5 km 时远地点显示 186 km，自相矛盾）。
 *   【裁定】全项目统一用 R_REF = R0 = 6377.30 km。代价：200 km 圆轨道速度
 *   由 7787.9（用 6371）变为 7784.2 m/s，差 0.05%，不影响任何结论。
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var C = (typeof require === 'function' && typeof module === 'object')
    ? require('./constants.js')
    : root.RK.Constants;
  var api = factory(C);
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  (root.RK = root.RK || {}).Orbit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  var MU = C.MU, R_E = C.R_REF;

  /**
   * @param {number} x,y    ECI 位置 m
   * @param {number} vx,vy  ECI 速度 m/s
   * @returns {object} 轨道根数（长度单位 m，角度 rad，时间 s）
   */
  function elements(x, y, vx, vy) {
    var r = Math.sqrt(x * x + y * y);
    var v2 = vx * vx + vy * vy;
    var v = Math.sqrt(v2);
    var eps = v2 / 2 - MU / r;

    var a = -MU / (2 * eps);

    // 偏心率矢量：e⃗ = ((v² − μ/r)·r⃗ − (r⃗·v⃗)·v⃗) / μ
    var rv = x * vx + y * vy;
    var k = v2 - MU / r;
    var ex = (k * x - rv * vx) / MU;
    var ey = (k * y - rv * vy) / MU;
    var e = Math.sqrt(ex * ex + ey * ey);

    var rp, ra, T, tau;
    if (eps < 0) {                       // 椭圆（含圆）
      rp = a * (1 - e);
      ra = a * (1 + e);
      T = 2 * Math.PI * Math.sqrt(a * a * a / MU);
      tau = T;
    } else {                             // 抛物线 / 双曲线：无远地点
      rp = a * (1 - e);                  // a<0 时仍可给出近地点
      ra = Infinity;
      T = Infinity;
      tau = Infinity;
    }

    return {
      r: r, v: v, eps: eps, a: a, e: e,
      ex: ex, ey: ey,
      rp: rp, ra: ra,
      hp: rp - R_E,                      // 近地点【高度】
      ha: ra - R_E,                      // 远地点【高度】
      T: T,
      i: C.SITE.INCLINATION,             // 轨道倾角（几何值，见 physics.md §1.4）
      hyperbolic: eps >= 0,
      // 自检量：r_p + r_a 应等于 2a
      check: (rp + ra) - 2 * a
    };
  }

  /** 给定高度（相对参考球）的圆轨道速度 m/s */
  function circularVel(alt) {
    return Math.sqrt(MU / (R_E + alt));
  }

  /** 给定高度的圆轨道周期 s */
  function circularPeriod(alt) {
    var a = R_E + alt;
    return 2 * Math.PI * Math.sqrt(a * a * a / MU);
  }

  return {
    elements: elements,
    circularVel: circularVel,
    circularPeriod: circularPeriod
  };
});
