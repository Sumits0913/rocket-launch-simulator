/* =============================================================================
 * hud.js —— HUD（DOM + CSS 变量 + SVG 图标）
 * -----------------------------------------------------------------------------
 * 依据：design/ui-spec.md §1.2 区域职责、§1.3 大屏可读性；
 *       design/art/asset-spec.md §5.1/§5.2 HUD 规格；
 *       design/gdd/modes.md §4.1/§4.2/§4.3 两模式差异；
 *       design/art/accessibility.md §2.3 形状编码、§4.4 数值稳定性
 *
 * 三条硬性实现规则（ui-spec §1.3 / accessibility §4.4）：
 *   1) 【数字必须等宽 + tabular-nums + 固定小数位】。否则数值每帧宽度变化，
 *      投影上整块 HUD 会左右抖，学生根本读不进去。
 *   2) 【刷新 ≤ 10 Hz + 300 ms 缓动】。60 Hz 的原始积分值肉眼是抖动的，
 *      且易诱发光敏不适。这里用 RateLimiter(10) 限频 + Tween(300ms) 过渡，
 *      既跟得上物理，又稳得住眼睛。
 *   3) 【严重度用形状边数编码，不只靠颜色】。色盲用户看形状即可分辨：
 *      ● 圆=正常 ▲ 三角=注意 ◆ 菱形=警告 ⬢ 六边=危险（a11y.js SEV 表）。
 *
 * ⚠ 为什么 HUD 走 DOM 而不是画在 Canvas 上：文字需要被屏幕阅读器读到、
 *   需要 tabular-nums、需要 CSS 变量跟随主题，这三点 Canvas 都做不到
 *   （asset-spec §7.3 分配表明确：HUD 数值文字 = DOM）。
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var isNode = (typeof require === 'function' && typeof module === 'object');
  var C = isNode ? require('../core/constants.js') : root.RK.Constants;
  var A11y = isNode ? require('./a11y.js') : root.RK.A11y;
  var Tl = isNode ? require('./timeline.js') : root.RK.Timeline;
  var api = factory(C, A11y, Tl);
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  (root.RK = root.RK || {}).Hud = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, A11y, Tl) {
  'use strict';

  var fmtT = Tl.fmtT;

  function el(tag, cls, parent, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined) { e.textContent = text; }
    if (parent) { parent.appendChild(e); }
    return e;
  }

  /** 固定小数位格式化（宽度稳定 = 不抖） */
  function fx(v, d) {
    if (!isFinite(v)) { return '—'; }
    return v.toFixed(d);
  }

  /* ---------------------------------------------------------------------------
   * 一个"读数"单元：标签 + 数值 + 单位 + 严重度形状标记
   * ------------------------------------------------------------------------ */
  function Readout(parent, opt) {
    opt = opt || {};
    var box = el('div', 'ro' + (opt.big ? ' ro-big' : ''), parent);
    if (opt.label) { el('div', 'ro-label', box, opt.label); }
    var line = el('div', 'ro-line', box);
    if (opt.severity) {
      var sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      sv.setAttribute('class', 'ro-mark');
      sv.setAttribute('viewBox', '0 0 20 20');
      sv.setAttribute('aria-hidden', 'true');
      line.appendChild(sv);
      this._mark = sv;
    }
    var val = el('span', 'ro-val', line, '—');
    if (opt.unit) { el('span', 'ro-unit', line, opt.unit); }
    this.el = box; this.valEl = val;
    this.digits = opt.digits === undefined ? 1 : opt.digits;
    this.rate = new A11y.RateLimiter(10);        // ≤10 Hz（accessibility §4.4）
    this.tween = new A11y.Tween(0, 300);         // 300 ms 过渡
    this._last = '';
    this._shapeOn = null;
  }

  /** @param {number} dt 帧时间 s；v 当前真值；ratio 可选：当前值/上限（严重度） */
  Readout.prototype.update = function (dt, v, ratio) {
    this.tween.set(isFinite(v) ? v : 0);
    this.tween.update(dt);
    if (this._mark && ratio !== undefined) {
      var sev = A11y.severity(Math.abs(ratio));
      if (sev !== this._shapeOn) {
        this._shapeOn = sev;
        var color = 'var(--sev-' + sev + ')';
        this._mark.innerHTML = A11y.shapeSvg(sev, 20, color);
      }
    }
    if (!this.rate.tick(dt)) { return; }
    var s = fx(this.tween.value, this.digits);
    if (s !== this._last) { this._last = s; this.valEl.textContent = s; }
  };

  /* ---------------------------------------------------------------------------
   * 姿态指示器（挑战模式常驻，modes.md §4.2 右下）
   *   人工地平线 + θ（姿态角）+ γ（弹道倾角）+ α（攻角）
   * ------------------------------------------------------------------------ */
  function Attitude(parent) {
    var box = el('div', 'att', parent);
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '-50 -50 100 100');
    svg.setAttribute('class', 'att-svg');
    box.appendChild(svg);
    svg.innerHTML =
      '<circle class="att-bg" cx="0" cy="0" r="46"/>' +
      '<g id="att-horizon">' +
      '  <path class="att-sky" d="M-46 0 H46 V-46 H-46 Z"/>' +
      '  <path class="att-line" d="M-46 0 H46"/>' +
      '</g>' +
      '<path class="att-ladder" d="M-20 -30 H20 M-12 -15 H12 M-12 15 H12 M-20 30 H20"/>' +
      '<g id="att-thrust"><path class="att-thrust" d="M0 0 V-40 M-6 -34 L0 -40 L6 -34"/></g>' +
      '<g id="att-vel"><path class="att-vel" d="M0 0 L0 -38 M-6 -30 L0 -38 L6 -30"/></g>' +
      '<circle class="att-hub" cx="0" cy="0" r="3"/>';
    this.svg = svg;
    this.gH = svg.querySelector('#att-horizon');
    this.gT = svg.querySelector('#att-thrust');
    this.gV = svg.querySelector('#att-vel');
    this.txt = el('div', 'att-txt', box, 'θ —  γ —  α —');
    /* 操控状态读数（挑战模式）
     * 姿态圆盘显示的是 θ/γ/α —— 那是【自动驾驶程序 + 玩家偏置】的合成结果。
     * 学生按了 ↑ 之后看到火箭在动，却分不清"这是我按出来的"还是"程序自己在转弯"，
     * 于是会一直按住不放，直到火箭翻掉也不知道怪谁。
     * 这里把三个"只看操作、不看结果"的量单独拆出来，让操作可见：
     *   偏置 = 我累积产生了多少姿态修正（↑↓ 的效果）
     *   油门 = 当前推力百分比（Q/E 的效果）
     *   制导 = 现在听谁的（自动 = AP 主导，手动 = 全手动姿态） */
    this.ctlTxt = el('div', 'att-ctl', box, '');
    this.rate = new A11y.RateLimiter(10);
  }

  Attitude.prototype.update = function (dt, sim) {
    var t = sim.tele;
    // 姿态指示器画的是"相对当地水平"的角度：θ 从当地水平量起，直接用
    var degT = t.theta * C.RAD, degG = t.gamma * C.RAD, degA = t.alpha * C.RAD;
    this.gH.setAttribute('transform', 'rotate(' + (-degT).toFixed(2) + ')');
    this.gT.setAttribute('transform', 'rotate(' + (-degT).toFixed(2) + ')');
    this.gV.setAttribute('transform', 'rotate(' + (-degG).toFixed(2) + ')');
    if (this.rate.tick(dt)) {
      this.txt.textContent = 'θ ' + fx(degT, 1) + '°   γ ' + fx(degG, 1) +
                             '°   α ' + fx(degA, 1) + '°';
      var c = sim.ctl;
      if (c) {
        var bDeg = c.bias * C.RAD;
        // 偏置归零时不显示正负号，避免"−0.0°"这种让人以为系统出错的显示
        var bTxt = Math.abs(bDeg) < 0.05 ? '0.0'
                 : (bDeg > 0 ? '+' : '−') + fx(Math.abs(bDeg), 1);
        this.ctlTxt.textContent =
          '偏置 ' + bTxt + '°   油门 ' + Math.round(c.throttle * 100) + '%   ' +
          ((c.manual && !c.apEnabled) ? '手动' : '自动');
      }
    }
  };

  /* ---------------------------------------------------------------------------
   * HUD 主体
   * ------------------------------------------------------------------------ */
  function Hud(mount, opts) {
    opts = opts || {};
    this.mount = mount;
    this.mode = opts.mode || 'demo';
    this.dataLayer = opts.dataLayer || 1;
    var root2 = el('div', 'hud', mount);
    this.el = root2;

    /* ---- 右侧竖列容器（FIX-003 问题 A / C）------------------------------
       右上读数块与右侧数据面板放进同一个 flex 列里，列高由 CSS 按视口钉死：
       读数块取自然高度，面板吃掉剩余高度、溢出部分自己滚。
       原来两者都是 absolute 且 .hud-side 写死 top:200px，
       而 L3 下读数块实测高 373 px —— 必然压住面板顶部近 200 px。         */
    var rcol = el('div', 'hud-rcol', root2);

    /* ---- 左上：任务时间 / 事件 ------------------------------------------ */
    var tlBox = el('div', 'hud-tl', root2);
    this.timeEl = el('div', 'hud-time', tlBox, 'T+00:00');
    this.evEl = el('div', 'hud-event', tlBox, '待发射');
    this.nextEl = el('div', 'hud-next', tlBox, '');

    /* ---- 右上：主数据 --------------------------------------------------- */
    var tr = el('div', 'hud-tr', rcol);
    this.vEl = new Readout(tr, { label: '速度', unit: 'km/s', digits: 3, big: true });
    this.hEl = new Readout(tr, { label: '高度', unit: 'km', digits: 1, big: true });
    this.gEl = new Readout(tr, { label: '过载', unit: 'g', digits: 2, severity: true });
    this.qEl = new Readout(tr, { label: '动压', unit: 'kPa', digits: 1, severity: true });
    this.aEl = new Readout(tr, { label: '攻角', unit: '°', digits: 1, severity: true });

    /* ---- 左下竖列：推进剂 + 姿态指示器 ----------------------------------
       ⚠ 这里原来是"推进剂 absolute 在左下、姿态指示器 absolute 在右下"，
       两者各占一块。但挑战模式下右侧数据面板（.hud-rcol）会一路撑到底部，
       把右下角的姿态指示器【整个盖住】——实测命中测试四角全被挡，
       学生完全看不到姿态圆盘，本次新加的操控读数也一起看不见。
       （演示模式下 .hud-br 是 display:none，所以这个 bug 只在挑战模式暴露。）
       修法与右侧一致：左下也用 flex 竖列，推进剂与姿态指示器自下而上堆叠，
       不再与右侧列抢同一块地。演示模式下姿态区隐藏，竖列自动收缩。 */
    var lcol = el('div', 'hud-lcol', root2);

    /* ---- 竖列上格：姿态指示器（挑战模式常驻，演示模式隐藏）------------ */
    this.attBox = el('div', 'hud-br', lcol);
    this.att = new Attitude(this.attBox);

    /* ---- 竖列下格：推进剂 ---------------------------------------------- */
    var bl = el('div', 'hud-bl', lcol);
    el('div', 'prop-title', bl, '推进剂');
    this.propWrap = el('div', 'prop-wrap', bl);
    this.propBars = {};
    ['booster', 's1', 's2', 's3'].forEach(function (id) {
      var row = el('div', 'prop-row', this.propWrap);
      var nm = el('span', 'prop-name', row, id);
      var bar = el('div', 'prop-bar', row);
      var fill = el('i', 'prop-fill', bar);
      var pc = el('span', 'prop-pct', row, '100%');
      this.propBars[id] = { row: row, fill: fill, pct: pc, name: nm };
    }, this);
    this.burnEl = el('div', 'prop-burn', bl, '');

    /* ---- 右下：姿态指示器已移入左下竖列（见上方 hud-lcol）-------------- */

    /* ---- 右侧栏：Δv 预算 / 轨道根数 / 曲线 / 核验 ----------------------- */
    var side = el('div', 'hud-side', rcol);
    this.side = side;

    var dvBox = el('div', 'panel', side);
    el('div', 'panel-h', dvBox, 'Δv 预算（m/s）');
    this.dvBody = el('div', 'panel-b dv-body', dvBox);

    var orbBox = el('div', 'panel', side);
    el('div', 'panel-h', orbBox, '轨道根数');
    this.orbBody = el('div', 'panel-b orb-body', orbBox);
    this.orbHint = el('div', 'panel-hint', orbBox, '');

    var curBox = el('div', 'panel', side);
    el('div', 'panel-h', curBox, '实时曲线');
    this.curve = document.createElement('canvas');
    this.curve.className = 'curve';
    curBox.appendChild(this.curve);
    this.cctx = this.curve.getContext('2d');
    this.samples = [];             // {T, q, g, v, h}

    var chkBox = el('div', 'panel', side);
    el('div', 'panel-h', chkBox, '数据核验');
    this.chkBody = el('div', 'panel-b chk-body', chkBox);

    /* ---- 底部中：字幕 / 提示条 ------------------------------------------
       两者装进同一根 flex 竖列（.hud-bc）。原来各自 absolute，bottom 分别是
       150 / 196 px 两个互不相干的数，横向又用 left:50% + 百分比 max-width，
       1024 宽下字幕会压到左下推进剂和右侧面板上（实测各重叠 68×78 px）。
       现在整列左右边界由 --gutter / --col-w 算出，任何宽度都不越界，
       且两条消息按 flex 竖排，永远不会互相盖。                            */
    var bc = el('div', 'hud-bc', root2);
    this.subtitle = el('div', 'hud-sub', bc, '');
    this.hintBar = el('div', 'hud-hint', bc, '');

    /* ---- 顶部告警条 ----------------------------------------------------- */
    this.alert = el('div', 'hud-alert', root2, '');
    this.alert.style.display = 'none';

    /* ---- 中央事件大字 --------------------------------------------------- */
    this.center = el('div', 'hud-center', root2, '');
    this._centerUntil = 0;

    /* ---- 底部：时间线（两模式都有，挑战模式也可回溯）--------------------
       外层 .hud-timeline 负责底部定位（bottom:52px），内层 .tl 给 timeline.js
       填充内容。timeline.js 在构造时做 `el.className='tl'`（index.html
       那一栏改动时忘了保留 .hud-timeline 类），所以内外必须分开，否则
       时间线会跑回屏幕顶部 —— 上一轮的 FIX-003 视觉验证没量可见位置，
       这个问题一直藏到这次 UX 复核才暴露。                                  */
    this.tlMount = el('div', 'hud-timeline', root2);
    this.tlInner = el('div', 'tl', this.tlMount);

    /* ---- 成就卡片 -------------------------------------------------------- */
    this.badges = el('div', 'hud-badges', root2);

    this.rate = new A11y.RateLimiter(10);
    this._lastEv = 0;
    this.setMode(this.mode);
  }

  /** 演示/挑战两模式的 HUD 差异（modes.md §4.3） */
  Hud.prototype.setMode = function (mode) {
    this.mode = mode;
    var demo = mode === 'demo';
    this.el.classList.toggle('is-demo', demo);
    this.el.classList.toggle('is-challenge', !demo);
    // 姿态指示器：演示模式隐藏（教师不需要看姿态）
    this.attBox.style.display = demo ? 'none' : '';
    // 告警条：演示模式禁用失败判定，自然也不显示
    if (demo) { this.alert.style.display = 'none'; }
  };

  /** 演示模式数据层 L0/L1/L2/L3（modes.md §1.3） */
  Hud.prototype.setDataLayer = function (L) {
    this.dataLayer = L;
    this.el.setAttribute('data-layer', 'L' + L);
    this.gEl.el.style.display = L >= 1 ? '' : 'none';
    this.qEl.el.style.display = L >= 1 ? '' : 'none';
    this.aEl.el.style.display = L >= 2 ? '' : 'none';
    this.propWrap.style.display = L >= 1 ? '' : 'none';
    this.side.style.display = L >= 2 ? '' : 'none';
  };

  Hud.prototype.setTheme = function (name, fontScale) {
    this.el.style.setProperty('--hud-scale', (fontScale || 1).toFixed(2));
    this.el.classList.toggle('is-light', name === 'light');
  };

  /* ---- 文字类（不受 10 Hz 限制，事件驱动）------------------------------- */

  Hud.prototype.setSubtitle = function (txt) { this.subtitle.textContent = txt || ''; };
  Hud.prototype.setHint = function (txt) { this.hintBar.textContent = txt || ''; };

  Hud.prototype.setAlert = function (sev, txt) {
    if (!txt) { this.alert.style.display = 'none'; return; }
    var color = 'var(--sev-' + (sev || 'caution') + ')';
    this.alert.innerHTML =
      '<svg class="ro-mark" viewBox="0 0 20 20" aria-hidden="true">' +
      A11y.shapeSvg(sev || 'caution', 20, color) + '</svg><span>' + txt + '</span>';
    this.alert.style.display = '';
  };

  /** 中央事件大字（1.5 s 淡出，modes.md §4.1） */
  Hud.prototype.flashEvent = function (name, nowMs) {
    this.center.textContent = name;
    this.center.classList.remove('is-show');
    // 强制重排以重启动画
    void this.center.offsetWidth;
    this.center.classList.add('is-show');
    this._centerUntil = (nowMs || 0) + 1500;
  };

  Hud.prototype.showBadge = function (title, desc) {
    var b = el('div', 'badge', this.badges);
    el('div', 'badge-t', b, title);
    el('div', 'badge-d', b, desc || '');
    setTimeout(function () {
      b.classList.add('is-out');
      setTimeout(function () { if (b.parentNode) { b.parentNode.removeChild(b); } }, 600);
    }, 4200);
  };

  /* ---- 曲线（Canvas，asset-spec §4.4 ORB_CURVES）------------------------ */
  Hud.prototype.pushSample = function (sim) {
    var T = sim.missionTime();
    var s = this.samples;
    if (s.length && T - s[s.length - 1].T < 0.5) { return; }
    s.push({ T: T, q: sim.tele.q, g: sim.tele.gForce, v: sim.tele.v, h: sim.tele.h });
    if (s.length > 3000) { s.shift(); }
  };

  Hud.prototype.trimSamples = function (T) {
    while (this.samples.length && this.samples[this.samples.length - 1].T > T) {
      this.samples.pop();
    }
  };

  Hud.prototype.drawCurves = function (theme) {
    var cv = this.curve, g = this.cctx, s = this.samples;
    var w = cv.clientWidth || 260, h = cv.clientHeight || 90;
    var dpr = (window.devicePixelRatio || 1);
    if (dpr > 2) { dpr = 2; }
    if (cv.width !== Math.round(w * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (s.length < 2) { return; }

    var dark = theme !== 'light';
    var qMax = 1, gMax = 1, tMax = s[s.length - 1].T || 1;
    for (var i = 0; i < s.length; i++) {
      if (s[i].q > qMax) { qMax = s[i].q; }
      if (s[i].g > gMax) { gMax = s[i].g; }
    }
    function plot(key, max, color) {
      g.beginPath();
      for (var j = 0; j < s.length; j++) {
        var x = (s[j].T / tMax) * (w - 2) + 1;
        var y = h - 3 - (s[j][key] / max) * (h - 8);
        if (j === 0) { g.moveTo(x, y); } else { g.lineTo(x, y); }
      }
      g.strokeStyle = color; g.lineWidth = 2; g.stroke();
    }
    // 网格
    g.strokeStyle = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)';
    g.lineWidth = 1;
    for (var k = 1; k < 4; k++) {
      var y2 = h * k / 4;
      g.beginPath(); g.moveTo(0, y2); g.lineTo(w, y2); g.stroke();
    }
    plot('q', qMax, dark ? '#ffb54a' : '#d98200');   // 动压
    plot('g', gMax, dark ? '#6fd3ff' : '#12608f');   // 过载
    g.fillStyle = dark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)';
    g.font = '10px ui-monospace, monospace';
    g.fillText('q ' + (qMax / 1000).toFixed(0) + ' kPa', 4, 11);
    g.fillText('a ' + gMax.toFixed(1) + ' g', 4, 22);
  };

  /* ---- 每帧更新 --------------------------------------------------------- */
  Hud.prototype.update = function (dt, sim, ext) {
    ext = ext || {};
    var t = sim.tele;
    var F = C.FAIL;

    // 时间与事件名（事件驱动，不受限频，但代价极低）
    this.timeEl.textContent = fmtT(sim.missionTime()) +
      (ext.warp && ext.warp !== 1 ? '  ×' + ext.warp : '');
    if (ext.eventName) { this.evEl.textContent = ext.eventName; }
    if (ext.nextText !== undefined) { this.nextEl.textContent = ext.nextText; }

    // 主数据：全部走 10 Hz + 300 ms 缓动
    this.vEl.update(dt, t.v / 1000);
    this.hEl.update(dt, t.h / 1000);
    this.gEl.update(dt, t.gForce, t.gForce / F.G_MAX);
    this.qEl.update(dt, t.q / 1000, t.q / F.Q_MAX);
    // 攻角严重度按【当前动压下的实际上限】归一，与失败判定共用同一口径
    // （C.alphaLimitAt）。真空（q < 1 kPa）时上限为 Infinity → 严重度 0，
    // 不会再出现"三级点火瞬间大屏突然全红"的假告警（S4）。
    this.aEl.update(dt, Math.abs(t.alpha) * C.RAD,
                    Math.abs(t.alpha) / C.alphaLimitAt(t.q, 1));

    if (!this.rate.tick(dt)) { return; }

    // 推进剂
    var props = sim.propellant();
    for (var i = 0; i < props.length; i++) {
      var p = props[i], b = this.propBars[p.id];
      if (!b) { continue; }
      b.fill.style.width = (Math.max(0, p.pct) * 100).toFixed(1) + '%';
      b.row.classList.toggle('is-active', !!p.active);
      b.row.classList.toggle('is-empty', p.remain <= 0);
      b.pct.textContent = (p.pct * 100).toFixed(0) + '%';
      b.name.textContent = p.name;
    }
    this.burnEl.textContent = '消耗 ' + (sim.tele.mdot).toFixed(1) + ' t/s' +
      '   质量 ' + (sim.tele.m / 1000).toFixed(1) + ' t';

    // 姿态
    if (this.mode !== 'demo') { this.att.update(dt, sim); }

    // Δv 预算（physics.md §9.1 恒等式的五项）
    var rows = [
      ['理想 Δv', t.dvIdeal], ['重力损失', t.dvGrav],
      ['气动损失', t.dvDrag], ['转向损失（教学口径）', t.dvSteerSelf],
      ['自转不对齐', t.dvRotAlign], ['当前速度', t.v],
      ['地球自转赠送', C.SITE.V_ROT]
    ];
    var html = '';
    for (var r = 0; r < rows.length; r++) {
      html += '<div class="dv-row"><span>' + rows[r][0] + '</span><b>' +
              rows[r][1].toFixed(0) + '</b></div>';
    }
    if (ext.showResidual) {
      html += '<div class="dv-row dv-res"><span>恒等式残差</span><b>' +
              t.residual.toExponential(2) + ' m/s</b></div>';
    }
    this.dvBody.innerHTML = html;

    // 轨道根数（教学核心：滑行段"近地点是负的"就靠这一块）
    var e2 = t.el;
    if (e2) {
      var hyp = e2.hyperbolic;
      this.orbBody.innerHTML =
        '<div class="orb-row"><span>近地点 h<sub>p</sub></span><b class="' +
          (e2.hp < 0 ? 'is-neg' : 'is-ok') + '">' + (e2.hp / 1000).toFixed(1) +
          ' km</b></div>' +
        '<div class="orb-row"><span>远地点 h<sub>a</sub></span><b>' +
          (isFinite(e2.ha) ? (e2.ha / 1000).toFixed(1) : '∞') + ' km</b></div>' +
        '<div class="orb-row"><span>半长轴 a</span><b>' +
          (hyp ? '—' : (e2.a / 1000).toFixed(1) + ' km') + '</b></div>' +
        '<div class="orb-row"><span>偏心率 e</span><b>' + e2.e.toFixed(5) + '</b></div>' +
        '<div class="orb-row"><span>周期 T</span><b>' +
          (isFinite(e2.T) ? (e2.T / 60).toFixed(2) + ' min' : '—') + '</b></div>' +
        '<div class="orb-row"><span>倾角 i</span><b>' +
          (e2.i * C.RAD).toFixed(1) + '°</b></div>';
      // sim.orbitOk 在 sim.js 构造时恒按目标轨道取到值，这里仍先判空再取字段：
      // 早期写法 `sim.orbitOk.successHp || 180e3` 在 orbitOk 为 null 的那一刻
      // 就抛 TypeError 了，|| 兜底根本轮不到执行。兜底值用 C.ORBIT_OK 的真实
      // 常量，不写死 180e3（与 score.js:63 同款写法）。
      var okHp = (sim.orbitOk && sim.orbitOk.successHp) || C.ORBIT_OK.successHp;
      this.orbHint.textContent = e2.hp < 0
        ? '近地点在地表以下 —— 它还没入轨'
        : (e2.hp >= okHp ? '已入轨' : '接近入轨');
      this.orbHint.className = 'panel-hint ' + (e2.hp < 0 ? 'is-neg' : 'is-ok');
    }

    // 核验面板（L3）
    this.chkBody.innerHTML =
      '<div class="chk-row"><span>起飞质量</span><b>2187 t</b></div>' +
      '<div class="chk-row"><span>起飞推力</span><b>26 250 kN（21×1250）</b></div>' +
      '<div class="chk-row"><span>推重比</span><b>1.224</b></div>' +
      '<div class="chk-row"><span>圆轨道速度</span><b>' +
        (Math.sqrt(C.MU / (C.R_REF + sim.veh.targetAlt))).toFixed(0) + ' m/s</b></div>' +
      '<div class="chk-row"><span>恒等式残差</span><b>' +
        t.residual.toExponential(1) + ' m/s</b></div>' +
      '<div class="chk-row chk-src">参数来源：公开 / 推导 / 近似 / 游戏 四类标签见' +
      ' docs/architecture/architecture.md §参数来源</div>';
  };

  return {
    Hud: Hud,
    Readout: Readout,
    Attitude: Attitude,
    fx: fx,
    fmtT: fmtT
  };
});
