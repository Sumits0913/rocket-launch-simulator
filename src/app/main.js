/* =============================================================================
 * main.js —— 装配与主循环
 * -----------------------------------------------------------------------------
 * 依据：docs/architecture/architecture.md §模块清单、adr-002、adr-003
 *
 * ── 一帧里发生的事（顺序不能乱）──────────────────────────────────────────────
 *   1) 算真实帧时间 dtWall（并夹到 100 ms，防止切标签页回来后一次跳几秒）
 *   2) 若未暂停：dtSim = dtWall × 倍速 → engine.advance(dtSim)
 *      （engine 内部按【固定步长累加器】消费，与帧率无关 → 可确定性重放）
 *   3) 采样拖尾与曲线（按仿真时间，不是按帧）
 *   4) 渲染：Canvas 背景/拖尾/尾焰 → SVG 箭体（CSS transform 对齐相机）
 *   5) HUD 更新（内部 10 Hz 限频 + 300 ms 缓动）
 *   6) 时间线推进（演示模式常驻）
 *
 * ── 为什么暂停 / 跳转都要 flushAccumulator() ──────────────────────────────────
 *   累加器里可能攒着不到一个步长的余量。暂停时不该把它留到恢复后突然兑现
 *   （会出现"一按暂停火箭还往前蹦一下"），跳转时更是必须清零，否则新位置会
 *   叠加一段旧的余量，重放就不再逐位一致。
 * ========================================================================== */
