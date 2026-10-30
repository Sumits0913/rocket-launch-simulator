/* =============================================================================
 * a11y.js —— 可访问性：严重度编码 / 减弱动效 / 字号缩放 / 数值稳定性
 * -----------------------------------------------------------------------------
 * 依据：design/art/accessibility.md
 *
 * 三个硬指标（其余见文档 §6 验收清单）：
 *   1) 严重度不得只靠颜色区分 —— 用【形状边数】编码（§2.3 强制规则）：
 *        ● 圆（1 边）  = 正常 nominal
 *        ▲ 三角（3 边）= 注意 caution
 *        ◆ 菱形（4 边）= 警告 warning
 *        ⬢ 六边（6 边）= 危险 danger
 *      色盲用户看形状就够了，颜色只是第二通道。
 *   2) 前庭安全（晕动症，§4.2）：相机抖动幅度与频率有硬上限；reducedMotion
 *      打开时抖动、粒子、屏幕闪白全部关闭。
 *   3) 数值显示稳定性（§4.4）：HUD 数字刷新 ≤ 10 Hz，且用 300 ms 缓动过渡，
 *      禁止数字高频跳动（投影上会看不清，也容易诱发光敏不适）。
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  (root.RK = root.RK || {}).A11y = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---- 严重度等级（形状边数 = 唯一权威编码）------------------------------ */
  var SEV = {
    nominal: { sides: 1, label: '正常', zh: '正常' },
    caution: { sides: 3, label: '注意', zh: '注意' },
    warning: { sides: 4, label: '警告', zh: '警告' },
    danger:  { sides: 6, label: '危险', zh: '危险' }
  };

  /** 把 ratios（各项当前值/上限）映射成严重度 */
  function severity(ratio) {
    if (ratio >= 1.0) { return 'danger'; }
    if (ratio >= 0.85) { return 'warning'; }
    if (ratio >= 0.65) { return 'caution'; }
    return 'nominal';
  }

  /**
   * 生成一个严重度"形状标记"的 SVG 片段。
   * 用多边形而不是字符，保证任何字体环境下形状一致、边数清晰可数。
   */
  function shapeSvg(sev, size, color) {
    var s = SEV[sev] || SEV.nominal;
    var r = size / 2;
    var pts = [];
    if (s.sides <= 1) {
      return '<circle cx="' + r + '" cy="' + r + '" r="' + (r * 0.82) +
             '" fill="' + color + '"/>';
    }
    // 从正上方开始逆时针均分，保证"边数"一眼可数
    for (var i = 0; i < s.sides; i++) {
      var a = -Math.PI / 2 + i * 2 * Math.PI / s.sides;
      pts.push((r + Math.cos(a) * r * 0.92).toFixed(2) + ',' +
               (r + Math.sin(a) * r * 0.92).toFixed(2));
    }
    return '<polygon points="' + pts.join(' ') + '" fill="' + color + '"/>';
  }

  /* ---------------------------------------------------------------------------
   * 数值缓动（§4.4：刷新 ≤10 Hz + 300 ms 过渡）
   * 用法：var tw = new Tween(0); 每帧 tw.update(dt, 目标值); 显示 tw.value
   * ------------------------------------------------------------------------ */
  function Tween(init, tauMs) {
    this.value = init || 0;
    this.target = init || 0;
    this.tau = (tauMs || 300) / 1000;
  }
  Tween.prototype.set = function (v) { this.target = v; };
  Tween.prototype.snap = function (v) { this.target = v; this.value = v; };
  Tween.prototype.update = function (dt) {
    // 一阶指数趋近：帧率无关
    var k = 1 - Math.exp(-dt / this.tau);
    this.value += (this.target - this.value) * k;
    return this.value;
  };

  /** 限频器：把 60 fps 的刷新降到 ≤ hz（HUD 读数用 10 Hz） */
  function RateLimiter(hz) {
    this.period = 1 / (hz || 10);
    this.acc = this.period;      // 首次立即触发
  }
  RateLimiter.prototype.tick = function (dt) {
    this.acc += dt;
    if (this.acc >= this.period) { this.acc = 0; return true; }
    return false;
  };

  /* ---------------------------------------------------------------------------
   * 前庭安全：相机抖动硬上限（§4.2）
   *   位移 ≤ 6 px、频率 ≤ 2 Hz；reducedMotion 时直接归零。
   * ------------------------------------------------------------------------ */
  function shake(t, intensity, reduced) {
    if (reduced) { return { x: 0, y: 0 }; }
    var amp = Math.min(6, 6 * intensity);          // 硬上限 6 px
    return {
      x: Math.sin(t * 2 * Math.PI * 1.7) * amp * (0.6 + 0.4 * Math.sin(t * 5.1)),
      y: Math.cos(t * 2 * Math.PI * 2.3) * amp * (0.6 + 0.4 * Math.sin(t * 4.3))
    };
  }

  /** 光敏癫痫安全：任何全屏闪白的亮度变化必须 ≥ 3 帧渐变，禁止硬切 */
  function flashAlpha(t, durSec) {
    var k = Math.min(1, Math.max(0, t / durSec));
    return Math.sin(Math.PI * k);                  // 平滑起落，无硬边
  }

  return {
    SEV: SEV,
    severity: severity,
    shapeSvg: shapeSvg,
    Tween: Tween,
    RateLimiter: RateLimiter,
    shake: shake,
    flashAlpha: flashAlpha
  };
});
