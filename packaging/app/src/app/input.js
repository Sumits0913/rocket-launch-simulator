/* =============================================================================
 * input.js —— 输入系统（键盘 / 鼠标 / 触屏按钮 → 指令 → 输入轨迹）
 * -----------------------------------------------------------------------------
 * 依据：design/gdd/modes.md §3 控制映射、adr-002 确定性重放
 *
 * ⚠ 为什么输入必须"走轨迹"而不能直接改仿真状态
 *   时间线要支持拖到任意时刻（用户决策 #3），实现方式是确定性重放：从 t=0
 *   重新算一遍。重放时唯一的外部信息就是【输入序列】。所以任何会影响物理的
 *   操作（抬头/低头、节流、点火、关机、切手动）都必须经过 engine.pushInput()
 *   落进输入轨迹；只影响 UI 的操作（暂停、加速档、切相机、切数据层）则不进
 *   轨迹 —— 它们不改变物理，重放时也不需要它们。
 *
 * ⚠ 为什么按键要"边沿触发"而不是"每帧触发"
 *   按住 ↑ 的时候如果每帧都 pushInput('pitch', +1)，一次 800 s 的任务会攒下
 *   48000 条输入，重放时每步都要扫一遍。正确做法：只在【状态变化】的那一帧
 *   记一条（按下记 +1，松开记 0）。按住 10 秒也只有 2 条。
 *   节流同理：按一次走一档（5%），用 keydown 的 repeat 过滤 + 长按连发节流。
 *
 * @module RK.Input
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var isNode = (typeof require === 'function' && typeof module === 'object');
  var C = isNode ? require('../core/constants.js') : root.RK.Constants;
  var api = factory(C);
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  (root.RK = root.RK || {}).Input = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  /* ---------------------------------------------------------------------------
   * 键位表（modes.md §3）
   *   code 用 KeyboardEvent.code（与键盘布局无关），避免使用已废弃的 keyCode。
   * ------------------------------------------------------------------------ */
  var KEYS = {
    Space: 'primary',      // 上下文主操作
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    KeyQ: 'throttleDown', KeyE: 'throttleUp',
    KeyM: 'manual', KeyP: 'pause', KeyR: 'restart',
    KeyD: 'dataLayer', KeyC: 'camera', Tab: 'panel',
    Digit1: 'warp1', Digit2: 'warp2', Digit3: 'warp3',
    Digit4: 'warp4', Digit5: 'warp5', Digit6: 'warp6',
    ArrowLeft: 'prev', ArrowRight: 'next',
    Escape: 'menu', Enter: 'confirm', Slash: 'help'
  };

  var WARP_BY_DIGIT = { warp1: 1, warp2: 2, warp3: 5, warp4: 10, warp5: 25, warp6: 50 };

  /* ---------------------------------------------------------------------------
   * Input —— 一个 Input 实例管一个任务的输入
   * @param {object} opts { engine, mode, onCommand }
   *        engine   Replay.Engine（物理指令投喂给它）
   *        mode     'demo' | 'challenge'
   *        onCommand(cmd, payload)  UI 指令回调
   * ------------------------------------------------------------------------ */
  function Input(opts) {
    this.engine = (opts && opts.engine) || null;
    this.mode = (opts && opts.mode) || 'demo';
    this.onCommand = (opts && opts.onCommand) || function () {};
    this.locked = false;              // 演示模式锁死玩家输入（modes.md §1.5）
    this.held = { up: false, down: false, throttleUp: false, throttleDown: false };
    this.pitchDir = 0;                // 当前已生效的 pitch 方向（边沿去重用）
    this._throttleRepeatAt = 0;
    this._bound = false;
  }

  Input.prototype.setEngine = function (engine) { this.engine = engine; };
  Input.prototype.setMode = function (mode) { this.mode = mode; };

  /** 投喂一条物理输入（演示模式或锁定时直接丢弃） */
  Input.prototype._push = function (kind, value) {
    if (!this.engine) { return; }
    if (this.locked || this.mode === 'demo') { return; }
    this.engine.pushInput(kind, value);
  };

  /* ---------------------------------------------------------------------------
   * 键盘事件
   * ------------------------------------------------------------------------ */
  Input.prototype.bind = function (target) {
    if (this._bound) { return this; }
    this._bound = true;
    var self = this;
    var el = target || (typeof window !== 'undefined' ? window : null);
    if (!el) { return this; }

    this._onKeyDown = function (e) { self._keydown(e); };
    this._onKeyUp = function (e) { self._keyup(e); };
    el.addEventListener('keydown', this._onKeyDown);
    el.addEventListener('keyup', this._onKeyUp);
    this._el = el;
    return this;
  };

  Input.prototype.unbind = function () {
    if (!this._bound || !this._el) { return this; }
    this._el.removeEventListener('keydown', this._onKeyDown);
    this._el.removeEventListener('keyup', this._onKeyUp);
    this._bound = false;
    return this;
  };

  Input.prototype._keydown = function (e) {
    var act = KEYS[e.code];
    if (!act) { return; }

    // Tab 会跳焦点、Space 会滚页面、方向键会滚页面 —— 全部拦掉
    if (act === 'panel' || act === 'primary' ||
        act === 'up' || act === 'down' || act === 'prev' || act === 'next') {
      e.preventDefault();
    }
    if (e.repeat && act !== 'throttleUp' && act !== 'throttleDown') { return; }

    switch (act) {
      case 'up':
      case 'down':
        this.held[act] = true;
        this._syncPitch();
        break;

      case 'throttleUp':
      case 'throttleDown':
        // 长按连发限速到 10 次/秒，避免输入轨迹被刷爆
        this.held[act] = true;
        this._throttleStep(act === 'throttleUp' ? +1 : -1, e.timeStamp || 0);
        break;

      case 'manual':
        this.onCommand('manual');
        break;

      case 'primary':
        this.onCommand('primary');
        break;

      case 'pause':
        this.onCommand('pause');
        break;

      case 'restart':
        this.onCommand('restart');
        break;

      case 'dataLayer':
        this.onCommand('dataLayer');
        break;

      case 'camera':
        this.onCommand('camera');
        break;

      case 'panel':
        this.onCommand('panel');        // Tab：数据面板循环
        break;

      case 'prev':
      case 'next':
        this.onCommand(act);            // 上一 / 下一节点
        break;

      case 'menu':
        this.onCommand('menu');
        break;

      case 'help':
        this.onCommand('help');
        break;

      default:
        if (WARP_BY_DIGIT[act] !== undefined) {
          this.onCommand('warp', WARP_BY_DIGIT[act]);
        }
        break;
    }
  };

  Input.prototype._keyup = function (e) {
    var act = KEYS[e.code];
    if (!act) { return; }
    if (act === 'up' || act === 'down') {
      this.held[act] = false;
      this._syncPitch();
    } else if (act === 'throttleUp' || act === 'throttleDown') {
      this.held[act] = false;
    }
  };

  /** 把 上/下 键的合成状态折算成一个 pitch 方向，只在变化时发一条输入 */
  Input.prototype._syncPitch = function () {
    var dir = 0;
    if (this.held.up) { dir += 1; }
    if (this.held.down) { dir -= 1; }
    if (dir === this.pitchDir) { return; }       // 边沿去重：状态没变就不记
    this.pitchDir = dir;
    this._push('pitch', dir);
  };

  /** 节流调整：走一档 5%，夹在 65%~105% 之间（公开值） */
  Input.prototype._throttleStep = function (dir, timeStamp) {
    if (!this.engine) { return; }
    var dt = timeStamp - this._throttleRepeatAt;
    if (timeStamp && dt < 100) { return; }       // 长按连发限速
    this._throttleRepeatAt = timeStamp;
    var cur = this.engine.sim.ctl.throttle;
    var next = Math.round((cur + dir * C.THROTTLE_STEP) * 100) / 100;
    if (next < C.THROTTLE_MIN) { next = C.THROTTLE_MIN; }
    if (next > C.THROTTLE_MAX) { next = C.THROTTLE_MAX; }
    if (Math.abs(next - cur) < 1e-9) { return; }
    this._push('throttle', next);
  };

  /* ---------------------------------------------------------------------------
   * 供鼠标 / 触屏按钮调用（HUD 上的大按钮走这里，与键盘完全等价）
   * 这样"键盘能做的鼠标都能做"，满足大屏/触屏场景（modes.md §3.3）
   * ------------------------------------------------------------------------ */
  Input.prototype.tap = function (act, payload) {
    switch (act) {
      case 'pitch':
        this.pitchDir = payload | 0;
        this._push('pitch', this.pitchDir);
        break;
      case 'throttle':
        this._push('throttle', payload);
        break;
      case 'manual':
        this._push('manual', payload);
        break;
      case 'ignite3':
        this._push('ignite3', 1);
        break;
      case 'cutoff3':
        this._push('cutoff3', 1);
        break;
      default:
        this.onCommand(act, payload);
        break;
    }
  };

  /**
   * 上下文主操作（空格）：按 mission-profile 的时序自动判断语义
   *   T−3 ~ T+0   → 点火（其实 T−3 已自动点火，这里只是解锁倒计时）
   *   滑行段      → 三级点火
   *   三级工作中  → 三级关机（标准档/硬核档的核心决策点，用户决策 #6）
   *   其余        → 播放/暂停
   * @returns {string} 实际执行的动作，供 UI 提示
   */
  Input.prototype.primary = function (sim) {
    if (!sim) { return 'pause'; }
    if (this.mode !== 'demo' && !this.locked) {
      if (sim.status === 'coast' && !sim.burning.s3 && sim.flags.s3 && sim.y[7] > 0) {
        this._push('ignite3', 1);
        return 'ignite3';
      }
      if (sim.burning.s3) {
        this._push('cutoff3', 1);
        return 'cutoff3';
      }
    }
    this.onCommand('pause');
    return 'pause';
  };

  return {
    Input: Input,
    KEYS: KEYS,
    WARP_BY_DIGIT: WARP_BY_DIGIT
  };
});
