/* =============================================================================
 * render.js —— Canvas 渲染层（L0 背景 / L1 拖尾 / L2 尾焰烟羽）+ 相机
 * -----------------------------------------------------------------------------
 * 依据：design/art/asset-spec.md §3 特效、§7.3 分配表、§7.4 图层栈
 *       design/art/accessibility.md §4.2 前庭安全
 *
 * ── 为什么这些元素走 Canvas（详见 adr-003）───────────────────────────────────
 *   尾焰需要"三层径向渐变 + globalCompositeOperation='lighter' + 逐帧扰动"，
 *   SVG 做不到（不支持 lighter 合成、逐帧改 3000 个节点会掉帧）；
 *   拖尾点数累积到 2000+，星空 600 图元，同理只能走 Canvas。
 *   反过来，箭体是【静态结构 + 需放大讲解 + 需被屏幕阅读器读到】，走 SVG。
 *   两者用相机变换对齐，SVG 层由 main.js 用 CSS transform 摆到同一位置。
 *
 * ── 相机（asset-spec §0.1 唯一公式 + 本项目扩展了一个旋转）──────────────────
 *       screenX = (worldX − camX)·zoom + W/2
 *       screenY = H/2 − (worldY − camY)·zoom
 *   旋转 rot 是本项目为了"跟随相机保持当地垂线朝上"加的（否则飞出 2000 km 后
 *   火箭在屏幕上是斜着的，教师没法讲姿态）。三种相机模式：
 *       follow 跟随（zoom≈10 px/m，当地垂线朝上）
 *       global 全景（缩放至能看到整条弹道）
 *       orbit  轨道俯视（缩放至能看到整条轨道椭圆）
 *
 * ⚠ 地球不能画成一个半径 6 377 300 m 的 <circle>：缩放 10 px/m 时半径是
 *   6.4e7 px，光栅化器会直接放弃（画不出来或出花屏）。这里改成【按地心角采样
 *   可见弧段】画折线，只采样屏幕上能看见的那一段，精确且稳定。
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var isNode = (typeof require === 'function' && typeof module === 'object');
  var C = isNode ? require('../core/constants.js') : root.RK.Constants;
  var A11y = isNode ? require('./a11y.js') : root.RK.A11y;
  var api = factory(C, A11y);
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  (root.RK = root.RK || {}).Render = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, A11y) {
  'use strict';

  var R_REF = C.R_REF;

  /* ---------------------------------------------------------------------------
   * 主题色（Canvas 读不到 CSS 变量，只能在这里维护一套与 art-bible 对齐的值）
   * ------------------------------------------------------------------------ */
  var THEME = {
    dark: {
      sky0: '#01040c', sky1: '#050b1a',
      ground: '#0a1424', groundLine: '#2a4a72',
      atmo: '120,170,255',
      // 深色尾焰：三层叠加 + lighter 发光合成（asset-spec §3.1 原始设计）
      // 深底上靠"焰芯最亮（近白）"制造发光感
      plume: {
        l3: 'rgba(255,106,19,1)',        // #FF6A13 外焰
        l2: 'rgba(255,210,122,1)',       // #FFD27A 主焰
        l1: 'rgba(255,251,240,1)',       // #FFFBF0 焰芯（近白）
        l1Vac: 'rgba(255,255,255,0.45)', // 真空羽流芯
        vac: '150,200,255', vacA3: 0.35, vacA2: 0.55,
        strokeC: null, strokeW: 0,       // 深色不描边
        vacStrokeC: null
      },
      smoke: '150,150,150',
      trail: '#6fb6ea', target: '#2f6f4f', star: '#ffffff',
      composite: 'lighter'
    },
    light: {
      sky0: '#cfe3f5', sky1: '#eef3f8',
      ground: '#c9d6e2',
      atmo: '90,150,230',
      // 浅色尾焰：暗芯 + 亮边（asset-spec §3.1 浅色专用，美术 2026-09-01 裁决）
      // 原理：浅底上必须靠"比背景暗"才看得见。近白焰芯对 #eef3f8 的对比度只有
      //       1.0:1 —— 不是"实一些"，是完全看不见。明度方向必须反过来。
      plume: {
        l3: 'rgba(255,122,26,0.22)',     // #FF7A1A 外焰
        l2: 'rgba(255,194,74,0.55)',     // #FFC24A 主焰
        l1: 'rgba(194,65,12,0.90)',      // #C2410C 暗芯（对 #eef3f8 是 4.63:1）
        l1Vac: 'rgba(30,60,100,0.45)',   // #1E3C64 真空羽流暗芯
        vac: '30,60,100', vacA3: 0.22, vacA2: 0.45,
        strokeC: '#C2410C', strokeW: 2,  // L0 描边，沿 L2 轮廓，保证轮廓不糊
        vacStrokeC: '#1B6CA8'            // 真空羽流描边（色相正确）
      },
      smoke: '120,120,120',
      trail: '#1f5f96', target: '#2f6f4f', star: '#ffffff',
      composite: 'source-over'      // 浅色主题用 source-over，避免过曝（asset-spec §3.1）
    }
  };

  /* ---------------------------------------------------------------------------
   * 相机
   * ------------------------------------------------------------------------ */
  function Camera() {
    this.x = 0; this.y = R_REF;      // 世界坐标（米），默认对着发射点
    this.zoom = 10;                  // px / m
    this.rot = 0;                    // 弧度：把"当地垂线"转到屏幕正上方的角度
    this.shakeX = 0; this.shakeY = 0;
  }

  /** 世界 → 屏幕（CSS 像素） */
  Camera.prototype.toScreen = function (wx, wy, W, H) {
    var dx = wx - this.x, dy = wy - this.y;
    var cs = Math.cos(this.rot), sn = Math.sin(this.rot);
    // 先转到"屏幕朝上 = 当地垂线"的坐标系，再取屏幕（y 轴朝下）
    var rx = cs * dx + sn * dy;
    var ry = -sn * dx + cs * dy;
    return { x: rx * this.zoom + W / 2 + this.shakeX,
             y: H / 2 - ry * this.zoom + this.shakeY };
  };

  /* ---------------------------------------------------------------------------
   * Renderer
   * ------------------------------------------------------------------------ */
  function Renderer(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = 1; this.H = 1; this.dpr = 1;
    this.cam = new Camera();
    this.mode = 'follow';
    this._camPrevWall = -1;              // 上一帧墙上时间（秒），用于帧率无关的插值
    this._camTrans = 0;                  // 模式切换后剩余的缓动时长（秒），>0 时不硬跟随
    this.theme = THEME.dark;
    this.reduced = false;
    this.trail = [];                 // [{t, x, y}]
    this._lastTrailT = -1e9;
    this.stars = null;
    this._starSeed = 20250901;       // 固定种子：星空每次打开都一样，教师不会困惑
    this.resize();
  }

  /** DPR 处理（asset-spec §0.2）：位图按 DPR 放大，绘制仍用 CSS 像素坐标 */
  Renderer.prototype.resize = function () {
    var cv = this.canvas;
    var r = cv.getBoundingClientRect();
    var cssW = Math.max(1, Math.round(r.width || cv.clientWidth || 960));
    var cssH = Math.max(1, Math.round(r.height || cv.clientHeight || 540));
    var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    if (dpr > 2) { dpr = 2; }         // 封顶 2，4K 屏上再高只是徒增像素填充率
    this.W = cssW; this.H = cssH; this.dpr = dpr;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._buildStars();
  };

  Renderer.prototype.setTheme = function (name, reduced) {
    this.theme = THEME[name] || THEME.dark;
    this.reduced = !!reduced;
    this._buildStars();
  };

  Renderer.prototype.setCameraMode = function (m) {
    // 切换模式后先走 1.5 s 缓动，再回到该模式的稳态策略（避免镜头硬切）
    if (m !== this.mode) { this._camTrans = 1.5; }
    this.mode = m;
  };

  /* ---- 星空（离屏缓存，一次生成、之后只 drawImage）------------------------ */
  Renderer.prototype._buildStars = function () {
    var w = Math.ceil(this.W * 1.4), h = Math.ceil(this.H * 1.4);
    if (!(w > 0) || !(h > 0)) { return; }
    var off = document.createElement('canvas');
    off.width = w; off.height = h;
    var g = off.getContext('2d');
    g.clearRect(0, 0, w, h);
    if (this.theme === THEME.light) { this.stars = off; return; }  // 浅色主题不画星星
    var seed = this._starSeed;
    function rnd() {                 // 线性同余，固定种子 → 每次一致
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    }
    var n = 600;                     // asset-spec §3.3：600 图元
    for (var i = 0; i < n; i++) {
      var x = rnd() * w, y = rnd() * h;
      var r = rnd() * rnd() * 1.6 + 0.35;
      var a = 0.25 + rnd() * 0.65;
      g.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
      g.beginPath(); g.arc(x, y, r, 0, 6.283185); g.fill();
    }
    this.stars = off;
  };

  /* ---------------------------------------------------------------------------
   * 相机跟随：三种模式
   * @param {object} sim
   * @param {number} tWall 墙上时间（抖动用）
   * ------------------------------------------------------------------------ */
  Renderer.prototype.updateCamera = function (sim, tWall, intensity) {
    var y = sim.y, cam = this.cam;
    var x = y[0], yy = y[1];
    var r = Math.sqrt(x * x + yy * yy);
    var phi = Math.atan2(x, yy);                 // 下程地心角
    cam.rot = -phi;                              // 把当地垂线转到屏幕正上方

    var targetZoom = 10, cx = x, cy = yy;
    if (this.mode === 'orbit') {
      // 轨道俯视：以地心为中心，缩放到能装下整条轨道
      var el = sim.tele.el;
      var ra = (el && isFinite(el.ra)) ? el.ra : r;
      var span = Math.max(2 * ra, 2e6) * 1.15;
      targetZoom = Math.min(this.W, this.H) / span;
      cx = 0; cy = 0;
      cam.rot = -phi * 0.5;
    } else if (this.mode === 'global') {
      // 全景：装下"发射点 → 当前位置"整段，最小 300 km 视野
      var dx = x - 0, dy = yy - R_REF;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var span2 = Math.max(dist * 1.25, 300e3);
      targetZoom = Math.min(this.W / span2, this.H / (span2 * 0.6));
      if (!(targetZoom > 0) || !isFinite(targetZoom)) { targetZoom = 0.02; }
      cx = x * 0.35; cy = R_REF + (yy - R_REF) * 0.5;
    } else {
      // 跟随：相机钉在箭体上，箭体恒定显示在屏幕正中（用户明确要求居中）
      var hNow = r - R_REF;
      // 待发/起飞：整箭（SVG 102 用户单位 ≈ 92.5 m）应占屏高约 1/3。
      // 原来写死 9.8 px/m（按 1080 px 屏"整箭占满屏"标定），在 900 px 视口下
      // 箭体高 102×9.8 ≈ 1000 px，直接溢出屏幕并压住 HUD。改成按视口高度算。
      var zBase = this.H / (102 * 3);
      if (!(zBase > 0) || !isFinite(zBase)) { zBase = 2.94; }
      if (hNow < 3000) {
        targetZoom = zBase;                      // 起飞整箭（92.5 m）
      } else {
        // 高空逐步拉远，保证"地球曲率 + 高度"始终有参照
        targetZoom = Math.max(0.02, zBase * Math.pow(3000 / hNow, 0.42));
      }
      cx = x; cy = yy;
    }

    // ---- 相机平滑策略（FIX-002） ------------------------------------------
    // 帧率无关的一阶趋近系数 k = 1 - exp(-λ·dt)
    var dt = tWall - this._camPrevWall;
    if (!(dt > 0) || dt > 0.25) { dt = 1 / 60; }   // 首帧 / 长暂停：按 60 fps 兜底
    this._camPrevWall = tWall;
    if (this._camTrans > 0) { this._camTrans = Math.max(0, this._camTrans - dt); }

    // zoom：任何模式都保持平滑（缩放突变最刺眼，且缓慢变化不影响构图中心）
    var kz = 1 - Math.exp(-7.2 * dt);
    cam.zoom += (targetZoom - cam.zoom) * kz;

    // 位置：
    //  · follow 用【硬跟随】kp = 1。一阶趋近对匀速目标存在稳态滞后
    //    ≈ 单帧位移×(1-k)/k ≈ 单帧位移×7.85；火箭以 400+ m/s 东移时就是几百米
    //    （屏幕上数百像素）的持续偏心，且滞后随速度波动 → 看起来像"抖动平移"。
    //    火箭轨迹本身连续平滑，硬跟随不会生硬，且滞后不再被倍速放大。
    //  · global / orbit 是构图镜头，目标点本就会跳，保留缓动更柔和。
    //  · 刚切过模式的 1.5 s 内（_camTrans > 0）一律走快速缓动，避免硬切。
    var kp;
    if (this.mode === 'follow' && this._camTrans <= 0) {
      kp = 1;                                      // 硬跟随：零滞后
    } else {
      // 过渡期用更大的 λ：从 orbit（地心，几百万米外）切回 follow 时，
      // exp(-20×1.5) ≈ 1e-13，1.5 s 内残余已远小于 1 px，落锁时不会看到硬跳。
      var lam = (this.mode === 'follow') ? 20.0 : 7.2;
      kp = 1 - Math.exp(-lam * dt);
    }
    cam.x += (cx - cam.x) * kp;
    cam.y += (cy - cam.y) * kp;

    // 抖动：硬上限 6 px / 2 Hz（accessibility §4.2）
    var sh = A11y.shake(tWall, intensity || 0, this.reduced);
    cam.shakeX = sh.x; cam.shakeY = sh.y;
  };

  /* ---------------------------------------------------------------------------
   * 拖尾：按仿真时间采样，回溯时自动截断（保证与重放一致）
   * ------------------------------------------------------------------------ */
  /* FIX-004：固定 0.5 s 采样在低空 zoom≈2.5 px/m、速度 438 m/s 时，相邻两点在
   * 屏幕上相距 438×0.5×2.5 ≈ 550 px —— 每段都是一条横贯数百像素的长直线，
   * 看起来就是"一道横在屏幕上的线"。改成按【目标屏幕像素间距】自适应采样。 */
  Renderer.prototype.sampleTrail = function (sim) {
    var T = sim.t;
    if (T < this._lastTrailT) { return; }              // 回退由 trimTrail 处理
    var tv = (sim.tele && sim.tele.v > 0) ? sim.tele.v
           : Math.sqrt(sim.y[2] * sim.y[2] + sim.y[3] * sim.y[3]);
    var dt = TRAIL_TARGET_PX / Math.max(1e-6, tv * this.cam.zoom);
    if (!(dt > 0) || !isFinite(dt)) { dt = 0.5; }
    if (dt < 0.05) { dt = 0.05; } else if (dt > 0.5) { dt = 0.5; }
    if (T - this._lastTrailT < dt) { return; }
    this._lastTrailT = T;
    this.trail.push({ t: T, x: sim.y[0], y: sim.y[1] });
    if (this.trail.length > 4000) { this.trail.shift(); }
  };

  Renderer.prototype.trimTrail = function (t) {
    var tr = this.trail;
    while (tr.length && tr[tr.length - 1].t > t) { tr.pop(); }
    this._lastTrailT = tr.length ? tr[tr.length - 1].t : -1e9;
  };

  Renderer.prototype.clearTrail = function () { this.trail.length = 0; this._lastTrailT = -1e9; };

  /* ---------------------------------------------------------------------------
   * 地球：按地心角采样可见弧段
   * ------------------------------------------------------------------------ */
  // 采样点数：屏幕上每 4 px 一点，弦高误差 ≤0.5 px（asset-spec §3.4）
  // 肉眼分辨不出折线与圆弧，但能避免低缩放下的多边形棱角
  Renderer.prototype._earthSteps = function (radius, dphi) {
    var arcPx = 2 * dphi * radius * this.cam.zoom;   // 该弧段在屏幕上的长度（px）
    return Math.max(8, Math.min(2000, Math.ceil(arcPx / 4)));
  };

  Renderer.prototype._earthPath = function (radius, n) {
    var cam = this.cam, W = this.W, H = this.H;
    var phiC = Math.atan2(cam.x, cam.y);
    var halfSpanM = (Math.max(W, H) / 2) / Math.max(cam.zoom, 1e-9);
    // 1.6 倍余量：弧段两端各向外多延伸一段，避免"弧线在半空截断"（asset-spec §3.4）
    var dphi = (halfSpanM / R_REF) * 1.6 + 1e-6;
    if (dphi > 0.9) { dphi = 0.9; }
    var N = n || this._earthSteps(radius, dphi);     // 不传 n 时自适应
    var pts = [];
    for (var i = 0; i <= N; i++) {
      var f = i / N;
      var phi = phiC + (f - 0.5) * 2 * dphi;
      pts.push(this.cam.toScreen(radius * Math.sin(phi), radius * Math.cos(phi), W, H));
    }
    return pts;
  };

  Renderer.prototype._drawEarth = function (ctx, sim) {
    var W = this.W, H = this.H, th = this.theme, cam = this.cam;

    // 天空渐变
    var gsky = ctx.createLinearGradient(0, 0, 0, H);
    gsky.addColorStop(0, th.sky0);
    gsky.addColorStop(1, th.sky1);
    ctx.fillStyle = gsky;
    ctx.fillRect(0, 0, W, H);

    // 星空（跟随相机缓慢视差，≤1.5×，accessibility 无禁忌）
    if (this.stars && th === THEME.dark) {
      var sw = this.stars.width, sh = this.stars.height;
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.translate(W / 2, H / 2);
      ctx.rotate(cam.rot * 0.25);
      ctx.drawImage(this.stars, -sw / 2, -sh / 2);
      ctx.restore();
    }

    var surf = this._earthPath(R_REF);      // 采样点数自适应（asset-spec §3.4）
    var n = surf.length - 1;

    // 大气辉光：沿当地垂线方向的线性渐变，从地表到 120 km
    var p0 = surf[Math.floor(n / 2)];
    var up = this.cam.toScreen(
      (R_REF + 120e3) * Math.sin(Math.atan2(cam.x, cam.y)),
      (R_REF + 120e3) * Math.cos(Math.atan2(cam.x, cam.y)), W, H);
    var ga = ctx.createLinearGradient(p0.x, p0.y, up.x, up.y);
    ga.addColorStop(0, 'rgba(' + th.atmo + ',0.55)');
    ga.addColorStop(0.25, 'rgba(' + th.atmo + ',0.18)');
    ga.addColorStop(1, 'rgba(' + th.atmo + ',0)');
    ctx.fillStyle = ga;
    ctx.beginPath();
    ctx.moveTo(surf[0].x, surf[0].y);
    for (var i = 1; i <= n; i++) { ctx.lineTo(surf[i].x, surf[i].y); }
    var inner = this._earthPath(R_REF - 400e3, n);
    for (var j = n; j >= 0; j--) { ctx.lineTo(inner[j].x, inner[j].y); }
    ctx.closePath();
    ctx.fill();

    // 地表以下：实心填充（视觉上就是"地球"）
    ctx.fillStyle = th.ground;
    ctx.beginPath();
    ctx.moveTo(surf[0].x, surf[0].y);
    for (var k2 = 1; k2 <= n; k2++) { ctx.lineTo(surf[k2].x, surf[k2].y); }
    var deep = this._earthPath(R_REF - 4e6, n);
    for (var m = n; m >= 0; m--) { ctx.lineTo(deep[m].x, deep[m].y); }
    ctx.closePath();
    ctx.fill();

    // 地平线（asset-spec §3.4：屏幕半径 < 20000 px 时直接画圆，更快更精确；
    // 半径达到 1e7 px 量级时 ctx.arc 会被光栅化器放弃，必须走折线）
    ctx.strokeStyle = th.groundLine;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    var rPx = R_REF * cam.zoom;
    if (rPx < 20000) {
      var gc = cam.toScreen(0, 0, W, H);
      ctx.moveTo(gc.x + rPx, gc.y);
      ctx.arc(gc.x, gc.y, rPx, 0, 6.283185307179586);
    } else {
      ctx.moveTo(surf[0].x, surf[0].y);
      for (var q = 1; q <= n; q++) { ctx.lineTo(surf[q].x, surf[q].y); }
    }
    ctx.stroke();
    ctx.lineJoin = 'miter';

    // 发射场标记（一个小小的点 + 文字，起飞初期可见）
    var pad = this.cam.toScreen(0, R_REF, W, H);
    if (pad.x > -200 && pad.x < W + 200 && cam.zoom > 0.5) {
      ctx.fillStyle = th.trail;
      ctx.fillRect(pad.x - 2, pad.y - 2, 4, 4);
      if (cam.zoom > 2) {
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText(C.SITE.name, pad.x + 8, pad.y + 4);
      }
    }
  };

  /* ---------------------------------------------------------------------------
   * 拖尾
   * ------------------------------------------------------------------------ */
  var TRAIL_MARGIN = 200;      // 视口外容错余量（px），与验收口径一致
  var TRAIL_MAX_PTS = 1200;    // 单帧最多参与绘制的点数（≈10 min 航迹）
  var TRAIL_TARGET_PX = 24;    // FIX-004：采样点在屏幕上的目标间距（px）
  var TRAIL_BUDGET_FRAC = 0.35;// FIX-004：可见尾迹长度预算 = 0.35 × 屏宽（原 4×对角线太松）
  var TRAIL_SEGS = 4;          // FIX-004：渐隐分段数（头段实、尾段淡）

  /** Liang–Barsky：把线段裁到矩形内，返回 [x0,y0,x1,y1]；整段在框外返回 null */
  function clipSeg(x0, y0, x1, y1, xmin, ymin, xmax, ymax) {
    var t0 = 0, t1 = 1, dx = x1 - x0, dy = y1 - y0;
    var p = [-dx, dx, -dy, dy];
    var q = [x0 - xmin, xmax - x0, y0 - ymin, ymax - y0];
    for (var i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) { return null; } continue; }
      var r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) { return null; } if (r > t0) { t0 = r; } }
      else { if (r < t0) { return null; } if (r < t1) { t1 = r; } }
    }
    var ax = x0 + t0 * dx, ay = y0 + t0 * dy, bx = x0 + t1 * dx, by = y0 + t1 * dy;
    // 再夹一次：t 的浮点误差会让端点落在框外 ±1e-13，越界自检会误判
    if (ax < xmin) { ax = xmin; } else if (ax > xmax) { ax = xmax; }
    if (ay < ymin) { ay = ymin; } else if (ay > ymax) { ay = ymax; }
    if (bx < xmin) { bx = xmin; } else if (bx > xmax) { bx = xmax; }
    if (by < ymin) { by = ymin; } else if (by > ymax) { by = ymax; }
    return [ax, ay, bx, by];
  }

  Renderer.prototype._drawTrail = function (ctx, sim) {
    var tr = this.trail;
    if (!tr.length) { return; }
    var W = this.W, H = this.H, M = TRAIL_MARGIN;
    var xmin = -M, ymin = -M, xmax = W + M, ymax = H + M;
    var budget = TRAIL_BUDGET_FRAC * W;   // FIX-004：尾迹只拖出一小截

    // ① 采样点 → 屏幕，按【新 → 旧】排列。
    //    P[0] 是【临时尾点】= 火箭当前位置（只进局部数组，不写进 this.trail，
    //    所以不影响重放 / 回溯），用来消除"尾点 ↔ 火箭"之间几百像素的缺口。
    var start = Math.max(0, tr.length - TRAIL_MAX_PTS);
    var P = [this.cam.toScreen(sim.y[0], sim.y[1], W, H)];
    for (var i = tr.length - 1; i >= start; i--) {
      P.push(this.cam.toScreen(tr[i].x, tr[i].y, W, H));
    }

    // ② 跨度限制：从头点往尾部累计屏幕长度，超预算就停（保持 FIX-003 的语义）
    var n = P.length, iEnd = n - 1, acc = 0;
    for (var k = 1; k < n; k++) {
      var seg = Math.hypot(P[k].x - P[k - 1].x, P[k].y - P[k - 1].y);
      // 停在【越界的那一段之前】，保证可见路径长度严格 ≤ budget（而不是
      // "预算 + 一段"，那样会被最长的一段顶到 40% 屏宽以上）
      if (acc + seg > budget) { iEnd = k - 1; break; }
      acc += seg;
    }
    if (iEnd < 1) { return; }

    // ③ 渐隐 + 视口裁剪：分 TRAIL_SEGS 段，靠近火箭的一段最实、尾部最淡。
    //    这样它读起来是"火箭后面的尾迹"，而不是一条横贯屏幕的线。
    //    clipSeg（FIX-003）保持不回退：每段先裁到 [-M, W+M]×[-M, H+M]，裁空就断笔。
    ctx.strokeStyle = this.theme.trail;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (var s = 0; s < TRAIL_SEGS; s++) {
      var a0 = Math.floor(iEnd * s / TRAIL_SEGS);
      var a1 = Math.floor(iEnd * (s + 1) / TRAIL_SEGS);
      if (a1 <= a0) { continue; }
      ctx.globalAlpha = 0.72 * (1 - s / TRAIL_SEGS) + 0.05;
      ctx.beginPath();
      var pen = false, cx0 = P[a0].x, cy0 = P[a0].y;
      for (var j = a0 + 1; j <= a1; j++) {
        var sg = clipSeg(cx0, cy0, P[j].x, P[j].y, xmin, ymin, xmax, ymax);
        if (sg) {
          if (!pen) { ctx.moveTo(sg[0], sg[1]); pen = true; }
          ctx.lineTo(sg[2], sg[3]);
        } else {
          pen = false;                                  // 整段在外：下一段重新起笔
        }
        cx0 = P[j].x; cy0 = P[j].y;
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  /* ---------------------------------------------------------------------------
   * 质心高度 h_cm（FIX-004）
   * -------------------------------------------------------------------------
   * sim.y[0], sim.y[1] 是【质心】的世界位置（相机 follow 锁的就是它）。
   * 而箭体坐标原点是【芯一级尾喷管出口平面中心】（svg-rocket.js:17 的定义），
   * 两者相差 h_cm。原来的 body2world 把 sim.y 当成箭体原点用，于是 Canvas 上的
   * 尾焰被整体抬高 h_cm（≈38 px/m × 21 m）画进了箭体肚子里。
   *
   * h_cm = 各分段质量 × 分段几何中心高度 的加权平均。分段中心取自
   * svg-rocket.js 的 GEO/SHIP（s1 0–31→15.5、boost 0–33→16.5、s2 31–57→44、
   * s3 57–71→64、fairing 71–84.5→77.75、tower 84.5–92.5→88.5、
   * 适配器 71–74.5→72.75、梦舟 baseY 74.5 高 9 m→79）。
   * 干重查 sim.veh（vehicle.js BASE），推进剂取 sim.y[4..7] 的当前余量。
   *
   * ⚠ 这是【纯视觉量】：只影响 Canvas 尾焰 / 拖尾与 SVG 箭体的对齐，不进
   *   src/core/，不参与任何受力或积分，不改变物理与 Δv。
   * ---------------------------------------------------------------------- */
  var CM_DRY_FB = { tower: 9e3, fairing: 6e3, adapter: 5.5e3,
                    s3: 10.5e3, s2: 22e3, s1: 54e3, booster: 45e3 };

  function cmHeight(sim) {
    var v = sim.veh || {}, f = sim.flags || {}, y = sim.y;
    var m = 0, my = 0;
    function dry(k) { return (v[k] && v[k].dry) || CM_DRY_FB[k] || 0; }
    function add(mm, yy) { if (mm > 0) { m += mm; my += mm * yy; } }

    if (f.tower   !== false) { add(dry('tower'), 88.5); }
    if (f.fairing !== false) { add(dry('fairing'), 77.75); }
    if (f.adapter !== false) { add(dry('adapter'), 72.75); }
    add((v.payload && v.payload.mass) || 0, 79);              // 梦舟飞船
    if (f.s3 !== false) { add(dry('s3') + Math.max(0, y[7]), 64); }
    if (f.s2 !== false) { add(dry('s2') + Math.max(0, y[6]), 44); }
    if (f.s1 !== false) { add(dry('s1') + Math.max(0, y[5]), 15.5); }
    if (f.booster !== false) {
      var nb = (v.booster && v.booster.count) || 2;
      add(nb * (dry('booster') + Math.max(0, y[4])), 16.5);   // y[4] 是【单个】助推器余量
    }
    if (!(m > 0)) { return 21; }                              // 兜底，不该发生
    return my / m;
  }

  /* ---------------------------------------------------------------------------
   * 箭体基向量（把箭体坐标 (bx,by) 换算到世界坐标）
   *   û_T = cosθ·t̂ + sinθ·r̂   （沿箭轴指向头部）
   *   p̂   = sinθ·t̂ − cosθ·r̂   （箭体"右侧"）
   * ------------------------------------------------------------------------ */
  function bodyBasis(sim) {
    var x = sim.y[0], yy = sim.y[1];
    var r = Math.sqrt(x * x + yy * yy);
    var rx = x / r, ry = yy / r;          // r̂
    var tx = yy / r, ty = -x / r;         // t̂（当地正东）
    var th = sim.y[8];
    var ct = Math.cos(th), st = Math.sin(th);
    return {
      r: r,
      ux: ct * tx + st * rx, uy: ct * ty + st * ry,           // û_T
      px: st * tx - ct * rx, py: st * ty - ct * ry,           // p̂
      rx: rx, ry: ry,
      hcm: cmHeight(sim)                                      // FIX-004
    };
  }

  /** 箭体坐标 → 世界坐标（sim.y 是质心，所以要扣掉 h_cm） */
  function body2world(sim, B, bx, by) {
    var h = (B && typeof B.hcm === 'number') ? B.hcm : cmHeight(sim);
    return { x: sim.y[0] + bx * B.px + (by - h) * B.ux,
             y: sim.y[1] + bx * B.py + (by - h) * B.uy };
  }

  /* ---------------------------------------------------------------------------
   * 尾焰几何（asset-spec §3.1 状态变体表）
   * @returns {L, W, alpha, vac}  L/W 单位米
   * ------------------------------------------------------------------------ */
  function plumeGeom(sim, stage) {
    var h = sim.tele.h;
    var pr = Math.max(0, Math.min(1, sim.tele.pa / C.P0));
    var eta = sim.throttleEff;
    var vac = (stage >= 2) || h > 100e3;
    if (vac) {
      // 真空羽流：几乎无可见焰锥，只有弥散羽流（硬核还原点）
      return { L: 5.0 * 0.8, W: 5.0 * 3.0, alpha: 0.25, vac: true };
    }
    var L = 5.0 * (1.6 + 2.4 * (1 - pr));        // 海平面 8 m → 真空 20 m
    var W = 5.0 * (1.0 + 1.4 * (1 - pr));        // 海平面 5 m → 真空 12 m
    L *= (0.7 + 0.3 * eta);
    W *= (0.9 + 0.4 * eta);
    var alpha = pr > 0.5 ? 1.0 : (0.45 + 0.55 * pr * 2);
    return { L: L, W: W, alpha: alpha, vac: false };
  }

  /** 画一个模块的尾焰（三层叠加，asset-spec §3.1 伪代码的直译） */
  Renderer.prototype._drawPlume = function (ctx, sim, B, bx, by, stage, tWall) {
    var gm = plumeGeom(sim, stage);
    if (gm.L <= 0.01) { return; }
    var th = this.theme;
    var W = this.W, H = this.H;

    var base = body2world(sim, B, bx, by);                 // 喷口
    var tip = body2world(sim, B, bx, by - gm.L);           // 焰尾（沿 −û_T）
    var ps = this.cam.toScreen(base.x, base.y, W, H);
    var pe = this.cam.toScreen(tip.x, tip.y, W, H);
    var pw = this.cam.toScreen(body2world(sim, B, bx + gm.W / 2, by).x,
                               body2world(sim, B, bx + gm.W / 2, by).y, W, H);
    var halfPx = Math.max(1.2, Math.hypot(pw.x - ps.x, pw.y - ps.y));
    var lenPx = Math.max(2, Math.hypot(pe.x - ps.x, pe.y - ps.y));
    var ang = Math.atan2(pe.y - ps.y, pe.x - ps.x);

    ctx.save();
    ctx.translate(ps.x, ps.y);
    ctx.rotate(ang);
    ctx.globalCompositeOperation = th.composite;
    ctx.globalAlpha = gm.alpha;

    var amp = this.reduced ? 0 : 0.06 * lenPx;             // 逐帧扰动（reducedMotion 关闭）
    var STEPS = 12;

    // 构造焰流轮廓。fill 与 strokeC 可单选或同给——L0 描边复用同一个 Path2D。
    function flame(lenScale, widScale, fill, strokeC, strokeW) {
      var path = new Path2D();
      var i, s, yy, wob, hw;
      for (i = 0; i <= STEPS; i++) {
        s = i / STEPS;
        yy = s * lenPx * lenScale;
        wob = Math.sin(tWall * 7.0 + s * 1.5) * amp * s;
        hw = halfPx * widScale * (0.35 + 0.65 * Math.sin(Math.PI * Math.pow(s, 0.7)));
        if (i === 0) { path.moveTo(yy, wob + hw); } else { path.lineTo(yy, wob + hw); }
      }
      for (i = STEPS; i >= 0; i--) {
        s = i / STEPS;
        yy = s * lenPx * lenScale;
        wob = Math.sin(tWall * 7.0 + s * 1.5) * amp * s;
        hw = halfPx * widScale * (0.35 + 0.65 * Math.sin(Math.PI * Math.pow(s, 0.7)));
        path.lineTo(yy, wob - hw);
      }
      path.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(path); }
      if (strokeC) {
        ctx.strokeStyle = strokeC;
        ctx.lineWidth = strokeW || 2;
        ctx.lineJoin = 'round';
        ctx.stroke(path);
      }
      return path;
    }

    var PL = th.plume;

    // L3 外焰
    var g3 = ctx.createLinearGradient(0, 0, lenPx * 1.4, 0);
    g3.addColorStop(0, gm.vac ? 'rgba(' + PL.vac + ',' + PL.vacA3 + ')' : PL.l3);
    g3.addColorStop(1, 'rgba(0,0,0,0)');
    flame(1.4, 1.0, g3);

    // L2 主焰
    var g2 = ctx.createLinearGradient(0, 0, lenPx, 0);
    g2.addColorStop(0, gm.vac ? 'rgba(' + PL.vac + ',' + PL.vacA2 + ')' : PL.l2);
    g2.addColorStop(1, 'rgba(0,0,0,0)');
    flame(1.0, 0.72, g2);

    // L1 焰芯（浅色主题下这是"暗芯"，也是浅底上唯一真正看得见的层）
    var g1 = ctx.createRadialGradient(lenPx * 0.06, 0, 0, lenPx * 0.06, 0, lenPx * 0.35 + halfPx);
    g1.addColorStop(0, gm.vac ? PL.l1Vac : PL.l1);
    g1.addColorStop(1, 'rgba(0,0,0,0)');
    flame(0.35, 0.42, g1);

    // L0 描边（浅色主题专用）：沿 L2 轮廓描实边，避免浅底上轮廓糊掉
    var sc = gm.vac ? PL.vacStrokeC : PL.strokeC;
    if (sc) { flame(1.0, 0.72, null, sc, PL.strokeW); }

    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  };

  /* ---------------------------------------------------------------------------
   * 地面烟羽（起飞段）：确定性粒子 —— 位置是 (序号, 时间) 的函数，无随机状态，
   * 所以时间线拖拽回溯时烟羽不会"跳变"（与物理一样可复现）。
   * ------------------------------------------------------------------------ */
  Renderer.prototype._drawSmoke = function (ctx, sim, tLift) {
    if (this.reduced) { return; }
    var h = sim.tele.h;
    if (h > 3000) { return; }
    var T = sim.missionTime();
    if (T < 0) { return; }
    var W = this.W, H = this.H, th = this.theme;
    var n = 26;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 0.5 * (1 - h / 3000));
    for (var i = 0; i < n; i++) {
      // 第 i 个烟团在 T_i = i*0.12 s 生成，之后以固定速度外扩并上升
      var t0 = i * 0.12;
      if (T < t0) { continue; }
      var age = Math.min(1, (T - t0) / 6);
      var side = (i % 2 === 0) ? 1 : -1;
      var off = side * (10 + 90 * age + (i % 5) * 6);
      var up = 8 + 140 * Math.pow(age, 0.7);
      var wx = off, wy = R_REF + up;
      var p = this.cam.toScreen(wx, wy, W, H);
      var rad = (6 + 34 * age) * Math.max(0.15, this.cam.zoom / 10);
      var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(1, rad));
      g.addColorStop(0, 'rgba(' + th.smoke + ',' + (0.5 * (1 - age)).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + th.smoke + ',0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1, rad), 0, 6.283185); ctx.fill();
    }
    ctx.restore();
  };

  /* ---------------------------------------------------------------------------
   * 主绘制
   * @param {object} sim
   * @param {object} opt { tWall, intensity }
   * ------------------------------------------------------------------------ */
  Renderer.prototype.draw = function (sim, opt) {
    opt = opt || {};
    var ctx = this.ctx, W = this.W, H = this.H;
    this.updateCamera(sim, opt.tWall || 0, opt.intensity || 0);

    ctx.clearRect(0, 0, W, H);
    this._drawEarth(ctx, sim);
    this._drawTrail(ctx, sim);

    var B = bodyBasis(sim);

    // L2 尾焰必须画在箭体【之下】（asset-spec §7.4 关键约束）
    if (sim.burning.s1 && sim.flags.s1 && sim.y[5] > 0) {
      this._drawPlume(ctx, sim, B, 0, -2.4, 1, opt.tWall || 0);
      if (sim.flags.booster && sim.y[4] > 0) {
        this._drawPlume(ctx, sim, B, -5.6, -2.4, 1, opt.tWall || 0);
        this._drawPlume(ctx, sim, B, +5.6, -2.4, 1, opt.tWall || 0);
      }
    }
    if (sim.burning.s2 && sim.y[6] > 0) { this._drawPlume(ctx, sim, B, 0, 30.8, 2, opt.tWall || 0); }
    if (sim.burning.s3 && sim.y[7] > 0) { this._drawPlume(ctx, sim, B, 0, 56.6, 3, opt.tWall || 0); }

    this._drawSmoke(ctx, sim, sim.tLift);

    // 目标轨道圈（教学：让学生看到"要飞到那条线上"）
    var alt = sim.veh.targetAlt;
    if (this.mode !== 'follow' || sim.tele.h > 80e3) {
      var n = 180, pts = this._earthPath(R_REF + alt, n);
      ctx.save();
      ctx.setLineDash([8, 8]);
      ctx.strokeStyle = this.theme.target;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (var i = 0; i <= n; i++) {
        if (i === 0) { ctx.moveTo(pts[i].x, pts[i].y); } else { ctx.lineTo(pts[i].x, pts[i].y); }
      }
      ctx.stroke();
      ctx.restore();
    }
  };

  /** 给 main.js 用：把 SVG 箭体摆到相机算出的位置 */
  Renderer.prototype.rocketTransform = function (sim) {
    var B = bodyBasis(sim);
    /* FIX-004：SVG 箭体与 Canvas 必须共用同一套"箭体坐标 → 屏幕"刚体变换。
     *
     * 元素 20×102 CSS px，viewBox '-10 -96 20 102'，内层 <g scale(1,-1)>，
     * 于是：箭体 (bx,by) → 元素坐标 (10+bx, 96−by)。
     * CSS 的 transform-origin 是 (10px,96px)，正好是【箭体原点】。带 origin 的
     * transform 把 origin 点送到 (10,96) + translate —— 也就是说箭体原点最终落在
     * screen = translate + (10, 96)。
     *
     * 所以：translate = toScreen(箭体原点的世界坐标) − (10, 96)。
     * 之前直接填了 toScreen(sim.y)（质心的屏幕位置），既没减 (10,96)、也把质心
     * 当成了箭体原点，于是 SVG 与 Canvas 两套坐标稳定相差 (+10, +96) px
     * —— 这正是"尾焰画进箭体肚子里"的来源。
     *
     * 这样写之后，绕 origin 的 rotate(deg) 与 body2world 的 h_cm 补偿合起来
     * 等价于"绕质心旋转"：deg≠0 时质心仍钉在屏幕中心，箭体不再漂出画面。
     */
    var o = body2world(sim, B, 0, 0);
    var p = this.cam.toScreen(o.x, o.y, this.W, this.H);
    // 屏幕方向向量：把世界里的 û_T 旋转到屏幕系，取"相对屏幕正上方"的顺时针角
    var cs = Math.cos(this.cam.rot), sn = Math.sin(this.cam.rot);
    var sx = cs * B.ux + sn * B.uy;
    var sy = -sn * B.ux + cs * B.uy;
    // (sx, sy) 与 toScreen 的 (rx, ry) 同构，是【数学系】（y 朝上），所以"相对
    // 屏幕正上方"的顺时针角就是 atan2(sx, sy)。CSS rotate() 正方向同样是顺时针，
    // 可直接用。原写法多了一个负号 atan2(sx, -sy)，导致箭体恒定反相 180°（倒立）。
    var deg = Math.atan2(sx, sy) * 180 / Math.PI;
    return { x: p.x - 10, y: p.y - 96, deg: deg, zoom: this.cam.zoom, hcm: B.hcm };
  };

  return {
    Renderer: Renderer,
    Camera: Camera,
    THEME: THEME,
    bodyBasis: bodyBasis,
    body2world: body2world,
    plumeGeom: plumeGeom
  };
});
