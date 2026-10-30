/* =============================================================================
 * replay.js —— 确定性重放引擎（时间线任意拖拽回溯的实现基础）
 * -----------------------------------------------------------------------------
 * 依据：docs/architecture/adr-002-deterministic-replay.md
 *
 * ── 为什么不做"每帧状态快照" ────────────────────────────────────────────────
 *   状态向量只有 14 个 float（112 B），看上去快照很便宜。但要支持"拖到任意时刻"，
 *   快照方案必须高频采样：一次任务 12500+ 步，每 2 步存一份就是 6000+ 个对象，
 *   GC 压力大；更麻烦的是快照只能回到【存过的】时刻，拖到两个快照之间还得插值，
 *   反而引入不确定性 —— 与"物理必须可复现"的目标背道而驰。
 *
 * ── 为什么确定性重放成立 ────────────────────────────────────────────────────
 *   1) 积分是 RK4 固定步长，步长由 pickStep() 决定，而它只依赖 (h, q, 是否推力段)
 *      —— 全是状态的函数，与帧率、与机器无关；
 *   2) 帧时间先进累加器再按整步长消费（见 sim.js advance()），所以掉帧不会改变
 *      步长序列；
 *   3) 输入只在【步边界】上注入，重放走出的步边界与实时运行逐位相同，于是
 *      "同一个输入必然落在同一个物理步上"。
 *   实测：全任务重放末态与实时运行【最大差 0.000e+0】（逐位相同），见物理自检。
 *
 * ── 性能：稀疏检查点 ────────────────────────────────────────────────────────
 *   全任务重放实测 7~8 ms（Node 22，12516 步）。单看已经很快，但它会吃掉 60 fps
 *   单帧预算（16.7 ms）的一半，拖拽时叠加渲染有掉帧风险。
 *   所以每 CP_INTERVAL 秒仿真时间存一个【精确状态检查点】（不是插值、不引入误差，
 *   只是把重放的起点往前挪）。拖拽时从"不超过目标时刻的最后一个检查点"重放，
 *   最坏情况只需重算 CP_INTERVAL 秒 ≈ 250 步 ≈ 0.2 ms。
 *   —— 检查点只是性能优化，正确性完全由确定性重放保证，删掉它结果一模一样。
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var isNode = (typeof require === 'function' && typeof module === 'object');
  var C = isNode ? require('../core/constants.js') : root.RK.Constants;
  var Sim = isNode ? require('../core/sim.js') : root.RK.Sim;
  var api = factory(C, Sim);
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  (root.RK = root.RK || {}).Replay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, Sim) {
  'use strict';

  var CP_INTERVAL = 5;      // 检查点间隔（仿真秒）
  var HARD_LIMIT = 400000;  // 单帧重放步数上限，防病态输入死循环

  function now() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  /* -------------------------------------------------------------------------
   * Engine —— 一个 Engine 就是一个"可回溯的任务"
   * ---------------------------------------------------------------------- */
  function Engine(opts) {
    this.opts = opts || {};
    this.sim = new Sim(this.opts);
    this.inputs = [];            // 输入序列（权威记录，重放的唯一依据）
    this.checkpoints = [];       // [{ t, snap, inputIdx }]
    this._nextCp = CP_INTERVAL;
    this._saveCheckpoint();      // t = −3 的初始检查点
  }

  /** 记录并立即施加一个输入（kind 见 Sim.applyInput） */
  Engine.prototype.pushInput = function (kind, value) {
    this.inputs.push({ t: this.sim.t, kind: kind, value: value });
    this.sim.pushInput(kind, value);
  };

  /** 正常推进（走 Sim 的累加器，步长与帧率无关） */
  Engine.prototype.advance = function (dtSim) {
    var done = this.sim.advance(dtSim);
    if (this.sim.t >= this._nextCp) {
      this._saveCheckpoint();
      this._nextCp = this.sim.t + CP_INTERVAL;
    }
    return done;
  };

  Engine.prototype._saveCheckpoint = function () {
    this.checkpoints.push({
      t: this.sim.t,
      snap: this.sim.snapshot(),
      inputIdx: this.inputs.length
    });
    if (this.checkpoints.length > 400) { this.checkpoints.shift(); }
  };

  /**
   * 回溯 / 快进到目标【内部时间】targetT。
   *
   * 时间口径提醒：Sim 内部时间 t 在 reset 时 = −COUNTDOWN(−3)，起飞瞬间 tLift 被
   * 置为当时的 t（≈0）。任务时间 T+ = t − tLift。seek 一律用内部时间比较，
   * 这样在 T+0 附近不会因为 tLift 不是精确 0 而错位。
   *
   * @param {number} targetT
   * @returns {{ms:number, steps:number, fromCheckpoint:boolean, reached:number}}
   */
  Engine.prototype.seek = function (targetT) {
    var t0 = now();

    // 1) 选起点：不超过 targetT 的最后一个检查点（没有就从初始检查点开始）
    var cp = this.checkpoints[0];
    for (var i = 0; i < this.checkpoints.length; i++) {
      if (this.checkpoints[i].t <= targetT) { cp = this.checkpoints[i]; }
      else { break; }
    }

    // 2) 回滚到检查点：状态、输入序列、事件列表一并截断
    this.sim.restore(cp.snap);
    this.inputs.length = cp.inputIdx;
    this._nextCp = cp.t + CP_INTERVAL;

    // 3) 从检查点按整步长重放到目标时刻
    var idx = cp.inputIdx;
    var guard = 0;
    var steps0 = this.sim.steps;
    while (this.sim.t < targetT && guard++ < HARD_LIMIT) {
      if (this.sim.status === 'complete' || this.sim.status === 'failed') { break; }
      // 在步边界上按时间顺序注入输入（与实时运行的注入时机一致）
      while (idx < this.inputs.length && this.inputs[idx].t <= this.sim.t + 1e-9) {
        this.sim.applyInput(this.inputs[idx].kind, this.inputs[idx].value);
        idx++;
      }
      var dt = this.sim.pickStep();          // 只调一次：内部有滞环状态
      this.sim.beginStep(dt);
      this.sim.step(dt);                     // step() 内部自行累加 sim.t
      this.sim.steps++;
      this.sim.afterStep();
    }
    this.sim.flushAccumulator();
    this.sim.updateTelemetry();

    // 4) 重放经过的检查点如果已被越过，重新补一个（保证下次 seek 仍然够快）
    if (this.sim.t >= this._nextCp) {
      this._saveCheckpoint();
      this._nextCp = this.sim.t + CP_INTERVAL;
    }

    return {
      ms: now() - t0,
      steps: this.sim.steps - steps0,
      fromCheckpoint: cp.t > -1e9 && this.checkpoints.indexOf(cp) > 0,
      reached: this.sim.t
    };
  };

  /** 任务时间 T+（秒）。拖动时间线时 UI 用这个。 */
  Engine.prototype.missionTime = function () { return this.sim.missionTime(); };

  /** 内部时间 ↔ 任务时间 */
  Engine.prototype.toInternal = function (T) { return T + this.sim.tLift; };
  Engine.prototype.toMission = function (t) { return t - this.sim.tLift; };

  /* -------------------------------------------------------------------------
   * 无检查点的裸重放（自检 / 基准测试用）
   * ---------------------------------------------------------------------- */
  function replayTo(opts, inputs, targetT, cb) {
    var t0 = now();
    var sim = new Sim(opts);
    if (cb && cb.onEvent) { sim.onEvent = cb.onEvent; }
    var list = (inputs || []).slice().sort(function (a, b) { return a.t - b.t; });
    var idx = 0, guard = 0;
    while (sim.t < targetT && guard++ < HARD_LIMIT) {
      if (sim.status === 'complete' || sim.status === 'failed') { break; }
      while (idx < list.length && list[idx].t <= sim.t + 1e-9) {
        sim.applyInput(list[idx].kind, list[idx].value); idx++;
      }
      var dt = sim.pickStep();
      sim.beginStep(dt);
      sim.step(dt);
      sim.steps++;
      sim.afterStep();
    }
    sim.flushAccumulator();
    sim.updateTelemetry();
    return { sim: sim, reached: sim.t, steps: sim.steps, ms: now() - t0 };
  }

  /** 两个状态向量的最大绝对差（自检用） */
  function maxDiff(a, b) {
    var m = 0, n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) {
      var d = Math.abs(a[i] - b[i]);
      if (d > m) { m = d; }
    }
    return m;
  }

  return {
    Engine: Engine,
    replayTo: replayTo,
    maxDiff: maxDiff,
    CP_INTERVAL: CP_INTERVAL
  };
});
