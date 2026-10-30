/* =============================================================================
 * modes.js —— 双模式总控（演示模式 / 挑战模式）
 * -----------------------------------------------------------------------------
 * 依据：design/gdd/modes.md 全文，尤其是
 *       §1.3 数据层、§1.4 讲解脚本、§1.5 演示模式保障措施、
 *       §2.1 三阶段引导、§2.2 提示条、§2.3 容错、§3 控制映射
 *
 * 用户决策落地位置（8 条，逐条对应）：
 *   #1 演示模式强制浅色、不给深色开关       → Config.effectiveTheme + 本文件 theme()
 *   #2 整流罩半透明剖视（演示模式可开）     → cutaway() + svg-rocket.js
 *   #3 时间线可拖到任意时刻                 → timeline.js + replay.js（本文件负责暂停联动）
 *   #4 尺寸取公开资料量级，容差 ±10%        → svg-rocket.js GEO
 *   #5 载荷 26 t 深空版 + 开场白            → openingLine()
 *   #6 三级关机：硬核档手动 / 标准档自动     → buildOpts().g3AutoCutoff
 *   #7 演示模式滑行段自动暂停，可在设置关闭  → onEvent('E9')
 *   #8 200 km 与 400 km 都做，分别调参      → C.TARGETS（constants.js）
 *
 * ── 演示模式为什么禁用玩家输入（modes.md §1.5）────────────────────────────────
 *   教师在台上讲解时，学生围在大屏前会忍不住按键。一旦 bias 或节流被改动，
 *   标定好的弹道就废了，讲解脚本与画面对不上。所以演示模式把所有物理输入
 *   锁死（input.js 里 mode==='demo' 直接丢弃），只留播放控制。
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var isNode = (typeof require === 'function' && typeof module === 'object');
  var C = isNode ? require('../core/constants.js') : root.RK.Constants;
  var Steer = isNode ? require('../core/steering.js') : root.RK.Steering;
  var api = factory(C, Steer);
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  (root.RK = root.RK || {}).Modes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, Steer) {
  'use strict';

  /* ---------------------------------------------------------------------------
   * 讲解脚本（modes.md §1.4，逐字照抄，教师可直接用）
   *   slow  = 该节点自动降速到的倍速（null = 不降）
   *   pause = 该节点是否自动暂停
   * ------------------------------------------------------------------------ */
  var NARRATION = {
    E0: { text: '21 台发动机同时点火。起飞推力 2677 吨，火箭总重 2187 吨。', slow: null },
    E1: { text: '起飞推重比只有 1.224。前 10 秒几乎没有速度感——真实运载火箭都这样起飞。', slow: null },
    E2: { text: '开始重力转弯。注意：入轨需要的不是高度，是每秒 7.8 公里的横向速度。', slow: null },
    E3: { text: '速度在涨，空气在变稀，两者的乘积——动压——先涨后跌。这个峰值叫 Max-Q，' +
                '箭体受力最恶劣的时刻。真实火箭会在这里主动降低推力。', slow: 0.5 },
    E4: { text: '逃逸塔的任务结束了。出大气后飞船可以自己逃逸，这 9 吨死重没必要再带着。', slow: null },
    E5: { text: '燃料烧完的助推器立刻抛掉。看加速度表——它掉了，因为少了三分之二的发动机。' +
                '一秒后会重新爬升，因为火箭在变轻。', slow: 0.5 },
    E6: { text: '二级点火。反直觉的数字：二级推重比小于 1，按常识该掉下来——但它不会，' +
                '因为它已经飞到每秒 4 公里以上，重力正被离心效应抵消。', slow: 1 },
    E7: { text: '整流罩是穿过大气的"头盔"。现在空气稀薄到可以忽略，这 6 吨就是纯死重。', slow: null },
    E8: { text: '二级烧完。速度 7.15 公里每秒，高度 189 公里，几乎平着飞了。' +
                '但还不够——圆轨道需要 7.79，还差约 640 米每秒。', slow: 1 },
    E9: { text: '滑行段。看轨道根数面板里的"近地点高度"——它是负数，' +
                '意思是这个椭圆的最低点在地表以下，它会掉回来。它还没入轨。', pause: true },
    E10: { text: '三级用氢氧发动机，推力只有 27.6 吨，比一级小近 100 倍。但比冲 451 秒，' +
                 '是三种发动机里最高的——小推力、长时间、高效率，上面级的典型特征。', slow: 1 },
    E11: { text: '看这个数字——近地点高度，刚刚从负 1617 公里爬到了正的 200 公里。' +
                 '这一刻，它不会掉回来了。这就是入轨。', slow: 0.5 },
    E12: { text: '船箭分离。梦舟载人飞船进入 200 公里停泊轨道——本次任务到入轨为止。', slow: null }
  };

  /* 滑行段专项脚本（modes.md §1.4 下方）：这是全局科普价值最高的 3 分钟 */
  var COAST_SCRIPT = [
    '① 现在没有推力了，但它在继续上升——靠的是速度。',
    '② 近地点是负的。意思是这个椭圆的最低点在地表以下——它会掉回来。它还没入轨。',
    '③ 我们要在远地点点火，把速度从 7.13 补到 7.79（还差约 650 m/s），把近地点从负值抬到 200 公里以上。',
    '④ 三级点火后，近地点数字会从负爬到正——那一刻，它才叫入轨。'
  ];

  /* 挑战模式提示条（modes.md §2.2） */
  var HINTS = [
    { until: 0, text: '按 空格 点火' },
    { until: 30, text: '起飞了。观察过载表——它在持续上升，因为火箭在变轻。' },
    /* ⚠ 原来这句是"用 ↑ / ↓ 可以做小幅修正（±15°）"，没说方向语义。
     * 但本项目 θ 从当地水平量起（90° = 垂直），入轨要的是【把速度倒向水平】，
     * 即 θ 从 90° 往下减 —— 对应的是按 ▼，不是按 ▲。
     * 中学生看到「▲」的第一反应是"让火箭往上飞"，按下去却是在拉高弹道、
     * 越飞越高，离入轨越来越远。所以这里必须把方向说死。
     * 物理内核一个字没动（steering.js 的 bias 叠加逻辑保持原样），
     * 只在这里把正确用法讲清楚。 */
    { until: 60, text: '已开始程序转弯。想入轨就按 ▼ 把速度倒向水平；▲ 是拉高弹道，按多了会冲太高。' },
    { until: 88, text: '⚠ 即将进入最大动压区。建议按 Q 降低推力到 80%。' },
    { until: 170, text: 'Max-Q 已过。可以按 E 恢复满推力。' },
    { until: 185, text: '助推器燃料即将耗尽，注意观察过载的变化。' },
    { until: 448, text: '二级段。大气已很稀薄，主要看速度逼近 7.8 km/s。' },
    { until: 1e9, text: '滑行段。看近地点高度——它是负数，说明还没入轨。' }
  ];

  /* ---------------------------------------------------------------------------
   * Director
   * ------------------------------------------------------------------------ */
  function Director(cfg) {
    this.cfg = cfg;                 // RK.Config
    this.mode = cfg.get('mode');
    this.difficulty = cfg.get('difficulty');
    this.targetKm = cfg.get('targetAlt');
    /* 载荷固定 26 t（用户决策 #5，也是唯一标定过的构型）。
     * 这里不再直接读 cfg —— 老版本的 localStorage 里可能存着 14 / 70，
     * 而那两个构型的弹道从未标定（14 t 远地点冲高 52 km、70 t 轨道在地心
     * 以下）。与其让 vehicle.js 的 `PAYLOADS[payT] || PAYLOADS[26]` 静默兜底
     * （结果"存档写 70 t、实际飞 26 t"），不如在这一层就归一掉。 */
    this.payloadT = 26;
    this.dataLayer = cfg.get('dataLayer');
    this.cutaway = !!cfg.get('cutaway');
    this.coastAutoPause = !!cfg.get('coastAutoPause');
    this.flights = this._loadFlights();
    this._clock = 0;                // 核验面板停留累计（秒，成就 A9）
  }

  Director.prototype._loadFlights = function () {
    var raw = null;
    try { raw = window.localStorage.getItem('launchsim.flights.v1'); } catch (e) { raw = null; }
    var n = raw ? parseInt(raw, 10) : 0;
    return isFinite(n) ? n : 0;
  };
  Director.prototype._bumpFlights = function () {
    this.flights += 1;
    try { window.localStorage.setItem('launchsim.flights.v1', String(this.flights)); }
    catch (e) { /* 隐私模式：本次会话有效 */ }
  };

  /** 引导阶段：前 2 次 G1，3–5 次 G2，第 6 次起 G3（modes.md §2.1） */
  Director.prototype.guideStage = function () {
    if (this.mode === 'demo') { return 'off'; }
    if (this.flights < 2) { return 'G1'; }
    if (this.flights < 5) { return 'G2'; }
    return 'G3';
  };

  /** 主题：演示模式强制浅色（用户决策 #1） */
  Director.prototype.theme = function () { return this.cfg.effectiveTheme(this.mode); };

  /** 开场白（用户决策 #5） */
  Director.prototype.openingLine = function () {
    return '本次任务到入轨为止。（演示范围：发射 → 入轨；不含地月转移与登月）';
  };

  /**
   * 组装 Sim 的构造参数
   * 关键：g3AutoCutoff（三级【自动关机】）由难度档决定 → 用户决策 #6。
   *   演示模式        → 自动（教师只需要讲解）
   *   入门 / 标准档   → 自动（学生只处理 Max-Q 与 bias）
   *   硬核档          → 手动（学生自己盯轨道根数判断关机时机）
   *   标准档也可通过设置里的"手动关机"开关强制改为手动（与 modes.md §2.6 对齐的口子）
   *
   * ⚠ 注意这里管的是"谁按关机键"，不是"有没有三级制导"。2026-09-03 之前
   *   传的是 g3Enabled，把制导一起关掉了 —— 硬核档变成开环烧 640 s，
   *   实测满足入轨判据（hp ≥ 180 且 ha ≤ 245 km）的关机时刻【根本不存在】
   *   （能压住 ha ≤ 245 km 时 hp 最多 133 km；hp 到 180 km 时 ha 已 527 km）。
   *   现在制导由 sim.js 常开（全手动时让位给玩家），这里只决定关机。
   */
  Director.prototype.buildOpts = function () {
    var d = Steer.DIFFICULTY[this.difficulty] || Steer.DIFFICULTY.normal;
    var demo = this.mode === 'demo';
    var g3;
    if (demo) { g3 = true; }
    else if (this.difficulty === 'hard') { g3 = false; }
    else { g3 = !this.cfg.get('manualCutoff3'); }   // 标准/入门：默认自动，可手动改
    return {
      demoMode: demo,
      difficulty: this.difficulty,
      targetAlt: this.targetKm * 1000,
      payload: this.payloadT,
      allowManual: (this.difficulty === 'hard'),
      g3AutoCutoff: g3,
      orbitOk: null            // 用 C.TARGETS 里标定好的那一套
    };
  };

  /**
   * 事件触发时的导演动作
   * @returns {{subtitle:string, warp:number|null, pause:boolean, flash:string}}
   */
  Director.prototype.onEvent = function (e, sim) {
    var out = { subtitle: '', warp: null, pause: false, flash: e.name };
    if (this.mode === 'demo') {
      var n = NARRATION[e.id];
      if (n) {
        out.subtitle = n.text;
        if (n.slow) { out.warp = n.slow; }
        // 用户决策 #7：滑行段自动暂停（可在设置里关闭）
        if (n.pause && this.coastAutoPause) { out.pause = true; }
      }
      if (e.id === 'E9') { out.coastScript = COAST_SCRIPT; }
    } else {
      out.subtitle = e.name;
    }
    return out;
  };

  /** 滑行段讲解脚本（演示模式暂停时展示） */
  Director.prototype.coastScript = function () { return COAST_SCRIPT; };

  /** 挑战模式"下一步"提示条 */
  Director.prototype.hint = function (sim) {
    if (this.mode === 'demo') { return ''; }
    var T = sim.missionTime();
    var stage = this.guideStage();
    if (stage === 'G3') { return ''; }

    // 三级工作中的关机提示是【全局教学价值最高的一个决策点】（用户决策 #6）
    if (sim.burning.s3) {
      var el = sim.tele.el;
      var tgt = sim.veh.targetAlt;
      if (el) {
        if (el.hp < 0) {
          return '三级工作中。近地点 ' + (el.hp / 1000).toFixed(0) +
                 ' km —— 还是负的，现在关机一定掉回来。继续烧。';
        }
        if (el.hp < tgt - 20e3) {
          return '近地点 ' + (el.hp / 1000).toFixed(0) + ' km，目标 ' +
                 (tgt / 1000).toFixed(0) + ' km。继续抬升。';
        }
        return '近地点已到 ' + (el.hp / 1000).toFixed(0) + ' km —— 按 空格 关机入轨！';
      }
    }
    if (sim.status === 'coast') {
      var el2 = sim.tele.el;
      var near = (sim.coastDuration - (sim.t - (sim.tS2Cut || 0)));
      var hpTxt = el2 ? (el2.hp / 1000).toFixed(0) + ' km' : '—';
      return '滑行段。近地点 ' + hpTxt + '（负数 = 还没入轨）。按 空格 点火三级' +
             (near > 0 ? '（远地点点火效率最高）' : '');
    }
    for (var i = 0; i < HINTS.length; i++) {
      if (T < HINTS[i].until) { return HINTS[i].text; }
    }
    return HINTS[HINTS.length - 1].text;
  };

  /**
   * 告警条（挑战模式常驻，modes.md §4.2 顶部）
   * @returns {{sev:string, text:string}|null}
   */
  Director.prototype.alert = function (sim) {
    if (this.mode === 'demo') { return null; }      // 演示模式禁用失败判定，也不告警
    var F = C.FAIL, sc = sim.diff.failScale, t = sim.tele;
    var rq = t.q / (F.Q_MAX * sc);
    var rg = t.gForce / (F.G_MAX * sc);
    // 与 sim.js 的 F2 判定、hud.js 的读数共用 C.alphaLimitAt 这一个口径：
    // 真空里攻角不产生载荷，上限为 Infinity → ra = 0，不进告警（S4）。
    var ra = Math.abs(t.alpha) / C.alphaLimitAt(t.q, sc);
    var worst = Math.max(rq, rg, ra);
    if (worst >= 0.85) {
      var which = rq >= rg && rq >= ra
        ? '动压 ' + (t.q / 1000).toFixed(0) + ' kPa 接近上限'
        : (rg >= ra ? '过载 ' + t.gForce.toFixed(1) + ' g 接近上限'
                    : '攻角 ' + (Math.abs(t.alpha) * C.RAD).toFixed(1) + '° 接近上限');
      return { sev: worst >= 1 ? 'danger' : 'warning', text: '⚠ ' + which };
    }
    if (worst >= 0.65) {
      return { sev: 'caution', text: '接近结构限值，注意节流与姿态' };
    }
    return null;
  };

  /** 失败文案（modes.md §2.3 容错 T4：可回滚到最近节点重来） */
  Director.prototype.onFailure = function (f, sim) {
    return {
      title: '任务失败 · ' + f.name,
      text: (f.hint || '') + '（' + (f.value !== undefined
        ? f.value.toFixed(1) + ' ' + (f.unit || '') : '') + '）',
      canRollback: true
    };
  };

  return {
    Director: Director,
    NARRATION: NARRATION,
    COAST_SCRIPT: COAST_SCRIPT,
    HINTS: HINTS
  };
});
