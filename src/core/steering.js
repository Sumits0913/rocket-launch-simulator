/* =============================================================================
 * steering.js —— 重力转弯（Gravity Turn）三层制
 * -----------------------------------------------------------------------------
 * 依据：design/gdd/physics.md §7.4
 *
 *   第 1 层：自动驾驶（AP）—— 高度驱动的指数衰减 pitch 程序
 *            θ_AP(h) = θ_f + (90° − θ_f) · exp( −c · (h − h₀) )，h < h₀ 时保持 90°
 *            θ_f = 末段姿态下限（默认 4°）—— 见下方"为什么必须有 θ_f"
 *   第 2 层：玩家偏差（bias）—— θ_cmd = clamp(θ_AP + bias, 0°, 95°)【默认层】
 *            松开按键后 bias 按 τ_bias 指数回中
 *   第 3 层：全手动 —— AP 关闭，玩家直接推 θ_cmd，无回中、无下限保护
 *
 * 为什么用"高度驱动"而不是"时间驱动"：高度是积分的直接结果，对推力偏差不敏感，
 * 因此演示模式每次跑出来的弹道几乎完全一致（可复现 = 教师敢用）。
 *
 * ⚠ 为什么必须有末段姿态下限 θ_f（实现补正，已回传 team-lead）
 *   physics.md §7.4 给的是纯指数 θ = 90°·exp(−c(h−h₀))，它在 h→∞ 时趋于 0°。
 *   但二级末段（h≈190 km，v≈7060 m/s）的"净重力"是
 *       g − v²/r ≈ 9.20 − 7.52 = 1.68 m/s²（向下）
 *   要维持弹道倾角不往下掉，需要 (F/m)·sinθ ≥ 1.68。二级末段 F/m ≈ 23.7 m/s²，
 *   解得 θ ≥ 4.1°。纯指数在 190 km 处只给 1.2°，于是二级还没关机弹道倾角就转负、
 *   高度开始往下掉 —— 实测二级关机时 h=172 km、γ=−1.8°，滑行 120 s 掉到 134 km，
 *   三级（推重比仅 0.27）再也救不回来。
 *   加入 θ_f = 4° 后，θ(190 km) ≈ 5.4°，弹道被"托住"，与真实运载火箭二级
 *   保持几度正攻角飞行的做法一致。
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var C = (typeof require === 'function' && typeof module === 'object')
    ? require('./constants.js')
    : root.RK.Constants;
  var api = factory(C);
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  (root.RK = root.RK || {}).Steering = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  var D = C.DEG;

  /* ---------------------------------------------------------------------------
   * 难度档位（modes.md §2.6）
   * ------------------------------------------------------------------------ */
  /* ⚠ 三级关机（autoCutoff3）以【用户决策 #6】为准，与 modes.md §2.6 不一致：
   *     用户决策 #6：硬核档 manual，标准档 auto。
   *     modes.md §2.6：入门 auto / 标准 manual / 硬核 manual。
   *   裁定：按用户决策实现（用户决策优先级高于 GDD），即标准档也自动关机；
   *   同时在设置里留一个"标准档手动关机"开关，教师在需要按 GDD 上课时可打开。
   *   该项冲突已回传 team-lead，等待与 design-strategist 对齐后定稿。 */
  /* ⚠ 这里【不要再加 payload 字段】。早期 easy 档写过 `payload: 14`，但它从未
   *   生效 —— 载荷由 modes.js 的 Director.payloadT 决定并在 buildOpts() 里
   *   覆盖（见 modes.js 的注释）。留着会让人以为"改这里能换载荷"，
   *   已于 2026-09-03 删除。载荷现在固定 26 t。 */
  var DIFFICULTY = {
    easy:   { key: 'easy',   name: '入门', tauBias: 6,  biasRange: 10 * D,
              autoIgnite3: true,  autoCutoff3: true,  throttle: false, manual: false,
              failScale: 1.3, guide: 'G1', targetAlt: 200e3 },
    normal: { key: 'normal', name: '标准', tauBias: 10, biasRange: 15 * D,
              autoIgnite3: false, autoCutoff3: true,   throttle: true,  manual: false,
              failScale: 1.0, guide: 'G1', targetAlt: 200e3 },
    hard:   { key: 'hard',   name: '硬核', tauBias: Infinity, biasRange: 15 * D,
              autoIgnite3: false, autoCutoff3: false, throttle: true,  manual: true,
              failScale: 0.85, guide: 'off', targetAlt: 200e3 }
  };

  /* ---------------------------------------------------------------------------
   * AP 基准 pitch 程序
   * @param {number} h   高度 m
   * @param {object} cfg { h0, c }，c 单位 1/m
   * @returns {number} θ_AP，rad，从当地水平量起（90° = 垂直向上）
   * ------------------------------------------------------------------------ */
  function apPitch(h, cfg) {
    var h0 = (cfg && cfg.h0 !== undefined) ? cfg.h0 : C.H_PITCH0;
    var c = (cfg && cfg.c !== undefined) ? cfg.c : C.C_PITCH;
    var tf = (cfg && cfg.thetaFloor !== undefined) ? cfg.thetaFloor : C.THETA_FLOOR;
    if (h <= h0) { return 90 * D; }
    var th = tf + (90 - tf) * Math.exp(-c * (h - h0));   // 度
    if (th < 0) { th = 0; }
    if (th > 90) { th = 90; }
    return th * D;
  }

  /* ---------------------------------------------------------------------------
   * 控制状态（纯数据，可快照 / 可重放）
   * ------------------------------------------------------------------------ */
  function createControl(diffKey, opts) {
    var d = DIFFICULTY[diffKey] || DIFFICULTY.normal;
    opts = opts || {};
    return {
      difficulty: d.key,
      tauBias: d.tauBias,
      biasRange: d.biasRange,
      manual: !!d.manual && !!opts.allowManual,
      apEnabled: true,          // 第 3 层时置 false
      bias: 0,                  // 玩家偏差 rad
      thetaCmd: 90 * D,         // 全手动模式下直接控制的姿态角指令
      throttle: 1.0,            // 节流 η
      cfg: { h0: opts.h0 !== undefined ? opts.h0 : C.H_PITCH0,
             c: opts.c !== undefined ? opts.c : C.C_PITCH,
             thetaFloor: opts.thetaFloor !== undefined ? opts.thetaFloor : C.THETA_FLOOR }
    };
  }

  /**
   * 推进控制状态一个步长。
   * @param {object} ctl   控制状态（会被就地修改）
   * @param {number} h     当前高度 m
   * @param {number} dt    步长 s
   * @param {number} input 输入方向：+1 = 抬头 / −1 = 低头 / 0 = 无输入
   */
  function advance(ctl, h, dt, input) {
    if (ctl.manual && !ctl.apEnabled) {
      // 第 3 层：全手动，直接推 θ_cmd，无回中、无下限保护
      ctl.thetaCmd += input * C.MANUAL_RATE * dt;
      if (ctl.thetaCmd > 95 * D) { ctl.thetaCmd = 95 * D; }
      if (ctl.thetaCmd < -20 * D) { ctl.thetaCmd = -20 * D; }
      return ctl.thetaCmd;
    }

    // 第 2 层：bias 输入 + 指数回中
    ctl.bias += input * C.BIAS_RATE * dt;
    if (ctl.tauBias !== Infinity && ctl.tauBias > 0) {
      ctl.bias *= Math.exp(-dt / ctl.tauBias);
    }
    if (ctl.bias > ctl.biasRange) { ctl.bias = ctl.biasRange; }
    if (ctl.bias < -ctl.biasRange) { ctl.bias = -ctl.biasRange; }

    var th = apPitch(h, ctl.cfg) + ctl.bias;
    if (th > 95 * D) { th = 95 * D; }
    if (th < 0) { th = 0; }
    ctl.thetaCmd = th;
    return th;
  }

  return {
    DIFFICULTY: DIFFICULTY,
    apPitch: apPitch,
    createControl: createControl,
    advance: advance
  };
});
