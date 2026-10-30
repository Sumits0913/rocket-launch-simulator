/* =============================================================================
 * svg-rocket.js —— 长征十号 + 梦舟飞船 的 SVG 结构（静态图元层 L3）
 * -----------------------------------------------------------------------------
 * 依据：design/art/asset-spec.md §1.2 分层尺寸表、§1.3 逐部件规格、
 *       §1.4 喷管排布、§1.5 分离动画形态表、§2 梦舟飞船、§7.4 图层栈
 *
 * ── 为什么箭体用 SVG 而不是 Canvas（详见 adr-003）────────────────────────────
 *   ① 教师在 4K 大屏上会放大讲某一级，矢量任意缩放都锐利；
 *   ② 主题切换（浅色/深色）靠 CSS 变量直接生效，不必重绘；
 *   ③ DOM 节点可被屏幕阅读器读到，可访问性文档 §3 要求"结构可被读出"；
 *   ④ 分离动画是低频的 transform，交给 GPU 合成，CPU 几乎不出力。
 *   代价是图元数量要控制（asset-spec §7.2：>300 节点每帧更新会掉帧）。
 *   本文件只在【构建时】生成一次静态结构，运行时每帧只改 8 个 <g> 的
 *   transform 和 2 个 class，远低于阈值。
 *
 * ── 坐标（asset-spec §1.2）───────────────────────────────────────────────────
 *   箭体坐标：原点 = 芯一级尾喷管出口平面中心，+Y 沿箭轴指向头部，单位米。
 *   本文件内部全部按这个坐标写；SVG 的屏幕 y 轴朝下，所以最外层套一个
 *   scale(1,−1) 把 y 翻上来，之后所有数字都可以照抄文档表格，不用心算。
 *
 * ⚠ 描边宽度：SVG 用户单位 = 米，若直接写 stroke-width:2 会变成 2 米粗。
 *   所有描边元素都带 vector-effect="non-scaling-stroke"，让线宽恒为 2 CSS px，
 *   这样放大到 4K 讲解时轮廓线依然精细（asset-spec §1.3 逃逸塔"禁止 <2 px"）。
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  (root.RK = root.RK || {}).SvgRocket = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---- asset-spec §1.2 分层尺寸（米），集中在此，渲染层不得再写第二套 ------ */
  var G = {
    D: 5.0,                       // 归一化基准直径
    towerY: [84.5, 92.5],         // 逃逸塔
    fairY: [71.0, 84.5],          // 整流罩：71–73 分离面直筒，73–79.5 柱段，79.5–84.5 前锥
    fairCyl1: [71.0, 73.0],
    fairCyl2: [73.0, 79.5],
    fairCone: [79.5, 84.5],       // 直径 5.0 → 1.6
    s3Y: [57.0, 71.0],
    s2Y: [31.0, 57.0], s2Inter: [56.0, 57.0],
    s1Y: [0.0, 31.0], s1Body: [0.0, 29.8], s1Inter: [29.8, 31.0],
    boostY: [0.0, 33.0], boostBody: [0.0, 30.4], boostCone: [30.4, 33.0],
    boostX: 5.6,                  // 助推器中心 X 偏移 ±5.6（=1.12 D）
    skirt: 1.2, skirtW: 5.3,      // 尾裙：外扩 0.15 m → 直径 5.3
    nozzR: 1.65, nozzExit: 1.40, nozzLen: 2.40,   // §1.4：7 台，R=1.65，出口 1.40，长 2.40
    s2Nozz: { d: 1.8, len: 3.2, n: 2 },           // YF-100M 高空型：更长更大
    s3Nozz: { d: 1.6, len: 2.8, n: 3, ring: 1.2 } // YF-75E：3 台品字排布
  };

  /* 梦舟飞船（asset-spec §2.1）：本地原点 = 服务舱底部中心，+Y 向返回舱顶 */
  var SHIP = {
    baseY: 74.5,                  // §2.3：服务舱底在箭体坐标 Y=74.5
    service: [0, 3.5], serviceD: 3.8,
    crewCyl: [3.5, 6.0], crewD: 4.5,
    crewCone: [6.0, 8.6], crewTopD: 2.2,
    dock: [8.6, 9.0], dockD: 1.4,
    window: { y: 5.2, x: 1.4, d: 0.6 },
    solar: { y: [1.2, 3.4], len: 6.5, w: 2.4, panels: 4 }   // §2.2 太阳翼
  };

  /* ---- 小工具 ------------------------------------------------------------- */

  /** 缓动：cubic-bezier(0.2, 0, 0, 1) 的近似（asset-spec §1.5 通用规则） */
  function easeOut(p) {
    if (p <= 0) { return 0; }
    if (p >= 1) { return 1; }
    var q = 1 - p;
    return 1 - q * q * q;
  }

  function f(v) { return (Math.round(v * 100) / 100).toString(); }

  /** 矩形（米，y 向上）→ path。带 vector-effect 的描边由 CSS 统一给。 */
  function rect(x0, y0, x1, y1) {
    return 'M' + f(x0) + ' ' + f(y0) + 'H' + f(x1) + 'V' + f(y1) + 'H' + f(x0) + 'Z';
  }

  /** 上下底宽度不同的梯形/柱段：y0 处宽 w0，y1 处宽 w1，中心在 x=cx */
  function taper(cx, y0, w0, y1, w1) {
    return 'M' + f(cx - w0 / 2) + ' ' + f(y0) +
           'L' + f(cx + w0 / 2) + ' ' + f(y0) +
           'L' + f(cx + w1 / 2) + ' ' + f(y1) +
           'L' + f(cx - w1 / 2) + ' ' + f(y1) + 'Z';
  }

  /** 喷管（单个）：从 y=yTop（喉部，细）向下张开到 y=yTop−len（出口，粗） */
  function nozzle(cx, yTop, len, dExit, dTop) {
    var dt = dTop === undefined ? dExit * 0.62 : dTop;
    return taper(cx, yTop, dt, yTop - len, dExit);
  }

  /**
   * 一级模块底部 7 台 YF-100K（asset-spec §1.4）：中心 1 + 外圈 6（R=1.65）。
   * 侧视图只按 x 排序绘制；外圈 6 台在侧视图里两两重叠，用"伪纵深"错开
   * 一点点 x 与亮度，避免看起来只有 5 台（§1.4 视觉校验点）。
   */
  function nozzles7(cx, yBase, cls) {
    var out = [];
    var pts = [[0, 0]];
    for (var i = 0; i < 6; i++) {
      var a = i * 60 * Math.PI / 180;
      pts.push([Math.cos(a) * G.nozzR, Math.sin(a) * G.nozzR]);
    }
    // 按"纵深"排序：sin(a) < 0 的在后（先画、暗一点），> 0 的在前
    pts.sort(function (p, q) { return (p[1] || 0) - (q[1] || 0); });
    for (var j = 0; j < pts.length; j++) {
      var back = pts[j][1] < -0.01;
      out.push('<path class="' + cls + (back ? ' rk-back' : '') + '" d="' +
               nozzle(cx + pts[j][0] * (back ? 0.96 : 1), yBase,
                      G.nozzLen, G.nozzExit) + '"/>');
    }
    return out.join('');
  }

  /* ---------------------------------------------------------------------------
   * 生成整枚火箭的 SVG 字符串
   * ------------------------------------------------------------------------ */
  function markup() {
    var s = [];
    var D = G.D;

    /* ---- 芯一级（含尾裙 / 级间段 / 7 台喷管）------------------------------ */
    s.push('<g id="rk-s1" class="rk-stage">');
    s.push('<path class="rk-body" d="' + taper(0, 0, G.skirtW, G.skirt, D) + '"/>');   // 尾裙
    s.push('<path class="rk-body" d="' + rect(-D / 2, G.s1Body[0], D / 2, G.s1Body[1]) + '"/>');
    s.push('<path class="rk-body" d="' + taper(0, G.s1Inter[0], D, G.s1Inter[1], 4.9) + '"/>');
    // 3 条环焊缝（Y=8/18/27），不画任何文字涂装
    [8, 18, 27].forEach(function (y) {
      s.push('<path class="rk-weld" d="M' + f(-D / 2) + ' ' + y + 'H' + f(D / 2) + '"/>');
    });
    s.push(nozzles7(0, 0, 'rk-nozzle'));
    s.push('</g>');

    /* ---- 助推器 ×2（与芯级同径 5.0 m，长十的标志性识别特征）-------------- */
    [-1, 1].forEach(function (sgn) {
      var cx = sgn * G.boostX;
      var id = sgn < 0 ? 'rk-boost-l' : 'rk-boost-r';
      s.push('<g id="' + id + '" class="rk-stage" data-side="' + sgn + '">');
      s.push('<path class="rk-body" d="' + taper(cx, 0, G.skirtW, G.skirt, D) + '"/>');
      s.push('<path class="rk-body" d="' + rect(cx - D / 2, G.boostBody[0],
                                                cx + D / 2, G.boostBody[1]) + '"/>');
      // 头锥：锥高 2.6 m，顶径 1.2 m，略偏向外侧
      s.push('<path class="rk-body" d="' + taper(cx, G.boostCone[0], D, G.boostCone[1], 1.2) + '"/>');
      s.push(nozzles7(cx, 0, 'rk-nozzle'));
      s.push('</g>');
    });

    /* ---- 芯二级（2 台 YF-100M，喷管更长更大 = 高空型）--------------------- */
    s.push('<g id="rk-s2" class="rk-stage">');
    s.push('<path class="rk-body" d="' + rect(-D / 2, G.s2Y[0], D / 2, G.s2Inter[0]) + '"/>');
    s.push('<path class="rk-body" d="' + taper(0, G.s2Inter[0], D, G.s2Inter[1], 4.8) + '"/>');
    s.push('<g id="rk-s2-nozz" class="rk-hidden">');
    for (var i = 0; i < G.s2Nozz.n; i++) {
      var ox = (i - (G.s2Nozz.n - 1) / 2) * (G.s2Nozz.d + 0.5);
      s.push('<path class="rk-nozzle" d="' +
             nozzle(ox, G.s2Y[0] - 0.2, G.s2Nozz.len, G.s2Nozz.d) + '"/>');
    }
    s.push('</g></g>');

    /* ---- 芯三级（3 台 YF-75E 品字排布；氢氧级加一条细环带区分）------------ */
    s.push('<g id="rk-s3" class="rk-stage">');
    s.push('<path class="rk-body" d="' + rect(-D / 2, G.s3Y[0], D / 2, G.s3Y[1]) + '"/>');
    s.push('<path class="rk-band" d="M' + f(-D / 2) + ' 64H' + f(D / 2) + '"/>');
    s.push('<g id="rk-s3-nozz" class="rk-hidden">');
    for (var k = 0; k < G.s3Nozz.n; k++) {
      var a3 = -Math.PI / 2 + k * 2 * Math.PI / 3;    // 品字/等边三角
      var nx = Math.cos(a3) * G.s3Nozz.ring;
      s.push('<path class="rk-nozzle" d="' +
             nozzle(nx, G.s3Y[0] - 0.2, G.s3Nozz.len, G.s3Nozz.d) + '"/>');
    }
    s.push('</g></g>');

    /* ---- 梦舟飞船（在整流罩内；抛罩后或剖视时可见）------------------------ */
    s.push('<g id="rk-ship" class="rk-hidden"' +
           ' transform="translate(0 ' + SHIP.baseY + ')">');
    // 太阳翼（先画，在舱体后面）
    s.push('<g id="rk-wings" class="rk-wings">');
    [-1, 1].forEach(function (sgn) {
      var x0 = sgn * (SHIP.serviceD / 2);
      var x1 = sgn * (SHIP.serviceD / 2 + SHIP.solar.len);
      s.push('<path class="rk-wing" data-side="' + sgn + '" d="' +
             rect(Math.min(x0, x1), SHIP.solar.y[0], Math.max(x0, x1), SHIP.solar.y[1]) + '"/>');
      // 分板缝隙（4 段）
      for (var p = 1; p < SHIP.solar.panels; p++) {
        var xs = x0 + (x1 - x0) * (p / SHIP.solar.panels);
        s.push('<path class="rk-weld" d="M' + f(xs) + ' ' + SHIP.solar.y[0] +
               'V' + SHIP.solar.y[1] + '"/>');
      }
    });
    s.push('</g>');
    // 服务舱 + 主喷管
    s.push('<path class="rk-nozzle" d="' +
           nozzle(0, SHIP.service[0], 1.5, 1.2) + '"/>');
    s.push('<path class="rk-ship-body" d="' +
           rect(-SHIP.serviceD / 2, SHIP.service[0], SHIP.serviceD / 2, SHIP.service[1]) + '"/>');
    // 返回舱：下部圆柱 + 上部截锥 + 对接机构
    s.push('<path class="rk-ship-body" d="' +
           rect(-SHIP.crewD / 2, SHIP.crewCyl[0], SHIP.crewD / 2, SHIP.crewCyl[1]) + '"/>');
    s.push('<path class="rk-ship-body" d="' +
           taper(0, SHIP.crewCone[0], SHIP.crewD, SHIP.crewCone[1], SHIP.crewTopD) + '"/>');
    s.push('<path class="rk-ship-body" d="' +
           rect(-SHIP.dockD / 2, SHIP.dock[0], SHIP.dockD / 2, SHIP.dock[1]) + '"/>');
    // 防热大底（向下的浅弧，加粗描边 + 强调色 20%）
    s.push('<path class="rk-heat" d="M' + f(-SHIP.crewD / 2) + ' ' + SHIP.crewCyl[0] +
           'Q0 ' + f(SHIP.crewCyl[0] - 0.35) + ' ' + f(SHIP.crewD / 2) + ' ' + SHIP.crewCyl[0] + 'Z"/>');
    // 2 个舷窗
    [-1, 1].forEach(function (sgn) {
      s.push('<circle class="rk-window" cx="' + f(sgn * SHIP.window.x) +
             '" cy="' + SHIP.window.y + '" r="' + (SHIP.window.d / 2) + '"/>');
    });
    s.push('</g>');

    /* ---- 整流罩两半（分离面用虚线标示 = 教学点）--------------------------- */
    [-1, 1].forEach(function (sgn) {
      var id = sgn < 0 ? 'rk-fair-l' : 'rk-fair-r';
      // 半边：外轮廓 = 轴线侧直边 + 外侧曲线。这里用"柱段 + 前锥"的半侧路径。
      var w = D / 2;
      var p = [];
      p.push('M0 ' + G.fairCyl1[0]);                       // 轴线 · 底
      p.push('H' + f(sgn * w));                            // 底部横向到外侧
      p.push('V' + G.fairCone[0]);                         // 外侧直上到锥起点
      p.push('L' + f(sgn * SHIP.crewTopD / 2 * 1.6) + ' ' + G.fairY[1]); // 收到锥顶
      p.push('V' + G.fairCyl1[0] + 'Z');                   // 沿轴线回落
      s.push('<g id="' + id + '" class="rk-fair" data-side="' + sgn + '">');
      s.push('<path class="rk-fair-body" d="' + p.join(' ') + '"/>');
      s.push('<path class="rk-seam" d="M0 ' + G.fairCyl1[0] + 'V' + G.fairY[1] + '"/>');
      s.push('</g>');
    });

    /* ---- 逃逸塔（三角桁架 + 顶部逃逸发动机）------------------------------- */
    s.push('<g id="rk-tower" class="rk-tower">');
    var ty0 = G.towerY[0], ty1 = G.towerY[1], tw = 0.9;
    s.push('<path class="rk-truss" d="M' + f(-tw) + ' ' + f(ty0) + 'L0 ' + f(ty1 - 1.6) +
           'L' + f(tw) + ' ' + f(ty0) + '"/>');
    [0.33, 0.66, 0.95].forEach(function (k) {
      var y = ty0 + (ty1 - 1.6 - ty0) * k;
      var hw = tw * (1 - k) * 0.9;
      s.push('<path class="rk-truss" d="M' + f(-hw) + ' ' + f(y) + 'H' + f(hw) + '"/>');
    });
    // 顶部发动机舱（高 1.6 m，直径 1.4 m）+ 4 个侧向小喷管
    s.push('<path class="rk-tower-motor" d="' +
           rect(-0.7, ty1 - 1.6, 0.7, ty1 - 0.3) + '"/>');
    s.push('</g>');

    return s.join('');
  }

  /* ---------------------------------------------------------------------------
   * RocketView —— 运行时控制器
   * ------------------------------------------------------------------------ */
  function RocketView(mount) {
    this.mount = mount;
    this.el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.el.setAttribute('viewBox', '-10 -96 20 102');
    this.el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    this.el.setAttribute('class', 'rk-svg');
    this.el.setAttribute('role', 'img');
    this.el.setAttribute('aria-label', '长征十号运载火箭，芯级直径 5.0 米，' +
      '捆绑 2 个同径助推器，一级 21 台 YF-100K 发动机');
    // scale(1,-1)：把 SVG 的 y 轴翻上来，之后全部照抄"米"坐标
    var g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', 'scale(1,-1)');
    g.innerHTML = markup();
    this.el.appendChild(g);
    if (mount) { mount.appendChild(this.el); }
    this.g = g;
    this.n = {};
    ['rk-s1', 'rk-boost-l', 'rk-boost-r', 'rk-s2', 'rk-s2-nozz', 'rk-s3',
     'rk-s3-nozz', 'rk-ship', 'rk-wings', 'rk-fair-l', 'rk-fair-r',
     'rk-tower'].forEach(function (id) {
      this.n[id] = this.el.querySelector('#' + id);
    }, this);
  }

  /**
   * 每帧更新（只改 transform / class / opacity，不重建 DOM）
   * @param {object} sim  Sim 实例
   * @param {object} opt  { cutaway:boolean, tCur:number }
   */
  RocketView.prototype.update = function (sim, opt) {
    opt = opt || {};
    var t = sim.t;
    var evT = {};
    for (var i = 0; i < sim.events.length; i++) { evT[sim.events[i].id] = sim.events[i].t; }
    var n = this.n;

    /** 分离动画：返回 {p, opacity} */
    function sep(evId, dur) {
      var t0 = evT[evId];
      if (t0 === undefined) { return { p: 0, op: 1, live: false }; }
      var p = (t - t0) / dur;
      if (p < 0) { return { p: 0, op: 1, live: true }; }
      if (p > 1) {
        // 出画后 400 ms 内淡出并停画（asset-spec §1.5 通用规则）
        var fade = 1 - (p - 1) * dur / 400;
        return { p: 1, op: Math.max(0, fade), live: fade > 0 };
      }
      return { p: easeOut(p), op: 1, live: true };
    }

    // E4 逃逸塔：+Y 15 m，旋转 10°，600 ms
    var sT = sep('E4', 0.6);
    if (n['rk-tower']) {
      n['rk-tower'].style.display = (sim.flags.tower || sT.live) ? '' : 'none';
      n['rk-tower'].style.opacity = sT.op;
      n['rk-tower'].setAttribute('transform',
        'translate(' + f(0) + ' ' + f(15 * sT.p) + ') rotate(' + f(10 * sT.p) + ' 0 ' + 87 + ')');
    }

    // E5 助推器分离：±X 8 m、−Y 6 m、外翻 20°，800 ms
    var sB = sep('E5', 0.8);
    ['rk-boost-l', 'rk-boost-r'].forEach(function (id, k) {
      var sgn = k === 0 ? -1 : 1;
      var el = n[id];
      if (!el) { return; }
      el.style.display = (sim.flags.booster || sB.live) ? '' : 'none';
      el.style.opacity = sB.op;
      el.setAttribute('transform',
        'translate(' + f(sgn * 8 * sB.p) + ' ' + f(-6 * sB.p) + ') ' +
        'rotate(' + f(sgn * -20 * sB.p) + ' ' + f(sgn * G.boostX) + ' ' + 16 + ')');
    });

    // E6 一级分离：−Y 12 m，滚转 3°，900 ms；分离后二级喷管露出
    var s1 = sep('E6', 0.9);
    if (n['rk-s1']) {
      n['rk-s1'].style.display = (sim.flags.s1 || s1.live) ? '' : 'none';
      n['rk-s1'].style.opacity = s1.op;
      n['rk-s1'].setAttribute('transform',
        'translate(0 ' + f(-12 * s1.p) + ') rotate(' + f(3 * s1.p) + ' 0 15)');
    }
    if (n['rk-s2-nozz']) {
      n['rk-s2-nozz'].setAttribute('class', sim.flags.s1 ? 'rk-hidden' : '');
    }

    // E8 二级关机/分离 → 三级喷管露出（二三级分离在 E8 同时发生）
    if (n['rk-s3-nozz']) {
      n['rk-s3-nozz'].setAttribute('class', sim.flags.s2 ? 'rk-hidden' : '');
    }

    // E7 抛整流罩：两半 ±X 10 m、外翻 35°，800 ms
    var sF = sep('E7', 0.8);
    ['rk-fair-l', 'rk-fair-r'].forEach(function (id, k) {
      var sgn = k === 0 ? -1 : 1;
      var el = n[id];
      if (!el) { return; }
      el.style.display = (sim.flags.fairing || sF.live) ? '' : 'none';
      el.style.opacity = sF.op;
      el.setAttribute('transform',
        'translate(' + f(sgn * 10 * sF.p) + ' 0) rotate(' + f(sgn * -35 * sF.p) + ' 0 78)');
    });

    // 整流罩剖视（用户决策 #2）：演示模式可开，露出梦舟飞船
    var cut = !!opt.cutaway && sim.flags.fairing;
    ['rk-fair-l', 'rk-fair-r'].forEach(function (id) {
      var el = n[id];
      if (!el) { return; }
      el.classList.toggle('is-cutaway', cut);
    });

    // 梦舟飞船：抛罩后 / 剖视时可见
    var shipVisible = !sim.flags.fairing || cut;
    if (n['rk-ship']) {
      n['rk-ship'].style.display = shipVisible ? '' : 'none';
      // E12 船箭分离：+Y 6 m，1200 ms
      var sS = sep('E12', 1.2);
      n['rk-ship'].setAttribute('transform',
        'translate(0 ' + f(SHIP.baseY + 6 * sS.p) + ')');
      // 太阳翼：船箭分离后 5 s 开始展开，1200 ms 完成（asset-spec §2.2）
      var tDep = evT.E12 !== undefined ? (t - evT.E12 - 5) / 1.2 : -1;
      var wg = Math.max(0, Math.min(1, tDep));
      if (n['rk-wings']) {
        n['rk-wings'].style.display = wg > 0 ? '' : 'none';
        n['rk-wings'].setAttribute('transform',
          'translate(0 ' + SHIP.baseY * 0 + ') scale(' + f(0.12 + 0.88 * easeOut(wg)) + ' 1)');
      }
    }
  };

  /** 预演一遍"全分离"形态（自检 / 截图用） */
  RocketView.prototype.preview = function (flags) {
    var el = this.el;
    ['rk-tower', 'rk-boost-l', 'rk-boost-r', 'rk-s1', 'rk-fair-l', 'rk-fair-r']
      .forEach(function (id) {
        var e = el.querySelector('#' + id);
        if (e) { e.style.display = flags[id] ? '' : 'none'; }
      });
  };

  return {
    RocketView: RocketView,
    GEO: G,
    SHIP: SHIP,
    markup: markup
  };
});
