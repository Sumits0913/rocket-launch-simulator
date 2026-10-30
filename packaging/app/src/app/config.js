/* =============================================================================
 * config.js —— 设置与存档（localStorage，失败则降级为"本次会话有效"）
 * -----------------------------------------------------------------------------
 * 依据：design/gdd/modes.md §5.2、design/ui-spec.md §5、design/art/accessibility.md
 *
 * ⚠ file:// 下的存档
 *   双击打开时页面源是 file://，Chrome 仍然给 localStorage（每个 file 源共享一个
 *   桶），Firefox 也给。但隐私模式 / 某些企业策略会直接抛异常，所以【所有读写
 *   一律 try/catch】，失败就退回内存对象 —— 用户完全无感，只是关掉页面后不保存。
 *   本项目不联网、不上传任何数据。
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  (root.RK = root.RK || {}).Config = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var KEY = 'launchsim.settings.v1';
  var BEST_KEY = 'launchsim.best.v1';

  /* ---- 默认值 ---------------------------------------------------------- */
  var DEFAULTS = {
    mode: 'demo',            // 'demo' 演示模式 | 'challenge' 挑战模式
    difficulty: 'normal',    // easy 入门 / normal 标准 / hard 硬核
    targetAlt: 200,          // 目标轨道高度 km（200 停泊轨道 / 400 空间站轨道）
    // 没有 payload 字段：载荷固定 26 t（用户决策 #5，唯一标定过的构型），
    // 由 modes.js 的 Director.payloadT 直接给出，不进用户设置。
    // 老存档里若残留 payload: 14/70，会因不在 DEFAULTS 里而被忽略。
    dataLayer: 1,            // 演示模式数据层 L1/L2/L3
    // 主题：用户决策 #1 —— 演示模式【强制浅色、不给深色开关】；
    // 挑战模式【默认深色】，玩家可在设置里切。
    theme: 'dark',           // 'light' | 'dark'（演示模式下被强制为 light）
    cutaway: false,          // 整流罩半透明剖视（演示模式可开，用户决策 #2）
    coastAutoPause: true,    // 滑行段自动暂停（用户决策 #7，可在设置里关）
    guideStage: 'G1',        // 引导阶段
    reducedMotion: false,    // 减弱动效（accessibility §4.1）
    fontScale: 1.0,          // 字号缩放 0.85 / 1.0 / 1.25（大屏 / 视力辅助）
    severityShapes: true,    // 严重度用"形状边数"编码，不只靠颜色（accessibility §2.3）
    sound: false,            // 提示音（默认关，科技馆环境）
    showResidual: false,     // 是否显示 Δv 恒等式残差（核验用，教师可选）
    // 标准档的三级关机：默认【自动】（用户决策 #6：硬核档手动 / 标准档自动）。
    // modes.md §2.6 写的是标准档手动，两者冲突；这里留一个开关，教师可按 GDD 上课。
    manualCutoff3: false
  };

  var mem = {};              // localStorage 不可用时的内存兜底
  var lsOk = true;

  function readRaw(k) {
    try {
      var v = window.localStorage.getItem(k);
      return v;
    } catch (e) { lsOk = false; return mem[k] || null; }
  }
  function writeRaw(k, v) {
    try {
      window.localStorage.setItem(k, v);
    } catch (e) { lsOk = false; mem[k] = v; }
  }

  var cfg = null;

  function load() {
    if (cfg) { return cfg; }
    cfg = {};
    var k;
    for (k in DEFAULTS) { if (DEFAULTS.hasOwnProperty(k)) { cfg[k] = DEFAULTS[k]; } }
    var raw = readRaw(KEY);
    if (raw) {
      try {
        var saved = JSON.parse(raw);
        for (k in DEFAULTS) {
          if (DEFAULTS.hasOwnProperty(k) && saved[k] !== undefined) { cfg[k] = saved[k]; }
        }
      } catch (e) { /* 存档损坏就用默认值，不打扰用户 */ }
    }
    return cfg;
  }

  function get(k) { return load()[k]; }

  function set(k, v) {
    load();
    cfg[k] = v;
    writeRaw(KEY, JSON.stringify(cfg));
    return v;
  }

  function save(patch) {
    load();
    var k;
    for (k in patch) { if (patch.hasOwnProperty(k)) { cfg[k] = patch[k]; } }
    writeRaw(KEY, JSON.stringify(cfg));
    return cfg;
  }

  /** 演示模式的主题是强制的（用户决策 #1），统一走这里取值，避免各处判断不一致 */
  function effectiveTheme(mode) {
    return (mode || get('mode')) === 'demo' ? 'light' : get('theme');
  }

  /* ---- 最佳成绩 --------------------------------------------------------- */
  function loadBest() {
    var raw = readRaw(BEST_KEY);
    if (!raw) { return {}; }
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }
  function saveBest(best) { writeRaw(BEST_KEY, JSON.stringify(best)); }

  /** 记录一次成绩，返回 { best, isNew } */
  function submitScore(difficulty, targetAlt, score, grade) {
    var best = loadBest();
    var key = difficulty + '@' + targetAlt;
    var prev = best[key];
    var isNew = !prev || score > prev.score;
    if (isNew) { best[key] = { score: score, grade: grade, at: Date.now() }; saveBest(best); }
    return { best: best, isNew: isNew };
  }

  return {
    DEFAULTS: DEFAULTS,
    load: load,
    get: get,
    set: set,
    save: save,
    effectiveTheme: effectiveTheme,
    loadBest: loadBest,
    submitScore: submitScore,
    storageAvailable: function () { load(); return lsOk; }
  };
});