(function (root) {
  'use strict';

  var RK = root.RK;
  var C = RK.Constants;
  var Sim = RK.Sim;
  var Replay = RK.Replay;
  var Config = RK.Config;
  var A11y = RK.A11y;
  var Input = RK.Input;
  var Timeline = RK.Timeline;
  var Render = RK.Render;
  var Hud = RK.Hud;
  var Modes = RK.Modes;
  var Score = RK.Score;
  var SvgRocket = RK.SvgRocket;

  var WARP_STEPS = [1, 2, 5, 10, 25, 50];

  function $(id) { return document.getElementById(id); }

  /* ---------------------------------------------------------------------------
   * App
   * ------------------------------------------------------------------------ */
  function App() {
    this.cfg = Config;
    this.director = new Modes.Director(Config);
    this.warpIdx = 0;
    this.paused = true;
    this.started = false;
    this.finished = false;
    this._seeking = false;
    this._lastWall = 0;
    this._tWall = 0;
    this._shakeI = 0;
    this._checkSeconds = 0;      // 核验面板停留时长（成就 A9）
    this._demoPlays = 0;

    this._initDom();
    this._newMission();
    this._bindUi();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  /* ---- DOM 与渲染器 ------------------------------------------------------- */
  App.prototype._initDom = function () {
    this.canvas = $('fx-canvas');
    this.renderer = new Render.Renderer(this.canvas);
    this.rocket = new SvgRocket.RocketView($('rocket-layer'));
    this.hud = new Hud.Hud($('hud-root'), {
      mode: this.director.mode, dataLayer: this.director.dataLayer
    });
    this.timeline = new Timeline.Timeline({
      mount: this.hud.tlInner,
      onSeek: this._onSeek.bind(this),
      onCommit: this._onSeekCommit.bind(this),
      onJump: this._onJump.bind(this)
    });
    this.input = new Input.Input({
      mode: this.director.mode,
      onCommand: this._onCommand.bind(this)
    });
    this.input.bind(window);
    this._applyTheme();
  };

  App.prototype._applyTheme = function () {
    var th = this.director.theme();
    var reduced = !!this.cfg.get('reducedMotion');
    var fs = this.cfg.get('fontScale') || 1;
    document.documentElement.setAttribute('data-theme', th);
    document.documentElement.style.setProperty('--hud-scale', String(fs));
    this.renderer.setTheme(th, reduced);
    this.hud.setTheme(th, fs);
    // 演示模式不提供深色开关（用户决策 #1）：直接把那个开关禁用并给出原因
    var darkBtn = $('set-theme');
    if (darkBtn) {
      var demo = this.director.mode === 'demo';
      darkBtn.disabled = demo;
      darkBtn.title = demo ? '演示模式强制浅色（投影可读性优先），深色仅在挑战模式可用' : '';
    }
  };

  /* ---- 演示模式下"死按钮"的禁用态 -------------------------------------
     姿态 ▲▼ / 节流 −＋ / 三级点火 / 三级关机 这 6 个按钮在演示模式下是死的：
     input.js:74 会把输入直接丢弃。但此前它们仍是白底可点、opacity=1、
     cursor=pointer —— 学生上台乱按、教师讲解时误触，点下去毫无反应，
     而且不解释原因，用户只会认为是程序坏了。
     这里按模式真正 disable 掉，并把原因写进 title（鼠标悬停可见）。 */
  /* ⚠ 按钮 title 的真正来源在这里，不是 index.html —— _syncFlyButtons() 每帧
   * 用这张表覆盖 DOM 上的 title 属性，所以改 HTML 是无效的，必须改这里。
   * ▲▼ 的措辞不能只写"抬头/低头"：本项目 θ 从当地水平量起（90°=垂直），
   * 入轨需要把速度倒向水平，即 θ 往下减 —— 对应的是 ▼。
   * 中学生看到「▲」会以为"让火箭往上飞就更接近太空"，正好按反。 */
  var FLY_TIPS = {
    'btn-up': '抬高弹道（↑ / W）—— 爬得更陡、飞得更高，但水平速度攒得慢',
    'btn-down': '压低弹道（↓ / S）—— 把速度倒向水平。入轨靠水平速度，转弯主要按这个',
    'btn-thr-down': '减小油门（Q）—— 空气最稠密时降推力，可减小过载与气动载荷',
    'btn-thr-up': '加大油门（E）—— 空气变稀薄后恢复满推力',
    'btn-ignite': '三级点火', 'btn-cutoff': '三级关机（空格）'
  };
  var FLY_LOCKED = '演示模式已锁定操作：避免讲解时误触改变标定弹道。' +
                   '姿态与点火只在「挑战模式」下可用 —— 到设置里切换即可。';

  App.prototype._syncFlyButtons = function () {
    var demo = this.director.mode === 'demo';
    var grp = $('grp-fly');
    if (grp) { grp.classList.toggle('is-off', demo); }
    Object.keys(FLY_TIPS).forEach(function (id) {
      var b = $(id);
      if (!b) { return; }
      b.disabled = demo;
      b.title = demo ? FLY_LOCKED : FLY_TIPS[id];
    });
  };

  /**
   * 播放按钮的状态反馈。
   * 之前按钮文案恒为"▶ 播放"、背景色也不变 —— 用户点下去看到画面没动，
   * 无法区分"没点上"和"程序坏了"，这是首次用户流失的头号原因。
   * 现在：待发射=▶ 播放（带呼吸提示），播放中=⏸ 暂停，中途暂停=▶ 继续。
   * 只在文案真的变化时才写 DOM，避免每帧触发布局。
   */
  App.prototype._updatePlayBtn = function () {
    var playing = !this.paused && this.started && !this.finished;
    var txt = playing ? '⏸ 暂停'
            : (this.started && !this.finished ? '▶ 继续' : '▶ 播放');
    if (txt === this._playTxt) { return; }
    this._playTxt = txt;
    var b = $('btn-play');
    if (!b) { return; }
    b.textContent = txt;
    b.title = playing ? '暂停（空格）' : '播放（空格）';
    b.classList.toggle('is-cta', !this.started);
  };

  /** 提示条：只在文字真的变化时才写 DOM。
      相机切换等一次性提示靠 _hintHold 短暂占用提示条，不会被下一帧冲掉。 */
  App.prototype._setHint = function (txt) {
    txt = txt || '';
    if (txt === this._hintTxt) { return; }
    this._hintTxt = txt;
    this.hud.setHint(txt);
  };

  /* ---- 开一个新任务 ------------------------------------------------------- */
  App.prototype._newMission = function () {
    var opts = this.director.buildOpts();
    this.opts = opts;
    this.engine = new Replay.Engine(opts);
    var sim = this.engine.sim;
    var self = this;

    sim.onEvent = function (e, s) { self._onSimEvent(e, s); };
    sim.onFailure = function (f, s) { self._onFailure(f, s); };

    this.renderer.clearTrail();
    this.hud.samples.length = 0;
    this.input.setEngine(this.engine);
    this.input.setMode(this.director.mode);
    this.hud.setMode(this.director.mode);
    this.hud.setDataLayer(this.director.mode === 'demo' ? this.director.dataLayer : 3);
    this.hud.setSubtitle(this.director.openingLine());
    this.hud.el.classList.toggle('is-cutaway', !!this.director.cutaway);
    this.warpIdx = 0;
    this.paused = true;
    this.started = false;
    this.finished = false;
    this._timelineReady = false;
    this._lastEventName = '待发射';
    this._playTxt = null;      // 强制下一帧刷新播放按钮文案
    this._hintTxt = null;      // 强制下一帧刷新提示条
    this._hintHold = 0;
    this.hud.setAlert(null);
    this._hide('result-panel');
    this._hide('coast-panel');
    this._syncFlyButtons();
    // 模式切换会连带改变主题（演示强制浅色 / 挑战可用深色），设置面板里的
    // 「模式」分段控件与「主题」下拉必须跟着回到与当前状态一致，
    // 否则面板显示的和实际在跑的不是一回事。
    this._syncSettings();

    // 标称弹道（事件刻度）放在下一帧算：首屏先出来，别让教师等
    setTimeout(function () {
      var nom = Timeline.nominal(opts);
      self.timeline.setEvents(nom);
      // 这里【不要】silent：这次 setT 兼做"开局 seek 到起飞零点（T+00:00）"，
      // 必须真正把 sim 拽回待发姿态。它只跑一次，不是每帧同步，没有副作用。
      self.timeline.setT(0, false);
      self._timelineReady = true;
    }, 0);
  };

  App.prototype._hide = function (id) {
    var e = $(id);
    if (e) { e.style.display = 'none'; }
  };
  App.prototype._show = function (id) {
    var e = $(id);
    if (e) { e.style.display = ''; }
  };

  /* ---- 仿真事件 ----------------------------------------------------------- */
  App.prototype._onSimEvent = function (e, sim) {
    if (this._seeking) { return; }               // 重放中：只更新数据，不做导演动作
    var act = this.director.onEvent(e, sim);
    this._lastEventName = e.name;
    this.hud.flashEvent(e.name, performance.now());
    this.hud.setSubtitle(act.subtitle || '');
    if (act.warp) {
      var i = WARP_STEPS.indexOf(act.warp);
      if (i >= 0) { this.warpIdx = i; }
    }
    if (act.pause) {
      this.paused = true;
      sim.flushAccumulator();
      if (act.coastScript) {
        this._showCoastPanel(act.coastScript, sim);
      }
    }
  };

  App.prototype._showCoastPanel = function (script, sim) {
    var box = $('coast-body');
    if (!box) { return; }
    var el = sim.tele.el;
    var hp = el ? (el.hp / 1000).toFixed(0) : '—';
    var ha = el && isFinite(el.ha) ? (el.ha / 1000).toFixed(0) : '∞';
    box.innerHTML =
      '<p class="coast-key">近地点 <b class="is-neg">' + hp + ' km</b>' +
      '　远地点 <b>' + ha + ' km</b></p>' +
      '<p class="coast-note">近地点是负的 → 这个椭圆的最低点在地表以下 → ' +
      '<b>它还没入轨</b></p>' +
      '<ol class="coast-list">' + script.map(function (s) {
        return '<li>' + s + '</li>';
      }).join('') + '</ol>';
    this._show('coast-panel');
  };

  App.prototype._onFailure = function (f, sim) {
    if (this._seeking) { return; }
    var info = this.director.onFailure(f, sim);
    this.paused = true;
    sim.flushAccumulator();
    var box = $('result-body');
    if (box) {
      box.innerHTML = '<h3 class="res-fail">' + info.title + '</h3><p>' + info.text + '</p>';
      this._show('result-panel');
    }
  };

  /* ---- 任务结束（入轨 + 船箭分离）----------------------------------------- */
  App.prototype._finish = function () {
    if (this.finished) { return; }
    this.finished = true;
    this.paused = true;
    var sim = this.engine.sim;
    var el = sim.orbitEl || sim.tele.el;
    var box = $('result-body');
    if (!box) { return; }

    var html = '<h3>船箭分离 · 任务完成</h3>';
    if (el) {
      html += '<p>近地点 <b>' + (el.hp / 1000).toFixed(1) + ' km</b>　远地点 <b>' +
        (isFinite(el.ha) ? (el.ha / 1000).toFixed(1) : '∞') + ' km</b>　偏心率 <b>' +
        el.e.toFixed(5) + '</b>　周期 <b>' + (el.T / 60).toFixed(2) + ' min</b></p>';
    }
    html += '<p>三级推进剂消耗 <b>' + (sim.s3PropUsed / 1000).toFixed(2) + ' t</b>' +
            '　最大动压 <b>' + (sim.peakQ / 1000).toFixed(1) + ' kPa</b>' +
            '　最大过载 <b>' + sim.peakG.toFixed(2) + ' g</b></p>' +
            '<p class="res-note">' + this.director.openingLine() + '</p>';

    if (this.director.mode !== 'demo') {
      var res = Score.evaluate(sim, {
        targetAlt: sim.veh.targetAlt, s3BudgetKg: sim.target.s3Budget
      });
      html += '<div class="res-score"><span class="res-grade">评级 ' + res.grade +
              '</span><span class="res-total">' + res.total.toFixed(1) + ' / 100</span></div>' +
              '<div class="res-parts">' +
              '入轨精度 ' + res.parts.precision.toFixed(1) + ' / 40　' +
              'Δv 效率 ' + res.parts.dvEff.toFixed(1) + ' / 30　' +
              'Max-Q ' + res.parts.maxQ.toFixed(1) + ' / 15　' +
              '过载 ' + res.parts.gForce.toFixed(1) + ' / 15</div>' +
              '<p class="res-note">' + res.gradeText + '</p>';
      var sub = Score.submit(this.director.difficulty, this.director.targetKm,
                             res.total, res.grade);
      if (sub.isNew) { html += '<p class="res-new">🏅 新的最佳成绩！</p>'; }

      this.director._bumpFlights();
      var got = Score.check({
        result: res, sim: sim, targetAlt: this.director.targetKm * 1000,
        manual: !!sim.ctl.manual && !sim.ctl.apEnabled,   // A7：全手动完成入轨
        demoPlays: this._demoPlays, checkMinutes: this._checkSeconds / 60
      });
      var self = this;
      got.forEach(function (a) { self.hud.showBadge('成就解锁 · ' + a.name, a.desc); });
    } else {
      this._demoPlays += 1;
      Score.check({ result: null, demoPlays: this._demoPlays,
                    checkMinutes: this._checkSeconds / 60 });
    }
    box.innerHTML = html;
    this._show('result-panel');
  };

  /* ---- 指令（键盘 / 按钮）------------------------------------------------- */
  App.prototype._onCommand = function (cmd, payload) {
    var sim = this.engine.sim;
    switch (cmd) {
      case 'pause':
        this.paused = !this.paused;
        sim.flushAccumulator();
        this._hide('coast-panel');
        if (!this.started && !this.paused) { this.started = true; }
        break;
      case 'primary':
        // 空格：演示模式 = 播放/暂停；挑战模式 = 上下文主操作（点火/关机）
        var act = this.input.primary(sim);
        if (act === 'pause') {
          this.paused = !this.paused;
          sim.flushAccumulator();
          this._hide('coast-panel');
        }
        this.started = true;
        break;
      case 'warp':
        var i = WARP_STEPS.indexOf(payload);
        if (i >= 0) { this.warpIdx = i; }
        break;
      case 'restart':
        this._newMission();
        break;
      case 'camera':
        var m = this.renderer.mode === 'follow' ? 'global'
              : (this.renderer.mode === 'global' ? 'orbit' : 'follow');
        this.renderer.setCameraMode(m);
        // 一次性提示：短暂占用提示条 2.5 s，否则会被下一帧的常态提示冲掉
        this._hintOverride = '相机：' + (m === 'follow' ? '跟随'
                           : m === 'global' ? '全景' : '轨道俯视');
        this._hintHold = 2.5;
        break;
      case 'dataLayer':
        if (this.director.mode === 'demo') {
          this.director.dataLayer = (this.director.dataLayer + 1) % 4;
          this.cfg.set('dataLayer', this.director.dataLayer);
          this.hud.setDataLayer(this.director.dataLayer);
        }
        break;
      case 'panel':
        this._checkSeconds += 0;    // 切到核验面板后由 _tickCheck 计时
        var side = this.hud.side;
        side.style.display = (side.style.display === 'none') ? '' : 'none';
        break;
      case 'prev':
        this._jumpNode(-1);
        break;
      case 'next':
        this._jumpNode(+1);
        break;
      case 'menu':
        this._toggle('settings-panel');
        break;
      case 'help':
        this._toggle('help-panel');
        break;
      case 'manual':
        this.input.tap('manual', !sim.ctl.apEnabled);
        break;
      default:
        break;
    }
  };

  App.prototype._toggle = function (id) {
    var e = $(id);
    if (!e) { return; }
    e.style.display = (e.style.display === 'none' || e.style.display === '') ? 'block' : 'none';
  };

  /** 上一 / 下一个事件节点（演示模式常用） */
  App.prototype._jumpNode = function (dir) {
    var nom = Timeline.nominal(this.opts);
    var T = this.engine.missionTime();
    var target = null;
    if (dir > 0) {
      for (var i = 0; i < nom.events.length; i++) {
        if (nom.events[i].T > T + 0.5) { target = nom.events[i].T; break; }
      }
    } else {
      for (var j = nom.events.length - 1; j >= 0; j--) {
        if (nom.events[j].T < T - 0.5) { target = nom.events[j].T; break; }
      }
      if (target === null) { target = 0; }
    }
    if (target === null) { target = nom.duration; }
    this._seekTo(target, true);
  };

  App.prototype._onJump = function (T) { this._seekTo(T, true); };
  App.prototype._onSeek = function (T) { this._seekTo(T, false); };
  App.prototype._onSeekCommit = function (T) { this._seekTo(T, true); };

  /** 回溯到指定任务时间（用户决策 #3 的落地点） */
  App.prototype._seekTo = function (T, commit) {
    var sim = this.engine.sim;
    var internal = this.engine.toInternal(T);
    this._seeking = true;
    var r = this.engine.seek(internal);          // 实测：平均 0.034 ms，最坏 2.6 ms
    this._seeking = false;
    this.renderer.trimTrail(sim.t);
    this.hud.trimSamples(sim.missionTime());
    sim.flushAccumulator();
    this.finished = (sim.status === 'complete');
    if (this.finished) { this._hide('result-panel'); }
    if (commit) {
      this.paused = true;
      this._hide('coast-panel');
      if (this._lastSeek) { this._lastSeek.steps = r.steps; }
    }
    this._lastSeek = r;
  };

  /* ---- 底部按钮 / 设置面板 ----------------------------------------------- */
  App.prototype._bindUi = function () {
    var self = this;

    function on(id, ev, fn) {
      var e = $(id);
      if (e) { e.addEventListener(ev, fn); }
    }

    on('btn-play', 'click', function () { self._onCommand('pause'); });
    on('btn-restart', 'click', function () { self._onCommand('restart'); });
    on('btn-camera', 'click', function () { self._onCommand('camera'); });
    on('btn-warp', 'click', function () {
      self.warpIdx = (self.warpIdx + 1) % WARP_STEPS.length;
      self._updateWarpBtn();
    });
    on('btn-settings', 'click', function () { self._toggle('settings-panel'); });
    on('btn-help', 'click', function () { self._toggle('help-panel'); });
    on('btn-close-result', 'click', function () { self._hide('result-panel'); });
    on('btn-replay', 'click', function () {
      self._hide('result-panel');
      self._onCommand('restart');
    });
    on('btn-close-settings', 'click', function () { self._hide('settings-panel'); });
    on('btn-close-help', 'click', function () { self._hide('help-panel'); });
    on('btn-resume-coast', 'click', function () {
      self._hide('coast-panel');
      self.paused = false;
      self.engine.sim.flushAccumulator();
    });

    // ---- 设置项 ------------------------------------------------------------
    // 模式用分段控件：点一下直接切，省掉"展开下拉 → 选选项"两步。
    // 切换演示 / 挑战是除播放之外最高频的操作，不该藏在 select 里。
    var segMode = $('set-mode');
    if (segMode) {
      segMode.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('.seg-btn') : null;
        if (!btn) { return; }
        var v = btn.getAttribute('data-value');
        if (v === self.director.mode) { return; }
        self.cfg.set('mode', v);
        self.director.mode = v;
        self._applyTheme();
        self._newMission();
      });
    }
    on('set-difficulty', 'change', function (e) {
      self.cfg.set('difficulty', e.target.value);
      self.director.difficulty = e.target.value;
      self._newMission();
    });
    on('set-target', 'change', function (e) {
      self.cfg.set('targetAlt', parseInt(e.target.value, 10));
      self.director.targetKm = parseInt(e.target.value, 10);
      self._newMission();
    });
    /* 载荷不再是可选项：26 t 是唯一标定过的构型（用户决策 #5），
     * 14 t / 70 t 的弹道从未标定（远地点冲高 / 轨道在地心以下），
     * 载荷下拉框及其 change 处理器已于 2026-09-03 一并删除。
     * 载荷现在由 modes.js 的 Director.payloadT 直接给出，不进用户设置。 */
    on('set-theme', 'change', function (e) {
      self.cfg.set('theme', e.target.value);
      self._applyTheme();
    });
    on('set-cutaway', 'change', function (e) {
      self.cfg.set('cutaway', e.target.checked);
      self.director.cutaway = e.target.checked;
      self.hud.el.classList.toggle('is-cutaway', e.target.checked);
    });
    on('set-coast', 'change', function (e) {
      self.cfg.set('coastAutoPause', e.target.checked);
      self.director.coastAutoPause = e.target.checked;
    });
    on('set-guide', 'change', function (e) {
      self.cfg.set('guideStage', e.target.value);
    });
    on('set-motion', 'change', function (e) {
      self.cfg.set('reducedMotion', e.target.checked);
      self._applyTheme();
    });
    on('set-font', 'change', function (e) {
      self.cfg.set('fontScale', parseFloat(e.target.value));
      self._applyTheme();
    });
    on('set-shapes', 'change', function (e) {
      self.cfg.set('severityShapes', e.target.checked);
      document.documentElement.classList.toggle('no-shapes', !e.target.checked);
    });
    on('set-residual', 'change', function (e) {
      self.cfg.set('showResidual', e.target.checked);
    });
    on('set-manual-cutoff', 'change', function (e) {
      self.cfg.set('manualCutoff3', e.target.checked);
      self._newMission();
    });

    // 触屏 / 鼠标的姿态与节流按钮（modes.md §3.3）
    [['btn-up', 'pitch', 1], ['btn-down', 'pitch', -1]].forEach(function (t) {
      var b = $(t[0]);
      if (!b) { return; }
      ['pointerdown', 'pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) {
        b.addEventListener(ev, function (e) {
          var v = (ev === 'pointerdown') ? t[2] : 0;
          self.input.tap('pitch', v);
          e.preventDefault();
        });
      });
    });
    on('btn-thr-down', 'click', function () {
      self.input.tap('throttle', Math.max(C.THROTTLE_MIN,
        self.engine.sim.ctl.throttle - C.THROTTLE_STEP));
    });
    on('btn-thr-up', 'click', function () {
      self.input.tap('throttle', Math.min(C.THROTTLE_MAX,
        self.engine.sim.ctl.throttle + C.THROTTLE_STEP));
    });
    on('btn-cutoff', 'click', function () { self.input.tap('cutoff3', 1); });
    on('btn-ignite', 'click', function () { self.input.tap('ignite3', 1); });

    window.addEventListener('resize', function () {
      self.renderer.resize();
    });

    self._syncSettings();
  };

  /** 把设置面板的控件初值同步成存档里的值（否则界面与设置不一致） */
  App.prototype._syncSettings = function () {
    function val(id, v) { var e = $(id); if (e) { e.value = String(v); } }
    function chk(id, v) { var e = $(id); if (e) { e.checked = !!v; } }
    function seg(id, v) {                       // 分段控件：给命中的按钮加选中态
      var box = $(id);
      if (!box) { return; }
      var bs = box.querySelectorAll('.seg-btn');
      for (var i = 0; i < bs.length; i++) {
        bs[i].setAttribute('aria-pressed',
          bs[i].getAttribute('data-value') === String(v) ? 'true' : 'false');
      }
    }
    seg('set-mode', this.cfg.get('mode'));
    val('set-difficulty', this.cfg.get('difficulty'));
    val('set-target', this.cfg.get('targetAlt'));
    // 载荷没有对应的控件：固定 26 t，设置面板里只做静态文本展示
    val('set-theme', this.cfg.effectiveTheme(this.director.mode));
    val('set-guide', this.cfg.get('guideStage'));
    val('set-font', this.cfg.get('fontScale'));
    chk('set-cutaway', this.cfg.get('cutaway'));
    chk('set-coast', this.cfg.get('coastAutoPause'));
    chk('set-motion', this.cfg.get('reducedMotion'));
    chk('set-shapes', this.cfg.get('severityShapes'));
    chk('set-residual', this.cfg.get('showResidual'));
    chk('set-manual-cutoff', this.cfg.get('manualCutoff3'));
  };

  /* ---------------------------------------------------------------------------
   * 按住态同步（↑↓ 姿态 / QE 节流）
   * 浏览器只在【鼠标按住】时给按钮加 :active，键盘按住不会。而本项目的主场景
   * 是学生在讲台电脑前用键盘操作，所以必须把 input.held 同步成 .is-held 类，
   * 否则按住 ↑ 三秒按钮纹丝不动，学生无法判断输入有没有被接收。
   * 只在状态翻转时动 DOM —— 每帧无条件 classList.toggle 会白白触发布局。
   * ------------------------------------------------------------------------ */
  App.prototype._updateHeldBtns = function () {
    var h = this.input.held;
    if (!h) { return; }
    hold1('btn-up', h.up);
    hold1('btn-down', h.down);
    hold1('btn-thr-up', h.throttleUp);
    hold1('btn-thr-down', h.throttleDown);
  };

  function hold1(id, on) {
    var e = $(id);
    if (!e) { return; }
    on = !!on;
    if (on === e._held) { return; }
    e._held = on;
    e.classList.toggle('is-held', on);
  }

  App.prototype._updateWarpBtn = function () {
    var b = $('btn-warp');
    if (b) { b.textContent = '×' + WARP_STEPS[this.warpIdx]; }
  };

  /* ---- 主循环 ------------------------------------------------------------- */
  App.prototype._loop = function (nowMs) {
    requestAnimationFrame(this._loop);
    var dtWall = this._lastWall ? (nowMs - this._lastWall) / 1000 : 0.016;
    this._lastWall = nowMs;
    if (!(dtWall > 0)) { dtWall = 0.016; }
    if (dtWall > 0.1) { dtWall = 0.1; }        // 切标签页回来不要一次跳几秒
    this._tWall += dtWall;

    var sim = this.engine.sim;
    var warp = WARP_STEPS[this.warpIdx];

    if (!this.paused && !this.finished && this.started) {
      var dtSim = dtWall * warp;
      this.engine.advance(dtSim);
      this.renderer.sampleTrail(sim);
      this.hud.pushSample(sim);
      if (sim.status === 'complete') { this._finish(); }
    }

    // 抖动强度：一级工作时最强，随动压衰减（前庭安全的"强度"输入）
    var inten = 0;
    if (sim.burning.s1 && sim.tele.h < 20000) { inten = Math.min(1, sim.tele.q / 30e3); }
    else if (sim.burning.s2 || sim.burning.s3) { inten = 0.25; }

    this.renderer.draw(sim, { tWall: this._tWall, intensity: inten });

    // SVG 箭体：用 CSS transform 摆到相机算出的位置（与 Canvas 共享同一个相机）
    var tr = this.renderer.rocketTransform(sim);
    this.rocket.el.style.transform =
      'translate(' + tr.x.toFixed(1) + 'px,' + tr.y.toFixed(1) + 'px) ' +
      'rotate(' + tr.deg.toFixed(2) + 'deg) scale(' + tr.zoom.toFixed(4) + ')';
    this.rocket.update(sim, { cutaway: this.director.cutaway });
    this._applyZoomClass();

    // HUD
    this.hud.update(dtWall, sim, {
      warp: warp,
      eventName: this._lastEventName,
      nextText: this._nextText(sim),
      showResidual: !!this.cfg.get('showResidual')
    });
    if (this._hintHold > 0) {
      this._hintHold -= dtWall;
      this._setHint(this._hintOverride);
    } else if (this.director.mode !== 'demo') {
      this._setHint(this.director.hint(sim));
      var al = this.director.alert(sim);
      this.hud.setAlert(al ? al.sev : null, al ? al.text : null);
    } else {
      /* 演示模式下 modes.js 的 hint() 恒返回空串 —— 首屏等于没有任何
         "从哪开始"的指引，只有一句范围声明。这里按当前状态补一条：
         待发射 → 教他点哪；播放中 → 告诉他能暂停、能拖时间线回看。 */
      this._setHint(
        !this.started ? '点下方 ▶ 播放（或按 空格）开始发射'
        : this.paused ? '已暂停 · 按 空格 或 ▶ 继续'
        : this.finished ? '任务完成 · 按 ↻ 重来 再看一遍'
        : '发射中 · 空格暂停，拖底部时间线可回看任意时刻');
    }
    this.hud.drawCurves(this.director.theme());

    // 时间线（演示模式常驻；挑战模式也给，方便回溯复盘）
    if (this._timelineReady && !this.timeline.dragging) {
      var T = sim.missionTime();
      if (T + 5 > this.timeline.duration) { this.timeline.duration = T + 30; }
      this.timeline.setT(T, false, true);   // silent：只同步滑块，不触发 seek
    }
    this._updateWarpBtn();
    this._updatePlayBtn();
    this._updateHeldBtns();

    // 核验面板停留计时（成就 A9）
    if (this.hud.side && this.hud.side.style.display !== 'none' &&
        this.director.dataLayer >= 3) {
      this._checkSeconds += dtWall;
    }
  };

  /**
   * 缩放线宽分档（art-bible §5.3）
   * non-scaling-stroke 让线宽恒为 CSS px，好处是小尺度下线条不会细到消失，
   * 代价是放大讲解时线显得偏细。这里按相机 zoom 切 rk-z1/z2/z3 补偿线宽。
   * 带 ±16 px/m 滞回（总带宽 32 px/m），避免在阈值附近来回抖动。
   */
  App.prototype._applyZoomClass = function () {
    var z = this.renderer.cam.zoom;
    var cur = this._zoomLv || 1, H = 16, lv;
    if (cur === 3)      { lv = z < 60 - H ? (z < 25 - H ? 1 : 2) : 3; }
    else if (cur === 2) { lv = z >= 60 + H ? 3 : (z < 25 - H ? 1 : 2); }
    else                { lv = z >= 60 + H ? 3 : (z >= 25 + H ? 2 : 1); }
    if (lv === cur) { return; }
    var el = this.rocket.el;
    el.classList.remove('rk-z1', 'rk-z2', 'rk-z3');
    el.classList.add('rk-z' + lv);
    this._zoomLv = lv;
  };

  App.prototype._nextText = function (sim) {
    var nom = Timeline.nominal(this.opts);
    var T = sim.missionTime();
    for (var i = 0; i < nom.events.length; i++) {
      if (nom.events[i].T > T) {
        var dt = nom.events[i].T - T;
        return '下一节点：' + nom.events[i].name + '　T−' + dt.toFixed(0) + ' s';
      }
    }
    return '';
  };

  /* ---- 启动 --------------------------------------------------------------- */
  function boot() {
    root.RK.app = new App();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  RK.App = App;
})(typeof globalThis !== 'undefined' ? globalThis : this);
