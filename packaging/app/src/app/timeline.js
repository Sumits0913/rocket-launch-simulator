/* =============================================================================
 * timeline.js —— 任务事件时间线（任意拖拽回溯）
 * -----------------------------------------------------------------------------
 * 依据：用户决策 #3、design/gdd/modes.md §4.1、design/art/asset-spec.md §5.2
 *
 * ── 时间线上的节点从哪来 ────────────────────────────────────────────────────
 *   用一条"标称弹道"预先算出来：开局时用【无输入】的完整弹道跑一遍（确定性重放
 *   的裸重放，实测 7~11 ms），把 13 个事件的 T+ 时刻取下来当刻度。
 *   为什么敢这么干：演示模式本来就是无输入的（玩家输入被锁），挑战模式的自动
 *   驾驶基线也走同一条弹道，所以标称时刻与实际时刻几乎一致；即使玩家飞歪了，
 *   刻度只是"参考位置"，实际事件点会实时落在它该在的地方。
 *
 * ── 拖拽为什么不用防抖 / 节流（adr-002 的性能结论） ─────────────────────────
 *   拖动时每帧调一次 engine.seek()。seek 从最近的检查点（每 5 s 一个）重放，
 *   实测 200 次随机拖拽：平均 0.034 ms、最坏 2.587 ms，远小于 60 fps 的
 *   16.7 ms 单帧预算。所以【不需要防抖，也不需要节流】，拖到哪算到哪，手感是
 *   即时的。真要保险，本模块只在 pointermove 里调一次，天然 ≤ 刷新率。
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var isNode = (typeof require === 'function' && typeof module === 'object');
  var Sim = isNode ? require('../core/sim.js') : root.RK.Sim;
  var Replay = isNode ? require('./replay.js') : root.RK.Replay;
  var api = factory(Sim, Replay);
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  (root.RK = root.RK || {}).Timeline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Sim, Replay) {
  'use strict';

  var _cache = {};        // 标称弹道缓存：key = 目标高度+载荷+难度

  /**
   * 计算标称弹道的事件时刻表。
   * @returns {{events:Array, duration:number, sim:object}}
   *          events: [{id, name, short, T}]（T 为任务时间秒）
   */
  function nominal(opts) {
    var key = (opts.targetAlt || 200e3) + '|' + (opts.payload || 26) + '|' +
              (opts.difficulty || 'normal') + '|' + (opts.demoMode ? 1 : 0);
    if (_cache[key]) { return _cache[key]; }

    var res = Replay.replayTo(opts, [], 1e9);
    var sim = res.sim;
    var events = sim.events.map(function (e) {
      return { id: e.id, name: e.name, short: e.short, T: e.T };
    });
    // 兜底：如果标称弹道没跑完（例如参数病态），至少给一个非零时长
    var duration = sim.missionTime();
    if (!(duration > 60)) { duration = 900; }

    var out = { events: events, duration: duration, endStatus: sim.status,
                steps: res.steps, ms: res.ms };
    _cache[key] = out;
    return out;
  }

  /** 任务时间格式化 T+MM:SS */
  function fmtT(T) {
    var neg = T < 0;
    var s = Math.abs(T);
    var mm = Math.floor(s / 60);
    var ss = Math.floor(s % 60);
    var str = (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
    return (neg ? 'T−' : 'T+') + str;
  }

  /* ---------------------------------------------------------------------------
   * Timeline —— DOM 时间线组件
   * @param {object} opts
   *   mount     HTMLElement 容器
   *   onSeek    (T) => void   拖动中持续回调（T 为任务时间秒）
   *   onCommit  (T) => void   松手时回调一次
   *   onJump    (T) => void   点击节点跳转
   * ------------------------------------------------------------------------ */
  function Timeline(opts) {
    this.opts = opts || {};
    this.el = this.opts.mount || null;
    this.onSeek = this.opts.onSeek || function () {};
    this.onCommit = this.opts.onCommit || function () {};
    this.onJump = this.opts.onJump || function () {};
    this.duration = 900;
    this.events = [];
    this.dragging = false;
    this.T = 0;
    this._nodes = [];
    if (this.el) { this._build(); }
  }

  Timeline.prototype._build = function () {
    var el = this.el;
    el.innerHTML = '';
    el.className = 'tl';

    var track = document.createElement('div');
    track.className = 'tl-track';
    track.setAttribute('role', 'slider');            // 可访问性：它是个滑块
    track.setAttribute('tabindex', '0');
    track.setAttribute('aria-label', '任务时间线，可拖动回溯到任意时刻');

    var fill = document.createElement('div');
    fill.className = 'tl-fill';
    track.appendChild(fill);

    var evWrap = document.createElement('div');
    evWrap.className = 'tl-events';
    track.appendChild(evWrap);

    var handle = document.createElement('div');
    handle.className = 'tl-handle';
    track.appendChild(handle);

    el.appendChild(track);

    var label = document.createElement('div');
    label.className = 'tl-label';
    el.appendChild(label);

    this._track = track; this._fill = fill;
    this._evWrap = evWrap; this._handle = handle; this._label = label;

    var self = this;

    function fracFromEvent(e) {
      var r = track.getBoundingClientRect();
      var f = (e.clientX - r.left) / Math.max(1, r.width);
      return Math.max(0, Math.min(1, f));
    }

    // ---- 指针拖拽（鼠标 / 触屏 / 手写笔统一走 Pointer Events）--------------
    track.addEventListener('pointerdown', function (e) {
      self.dragging = true;
      track.setPointerCapture(e.pointerId);
      track.classList.add('is-dragging');
      self._apply(fracFromEvent(e), false);
      e.preventDefault();
    });
    track.addEventListener('pointermove', function (e) {
      if (!self.dragging) { return; }
      // 无节流：seek 实测最坏 2.6 ms，见文件头
      self._apply(fracFromEvent(e), false);
    });
    function end(e) {
      if (!self.dragging) { return; }
      self.dragging = false;
      track.classList.remove('is-dragging');
      try { track.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
      self.onCommit(self.T);
    }
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);

    // ---- 键盘：←/→ 走 5 s，Home/End 到两端（大屏无鼠标时可用）--------------
    track.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 30 : 5;
      if (e.code === 'ArrowLeft') { self.setT(self.T - step, true); e.preventDefault(); }
      else if (e.code === 'ArrowRight') { self.setT(self.T + step, true); e.preventDefault(); }
      else if (e.code === 'Home') { self.setT(0, true); e.preventDefault(); }
      else if (e.code === 'End') { self.setT(self.duration, true); e.preventDefault(); }
    });
  };

  Timeline.prototype._apply = function (frac, commit) {
    var T = frac * this.duration;
    this.setT(T, commit);
  };

  /** 设置当前任务时间（只更新 UI + 回调，真正的物理回溯由调用方做） */
  Timeline.prototype.setT = function (T, commit, silent) {
    if (!isFinite(T)) { return; }
    this.T = T;
    var f = Math.max(0, Math.min(1, T / this.duration));
    this._fill.style.width = (f * 100).toFixed(3) + '%';
    this._handle.style.left = (f * 100).toFixed(3) + '%';
    this._label.textContent = fmtT(T) + '  /  ' + fmtT(this.duration);
    this._track.setAttribute('aria-valuenow', T.toFixed(1));
    this._track.setAttribute('aria-valuetext', fmtT(T));
    this._highlight(T);
    // silent：主循环每帧把滑块同步到当前任务时间时用。此时【只刷 UI，不回调】。
    // 若照常走 onSeek → App._onSeek → _seekTo → engine.seek()，等于每帧把 sim
    // 重放回同一时刻，并每秒 60 次 flushAccumulator()，表现为"点了播放却不动"。
    if (silent) { return; }
    if (commit) { this.onCommit(T); } else { this.onSeek(T); }
  };

  Timeline.prototype._highlight = function (T) {
    for (var i = 0; i < this._nodes.length; i++) {
      var n = this._nodes[i];
      var passed = T >= n.T;
      if (n.passed !== passed) {
        n.passed = passed;
        n.el.classList.toggle('is-passed', passed);
      }
      // 当前节点：已通过且距离最近
      n.el.classList.remove('is-current');
    }
    var cur = null;
    for (var j = 0; j < this._nodes.length; j++) {
      if (this._nodes[j].T <= T) { cur = this._nodes[j]; }
    }
    if (cur) { cur.el.classList.add('is-current'); }
  };

  /** 装载事件刻度（传入 nominal() 的结果） */
  Timeline.prototype.setEvents = function (nom) {
    this.events = nom.events;
    this.duration = nom.duration;
    this._nodes = [];
    var wrap = this._evWrap;
    if (!wrap) { return; }
    wrap.innerHTML = '';
    var self = this;

    nom.events.forEach(function (e) {
      var f = Math.max(0, Math.min(1, e.T / nom.duration));
      var d = document.createElement('button');
      d.className = 'tl-node';
      d.type = 'button';
      d.style.left = (f * 100).toFixed(3) + '%';
      d.title = fmtT(e.T) + '  ' + e.name;
      d.setAttribute('aria-label', '跳转到 ' + e.name + ' ' + fmtT(e.T));
      var dot = document.createElement('i');
      dot.className = 'tl-dot';
      d.appendChild(dot);
      var tx = document.createElement('span');
      tx.className = 'tl-node-text';
      tx.textContent = e.short;
      d.appendChild(tx);
      d.addEventListener('click', function (ev) {
        ev.stopPropagation();
        self.setT(e.T, true);
        self.onJump(e.T, e);
      });
      wrap.appendChild(d);
      self._nodes.push({ el: d, T: e.T, passed: false });
    });
    this.setT(this.T, false);
  };

  return {
    Timeline: Timeline,
    nominal: nominal,
    fmtT: fmtT
  };
});
