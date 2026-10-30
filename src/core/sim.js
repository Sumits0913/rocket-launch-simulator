/* =============================================================================
 * sim.js —— 仿真主循环：RK4 积分、事件检测、分级、失败判定、Δv 账本
 * -----------------------------------------------------------------------------
 * 依据：design/gdd/physics.md §7 §8、mission-profile.md §1 §3 §4
 *
 * 设计要点：
 *   1) 完全确定性。相同输入序列 → 逐位相同的输出。这是"时间线任意拖拽回溯"
 *      能用「确定性重放」而不是「状态快照」实现的前提（见 adr-002）。
 *      做法：输入只在物理步的边界生效，并以「生效时刻的任务时间」记录在输入轨
 *      迹里；重放时按同样的步长调度推进，同一批输入必然落在同样的步上。
 *   2) 状态是纯数据。y 是普通 Float64Array，flags/burning/ctl 都是扁平对象，
 *      不含闭包与引用，可以安全地 JSON 化做快照（mission-profile.md §5.2）。
 *   3) 事件检测用跨步线性插值定位过零时刻（physics.md §8.5），不漏分离节点。
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var isNode = (typeof require === 'function' && typeof module === 'object');
  var C = isNode ? require('./constants.js') : root.RK.Constants;
  var Atmo = isNode ? require('./atmo.js') : root.RK.Atmo;
  var V = isNode ? require('./vehicle.js') : root.RK.Vehicle;
  var Dyn = isNode ? require('./dynamics.js') : root.RK.Dynamics;
  var Steer = isNode ? require('./steering.js') : root.RK.Steering;
  var Orbit = isNode ? require('./orbit.js') : root.RK.Orbit;
  var api = factory(C, Atmo, V, Dyn, Steer, Orbit);
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  (root.RK = root.RK || {}).Sim = api;
})(typeof globalThis !== 'undefined' ? globalThis : this,
  function (C, Atmo, V, Dyn, Steer, Orbit) {
    'use strict';

    var N = Dyn.N_DIM;     // 状态维数由 dynamics.js 定义，避免两处各写一个数字
    var D = C.DEG;

    /* ---- 事件编号（mission-profile.md §1）-------------------------------- */
    var EV = [
      { id: 'E0', name: '点火指令', short: '点火' },
      { id: 'E1', name: '起飞', short: '起飞' },
      { id: 'E2', name: '程序转弯开始', short: '程序转弯' },
      { id: 'E3', name: '最大动压 Max-Q', short: 'Max-Q' },
      { id: 'E4', name: '逃逸塔分离', short: '抛逃逸塔' },
      { id: 'E5', name: '助推器分离', short: '助推分离' },
      { id: 'E6', name: '一级分离 / 二级点火', short: '一级分离' },
      { id: 'E7', name: '抛整流罩', short: '抛整流罩' },
      { id: 'E8', name: '二级关机 / 二三级分离', short: '二级关机' },
      { id: 'E9', name: '滑行段', short: '滑行' },
      { id: 'E10', name: '三级点火', short: '三级点火' },
      { id: 'E11', name: '三级关机 / 入轨', short: '入轨' },
      { id: 'E12', name: '船箭分离', short: '船箭分离' }
    ];
    var EV_BY_ID = {};
    EV.forEach(function (e) { EV_BY_ID[e.id] = e; });

    /* -------------------------------------------------------------------------
     * Sim
     * ---------------------------------------------------------------------- */
    function Sim(opts) {
      opts = opts || {};
      this.opts = opts;
      // 目标轨道预设（用户决策 #8：200 km 与 400 km 分别标定）
      var tgt = C.TARGETS[String(Math.round((opts.targetAlt || 200e3) / 1000))] || C.TARGETS['200'];
      this.target = tgt;
      this.veh = V.build({ payload: opts.payload, targetAlt: tgt.alt });
      this.diff = Steer.DIFFICULTY[opts.difficulty] || Steer.DIFFICULTY.normal;
      this.pitchCfg = {
        h0: opts.h0 !== undefined ? opts.h0 : C.H_PITCH0,
        c: opts.c !== undefined ? opts.c : tgt.cPitch,
        thetaFloor: opts.thetaFloor !== undefined ? opts.thetaFloor : tgt.thetaFloor
      };
      /* ⚠ 这里必须用宽松判等 `!= null`，不能写 `!== undefined`：
       *   modes.js 的 buildOpts() 显式传 `orbitOk: null` 表示"未指定，用
       *   C.TARGETS 里标定好的那一套"。null !== undefined 成立，于是传进来的
       *   null 会把 tgt.orbitOk 覆盖掉，sim.orbitOk 恒为 null，
       *   hud.js / score.js 读 successHp 时抛 TypeError。 */
      this.orbitOk = (opts.orbitOk != null) ? opts.orbitOk : tgt.orbitOk;
      this.demoMode = !!opts.demoMode;           // 演示模式：禁用全部失败判定
      this.enableFailure = !this.demoMode;
      // 滑行段上限：实际点火时刻由"远地点"决定，这里只是兜底上限
      this.coastDuration = opts.coastDuration !== undefined
        ? opts.coastDuration : tgt.coastMax;
      /* 三级【闭环制导】与三级【自动关机】是两件事，2026-09-03 拆开（B4）。
       *
       *   · 制导（g3Enabled）= 姿态律：把垂直速度摁在"高度误差 × 增益"上，
       *     误差归零时自动退化为纯高度保持 —— 这是圆化关机需要的终端条件。
       *     学生在【任何】档位都要靠它，因为三级推重比只有 0.27，一次圆化
       *     要点火 230 s 以上；开环烧这么久，实测只能得到 200 × 11139 km
       *     的怪轨道（e = 0.45，还吃掉 40.7 t 推进剂）。
       *   · 自动关机（g3AutoCutoff）= 到了判据系统自己 cut off。这才是
       *     【用户决策 #6】里"硬核档手动"所指的那件事。
       *
       * ⚠ 早期把两者合成一个 g3Enabled，硬核档一关就全关，结果 modes.md §2.2
       *   的提示（"近地点到 200 km、远地点不超过 240 km 时按 空格 关机"）在
       *   开环下根本不可达 —— 实测：能压住 ha ≤ 245 km 的时刻，hp 最多只有
       *   133.4 km；等 hp 爬到 180 km 时 ha 已经 527 km。也就是硬核档无论
       *   什么时候关机都判不了"入轨成功"。
       *   现在制导常开（玩家切到全手动时除外，见 beginStep），自动关机单独
       *   由 g3AutoCutoff 决定。 */
      this.g3Enabled = opts.g3Enabled !== undefined ? !!opts.g3Enabled : true;
      this.g3AutoCutoff = opts.g3AutoCutoff !== undefined
        ? !!opts.g3AutoCutoff : (this.demoMode || !!this.diff.autoCutoff3);

      this.y = new Float64Array(N);
      this._y0 = new Float64Array(N);
      this._k1 = new Float64Array(N);
      this._k2 = new Float64Array(N);
      this._k3 = new Float64Array(N);
      this._k4 = new Float64Array(N);
      this._tmp = new Float64Array(N);
      this._out = Dyn.makeOut();
      this._out2 = Dyn.makeOut();

      this.reset();
    }

    Sim.EV = EV;
    Sim.EV_BY_ID = EV_BY_ID;

    /* ---------------------------------------------------------------------
     * 复位到 T−3 点火指令
     * ------------------------------------------------------------------ */
    Sim.prototype.reset = function () {
      var v = this.veh, y = this.y;
      var R0 = C.SITE.R0;

      y[0] = 0;                       // 发射点在 +Y 轴上（X = 东）
      y[1] = R0;
      y[2] = C.SITE.V_ROT;            // 地球自转初速（ECI，正东）—— physics.md §4.2
      y[3] = 0;
      y[4] = v.booster.prop0;         // 单个助推器推进剂
      y[5] = v.s1.prop0;
      y[6] = v.s2.prop0;
      y[7] = v.s3.prop0;
      y[8] = 90 * D;                  // 垂直
      for (var i = 9; i < N; i++) { y[i] = 0; }

      this.flags = { tower: true, fairing: true, booster: true, s1: true, s2: true, s3: true, adapter: true };
      this.burning = { s1: true, s2: false, s3: false };
      this.held = true;               // 锁定在发射台，直到 T/W > 1
      this.t = -C.SEQ.COUNTDOWN;      // 内部时间：T−3 点火指令
      this.tLift = 0;                 // 起飞时刻（内部时间）
      this.throttleEff = 0;

      this.ctl = Steer.createControl(this.diff.key, {
        allowManual: this.opts.allowManual,
        h0: this.pitchCfg.h0, c: this.pitchCfg.c,
        thetaFloor: this.pitchCfg.thetaFloor
      });
      this.ctl.inputDir = 0;

      this.mInert = v.tower.dry + v.fairing.dry + v.adapter.dry + v.payload.mass
        + v.booster.count * v.booster.dry + v.s1.dry + v.s2.dry + v.s3.dry;

      this.events = [];               // 已触发事件
      this.fired = {};                // 去重
      this.inputTrack = [];           // 输入序列（确定性重放用）
      this.maxQ = { q: 0, t: 0, h: 0, v: 0 };
      this.peakG = 0;
      this.peakQ = 0;
      this.status = 'prelaunch';      // prelaunch / flight / coast / orbit / failed / complete
      this.failure = null;
      this.orbitEl = null;
      this.tS2Cut = null;
      this.tOrbit = null;
      this.s3PropUsed = 0;
      this.atmoPhase = true;
      this.steps = 0;
      this._acc = 0;                   // 固定步长累加器（见 advance() 注释）
      this._vrPrev = undefined;        // 滑行段远地点检测用
      this.recordEvent('E0', this.t);

      this.updateTelemetry();
      return this;
    };

    /** 任务时间 T+（秒）。T+0 = 起飞。 */
    Sim.prototype.missionTime = function () { return this.t - this.tLift; };

    Sim.prototype.altitude = function () {
      var y = this.y;
      return Math.sqrt(y[0] * y[0] + y[1] * y[1]) - C.SITE.R0;
    };

    Sim.prototype.speed = function () {
      var y = this.y;
      return Math.sqrt(y[2] * y[2] + y[3] * y[3]);
    };

    /* ---------------------------------------------------------------------
     * 输入（全部走输入轨迹，保证可重放）
     * ------------------------------------------------------------------ */
    Sim.prototype.pushInput = function (kind, value) {
      this.inputTrack.push({ t: this.t, kind: kind, value: value });
      this.applyInput(kind, value);
    };

    Sim.prototype.applyInput = function (kind, value) {
      switch (kind) {
        case 'pitch':   this.ctl.inputDir = value; break;
        case 'throttle':
          this.ctl.throttle = Math.max(C.THROTTLE_MIN, Math.min(C.THROTTLE_MAX, value));
          break;
        case 'manual':  this.ctl.apEnabled = !value; break;
        case 'ignite3': this.igniteStage3(); break;
        case 'cutoff3': this.cutoffStage3('manual'); break;
        case 'ignite':  break;                      // 点火指令在 reset 时已发出
      }
    };

    /* ---------------------------------------------------------------------
     * 分级动作
     * ------------------------------------------------------------------ */
    Sim.prototype.separateTower = function () {
      if (!this.flags.tower) { return; }
      this.flags.tower = false;
      this.mInert -= this.veh.tower.dry;
      this.recordEvent('E4', this.t);
    };

    Sim.prototype.separateBoosters = function () {
      if (!this.flags.booster) { return; }
      this.flags.booster = false;
      this.mInert -= this.veh.booster.count * this.veh.booster.dry;
      this.y[4] = 0;
      this.recordEvent('E5', this.t);
    };

    Sim.prototype.separateS1 = function () {
      if (!this.flags.s1) { return; }
      this.burning.s1 = false;
      this.flags.s1 = false;
      this.mInert -= this.veh.s1.dry;
      this.y[5] = 0;
      this.burning.s2 = true;                    // 一二级分离即二级点火（mission-profile E6）
      this.recordEvent('E6', this.t);
    };

    Sim.prototype.jettisonFairing = function () {
      if (!this.flags.fairing) { return; }
      this.flags.fairing = false;
      this.mInert -= this.veh.fairing.dry;
      this.recordEvent('E7', this.t);
    };

    Sim.prototype.separateS2 = function () {
      if (!this.flags.s2) { return; }
      this.burning.s2 = false;
      this.flags.s2 = false;
      this.mInert -= this.veh.s2.dry;
      this.y[6] = 0;
      this.tS2Cut = this.t;
      this.status = 'coast';
      this.recordEvent('E8', this.t);
      this.recordEvent('E9', this.t);
      // 注意：这里【不】立即点火三级。
      // mission-profile E9 规定二三级分离后要先滑行到远地点再点火
      // （霍曼式圆化）。滑行段是演示模式的核心讲解窗口（用户决策 #7：自动暂停）。
      // 实测（2026-09-02 标定）：E8 在 T+448.4，远地点在 T+571.4，滑行 123.0 s。
      // 自动点火交给 afterStep()，判据是「γ 过零 = 远地点」与「coastDuration 上限」
      // 取先到者 —— 点火时刻跟着实测远地点走，不写死；挑战档则由玩家手动点火。
    };

    Sim.prototype.igniteStage3 = function () {
      if (!this.flags.s3 || this.burning.s3 || this.y[7] <= 0) { return; }
      this.burning.s3 = true;
      this.status = 'flight';
      this.recordEvent('E10', this.t);
    };

    Sim.prototype.cutoffStage3 = function (reason) {
      if (!this.burning.s3) { return; }
      this.s3PropUsed = this.veh.s3.prop0 - this.y[7];
      this.burning.s3 = false;
      this.updateTelemetry();
      this.orbitEl = Orbit.elements(this.y[0], this.y[1], this.y[2], this.y[3]);
      this.tOrbit = this.t;
      this.status = 'orbit';
      this.recordEvent('E11', this.t, { reason: reason || 'auto' });
    };

    Sim.prototype.separateShip = function () {
      if (!this.flags.adapter) { return; }
      this.flags.adapter = false;
      this.mInert -= this.veh.adapter.dry;
      this.status = 'complete';
      this.recordEvent('E12', this.t);
    };

    /** 记录一个事件（同一 id 只记一次），并同步通知外部观察者 */
    Sim.prototype.recordEvent = function (id, t, data) {
      if (this.fired[id]) { return null; }
      this.fired[id] = true;
      var e = { id: id, name: EV_BY_ID[id] ? EV_BY_ID[id].name : id,
                short: EV_BY_ID[id] ? EV_BY_ID[id].short : id,
                t: t, T: t - this.tLift, data: data || null, index: this.events.length };
      this.events.push(e);
      if (this.onEvent) { this.onEvent(e, this); }
      return e;
    };

    /* ---------------------------------------------------------------------
     * 步长调度（physics.md §8.2 分区固定步长 + 滞环）
     * ------------------------------------------------------------------ */
    Sim.prototype.pickStep = function () {
      var h = this.tele.h, q = this.tele.q;
      if (this.atmoPhase) {
        if (h > C.ATMO_UP) { this.atmoPhase = false; }
      } else if (h < C.ATMO_DOWN && q > C.ATMO_Q_GATE) {
        this.atmoPhase = true;
      }
      var thrusting = (this.flags.s1 && this.burning.s1) || this.burning.s2 || this.burning.s3;
      if (this.atmoPhase) { return C.DT_ATMO; }
      return thrusting ? C.DT_VAC : C.DT_COAST;
    };

    /* ---------------------------------------------------------------------
     * RK4 单步
     * ------------------------------------------------------------------ */
    Sim.prototype.rk4 = function (dt) {
      var y = this.y, y0 = this._y0, k1 = this._k1, k2 = this._k2, k3 = this._k3,
          k4 = this._k4, tmp = this._tmp, i;
      for (i = 0; i < N; i++) { tmp[i] = y[i]; }

      Dyn.deriv(this, y, k1, this._out);
      for (i = 0; i < N; i++) { tmp[i] = y[i] + 0.5 * dt * k1[i]; }
      Dyn.deriv(this, tmp, k2, this._out);
      for (i = 0; i < N; i++) { tmp[i] = y[i] + 0.5 * dt * k2[i]; }
      Dyn.deriv(this, tmp, k3, this._out);
      for (i = 0; i < N; i++) { tmp[i] = y[i] + dt * k3[i]; }
      Dyn.deriv(this, tmp, k4, this._out);

      for (i = 0; i < N; i++) {
        y[i] = y[i] + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
      }
    };

    /**
     * 推进 dtSim 秒（按【固定步长累加器】调度）。
     *
     * ⚠ 为什么必须用累加器（确定性，见 adr-002）
     *   早期写法是 `while (remaining > 0) { dt = min(pickStep(), remaining); step(dt) }`。
     *   在 60 fps 下每一帧只推进 16.7 ms，小于大气段步长 20 ms，于是【每一个物理步
     *   都被截断成 16.7 ms】—— 积分步长由帧率决定，掉帧或换机器就会走出不同的弹道，
     *   时间线拖拽回放也就无从"确定性"了。
     *   正确做法：帧时间先进累加器，只有攒够一个完整步长才走一步，余量留到下一帧。
     *   这样步长序列恒为 pickStep() 的返回值，与帧率、与机器完全无关。
     *
     * @param {number} dtSim     本帧要推进的仿真时间 s（真实时间 × 倍速）
     * @param {number} maxSteps  本帧最多走几步（防止卡死，默认 C.MAX_STEPS_PER_FRAME）
     * @returns {number} 实际推进的仿真时间 s（一定是整数个完整步长之和）
     */
    Sim.prototype.advance = function (dtSim, maxSteps) {
      if (this.status === 'failed' || this.status === 'complete') { return 0; }
      this._acc = (this._acc || 0) + dtSim;
      var guard = 0;
      var lim = maxSteps || C.MAX_STEPS_PER_FRAME;
      var done = 0;

      while (this._acc > 1e-9 && guard++ < lim) {
        var dt = this.pickStep();
        if (dt > this._acc) { break; }        // 余量不够一个完整步长，留到下一帧
        this.beginStep(dt);
        var used = this.step(dt);
        done += used;
        this._acc -= dt;                       // 注意：扣的是请求步长，不是 used
        this.steps++;
        this.afterStep();
        if (this.status === 'failed' || this.status === 'complete') { break; }
        if (used <= 0) { this._acc = 0; break; }   // 数值兜底，防止死循环
      }
      /* 步长预算被走满（guard 会停在 lim + 1）却仍有欠账 → 这一帧算不动这么多
       * 仿真时间（warp 太高或单帧耗时过长）。此时必须把欠账【丢弃】而不是继续
       * 挂账：债务会单调累积（warp 50 大气段实测 53 帧后 _acc 涨到 52 s），
       * 出大气后才慢慢还清，表现为"实时倍速被悄悄拖慢"，进度条与字幕脱节。
       * 丢掉的是"没算的将来时间"，已走完的步长序列不受影响（确定性见 adr-002）。
       * 注意：`if (dt > this._acc) break;` 那条正常分支只留不足一个步长的余量，
       * guard ≤ lim，不会被这里误伤。 */
      if (guard > lim && this._acc > 1e-9) { this._acc = 0; }
      return done;
    };

    /** 丢掉累加器余量（暂停 / 跳转 / 重置时用） */
    Sim.prototype.flushAccumulator = function () { this._acc = 0; };

    /**
     * 推进一步。返回实际推进的 dt（若中途触发分离事件会小于请求值）。
     */
    Sim.prototype.step = function (dt) {
      var y = this.y, y0 = this._y0, i;
      for (i = 0; i < N; i++) { y0[i] = y[i]; }

      this.rk4(dt);

      // ---- 推进剂耗尽：跨步线性插值定位过零时刻（physics.md §8.5）--------
      var frac = 1, hit = null;
      if (this.flags.booster && this.burning.s1 && y0[4] > 0 && y[4] <= 0) {
        frac = y0[4] / (y0[4] - y[4]); hit = 'booster';
      } else if (this.flags.s1 && this.burning.s1 && y0[5] > 0 && y[5] <= 0) {
        frac = y0[5] / (y0[5] - y[5]); hit = 's1';
      } else if (this.flags.s2 && this.burning.s2 && y0[6] > 0 && y[6] <= 0) {
        frac = y0[6] / (y0[6] - y[6]); hit = 's2';
      } else if (this.flags.s3 && this.burning.s3 && y0[7] > 0 && y[7] <= 0) {
        frac = y0[7] / (y0[7] - y[7]); hit = 's3';
      }

      if (hit) {
        if (frac < 0) { frac = 0; } else if (frac > 1) { frac = 1; }
        for (i = 0; i < N; i++) { y[i] = y0[i]; }
        this.rk4(dt * frac);
        this.t += dt * frac;
        var idx = { booster: 4, s1: 5, s2: 6, s3: 7 }[hit];
        if (y[idx] < 0) { y[idx] = 0; }
        this.resolveCrossing(hit);
        return dt * frac;
      }

      this.t += dt;
      return dt;
    };

    Sim.prototype.resolveCrossing = function (hit) {
      if (hit === 'booster') { this.separateBoosters(); }
      else if (hit === 's1') { this.separateS1(); }
      else if (hit === 's2') { this.separateS2(); }
      else if (hit === 's3') {
        this.y[7] = 0;
        this.cutoffStage3('propellant');
      }
    };

    /** 每步开始：应用输入、更新推力爬升、更新姿态指令 */
    Sim.prototype.beginStep = function (dtStep) {
      var ctl = this.ctl;

      // 推力爬升（mission-profile E0：推力从 0 爬到 100% 需 1.5 s）
      var sinceIgnition = this.t + C.SEQ.COUNTDOWN;
      var ramp = C.THRUST_RAMP > 0 ? Math.min(1, Math.max(0, sinceIgnition / C.THRUST_RAMP)) : 1;
      this.throttleEff = ctl.throttle * ramp;

      // 姿态：AP（+ 玩家偏差 / 全手动）。三级另有入轨闭环制导，见 guideStage3()
      Steer.advance(ctl, this.tele.h, dtStep, ctl.inputDir);
      /* 三级制导在【全手动】时让位给玩家：apEnabled 为 false 时 θ 由玩家直接
       * 推（steering.js 的第 3 层分支），此时制导不能再覆盖，否则成就 A7
       * 「关闭自动驾驶完成入轨」就没法做了。 */
      if (this.burning.s3 && this.g3Enabled && ctl.apEnabled) { this.guideStage3(); }
    };

    /* ---------------------------------------------------------------------
     * 三级入轨闭环制导（演示模式 / 入门档启用；标准档与硬核档由玩家自己来）
     * ---------------------------------------------------------------------
     * 为什么三级必须用闭环：三级推重比只有 0.27（3×YF-75E 共 276 kN / 101 t），
     * 开环的"照程序飞"在这么低的推重比下无法收敛到圆轨道 —— 实测开环会一路
     * 烧到推进剂耗尽，得到一个 200 × 688 km 的扁椭圆。
     * 这里用的是真实运载火箭末级制导的两条基本规则：
     *   ① 高度保持：把垂直速度 v_r 摁在 v_rCmd = 增益 × (目标高度 − 当前高度) 上。
     *      高度误差归零时 v_rCmd 自动归零 —— 这正是圆化所需的终端条件；
     *   ② 近地点关机：一直烧到轨道近地点抬到目标高度。点火时近地点是负的
     *      （亚轨道），随着水平加速单调抬升，抬到 200 km 时轨道正好是圆的。
     * 这是【游戏】层面的自动驾驶，不改任何物理，只是替玩家按姿态键。
     * ------------------------------------------------------------------ */
    Sim.prototype.guideStage3 = function () {
      var t = this.tele;
      var Fm = t.m > 0 ? t.F / t.m : 0;
      if (Fm < 1e-6) { return; }

      // 局部垂直通道的精确运动学（极坐标，离心项在这里是合法的）：
      //     d(v_r)/dt = (F/m)·sinθ − (g − v_t²/r)
      // 记"净重力" g_net = g − v_t²/r（向下为正）。要在 τ 秒内把垂直速度
      // 拉到 v_rCmd，需要的垂直加速度为 a_v* = g_net + (v_rCmd − v_r)/τ。
      var vr = t.v * Math.sin(t.gamma);            // 垂直速度（向上为正）
      var vt = t.v * Math.cos(t.gamma);            // 水平速度
      var gNet = t.g - vt * vt / t.r;              // 净重力（可能为负 = 离心力赢了）

      // 目标垂直速度：高度误差 × 增益，限幅。误差→0 时自动退化为"纯高度保持"，
      // 也就是把 v_r 摁在 0 —— 这正是圆化关机需要的终端条件。
      var vrCmd = C.G3_GH * (this.veh.targetAlt - t.h);
      if (vrCmd > C.G3_VR_MAX) { vrCmd = C.G3_VR_MAX; }
      else if (vrCmd < -C.G3_VR_MAX) { vrCmd = -C.G3_VR_MAX; }

      var avReq = gNet + (vrCmd - vr) / C.G3_TAU_V;
      var s = avReq / Fm;
      if (s > C.G3_SIN_MAX) { s = C.G3_SIN_MAX; }  // 抬头/低头都封顶，留足水平推力
      else if (s < -C.G3_SIN_MAX) { s = -C.G3_SIN_MAX; }
      this.ctl.thetaCmd = Math.asin(s);

      // ---- 关机判据：近地点抬到"圆轨道"为止 --------------------------------
      // 真实运载火箭末级的标准逻辑：一直烧到轨道近地点抬到目标高度。
      // 点火时近地点约 −1617 km（2026-09-02 实测标定值，亚轨道，这正是
      // 教学点"还没入轨"）；水平加速过程中近地点单调抬升，抬到与当前高度
      // 持平时轨道就是圆轨道。
      //
      // ⚠ 关键的容差写法（实测踩过的坑）：
      //   轨道要素恒有 h_p ≤ h（近地点不高于航天器当前所在高度）。所以如果
      //   滑行段远地点只有 198 km、目标却是 200 km，判据 "h_p ≥ 200 km" 永远
      //   不成立 —— 三级会一路烧到推进剂耗尽，得到一个 200 × 1355 km 的怪轨道。
      //   正确写法是以"目标高度与当前高度中的小者"为闸门：
      //       h_p ≥ min(目标高度, 当前高度) − 1.5 km
      //   含义是"能圆化到目标就圆化到目标，够不着就在当前高度圆化"——
      //   后者是诚实的失败结果（轨道低了 3 km），而不是数值发散。
      var el = t.el;
      // ⚠ 这一段是【自动关机】，只在 g3AutoCutoff 为真时执行。
      //   硬核档（以及标准档打开"手动关机"）这里不成立 —— 制导照常压住轨迹，
      //   但"什么时候停"由学生按 空格 决定（用户决策 #6）。
      if (el && this.g3AutoCutoff) {
        var gate = Math.min(this.veh.targetAlt, t.h) - C.G3_HP_TOL;
        if (el.hp >= gate) { this.cutoffStage3('perigee'); }
      }
    };

    /** 每步结束：更新遥测、检测事件与失败 */
    Sim.prototype.afterStep = function () {
      this.updateTelemetry();
      var T = this.missionTime();

      // E1 起飞：T/W > 1（physics 上就是推力超过重量）
      if (this.held) {
        var W = this.tele.m * this.tele.g;
        if (this.tele.F >= W) {
          this.held = false;
          this.tLift = this.t;
          this.status = 'flight';
          this.recordEvent('E1', this.t);
        }
      } else {
        // E2 程序转弯
        if (!this.fired.E2 && this.tele.h >= this.pitchCfg.h0) {
          this.recordEvent('E2', this.t);
        }
        // E4 逃逸塔分离
        if (this.flags.tower && T >= C.SEQ.TOWER_SEP_T) { this.separateTower(); }
        // E7 抛整流罩：高度过卡门线【且】过了标称时刻，取两者较晚者。
        //   只按高度判据会在 T+198（芯一级单独燃烧段内）就抛掉，
        //   使 Δv 预算表的 B 段含抛除事件，违反 vehicle.md §4.2.1 的
        //   分段边界规则（V-15）。标称时刻见 C.SEQ.FAIRING_SEP_T。
        if (this.flags.fairing && this.tele.h >= C.SEQ.FAIRING_SEP_H
            && T >= C.SEQ.FAIRING_SEP_T) { this.jettisonFairing(); }
      }

      // E3 Max-Q：由 q 的实测峰值判定，不硬编码时刻
      if (this.tele.q > this.maxQ.q) {
        this.maxQ.q = this.tele.q; this.maxQ.t = this.t;
        this.maxQ.h = this.tele.h; this.maxQ.v = this.tele.v;
      } else if (!this.fired.E3 && this.maxQ.q > 5000 && this.tele.q < this.maxQ.q * 0.995) {
        this.recordEvent('E3', this.maxQ.t, {
          q: this.maxQ.q, h: this.maxQ.h, v: this.maxQ.v
        });
      }

      if (this.tele.q > this.peakQ) { this.peakQ = this.tele.q; }
      if (this.tele.gForce > this.peakG) { this.peakG = this.tele.gForce; }

      // 滑行段结束 → 自动点火三级（演示模式 / 入门档）
      // 点火时机取「远地点（γ 过零）」与「滑行上限 coastMax」中先到的那个。
      // 远地点点火是霍曼式圆化的最优时机：此刻 v_r = 0，三级可以几乎纯水平加速，
      // 重力损失与余弦损失都最小（vehicle.md §4.3 的三级预算正是这么算出来的）。
      // 实测（2026-09-02 标定）：远地点在 T+571.4，即滑行 123.0 s；
      // 200 km 目标的 coastMax = 130 s 只是标定漂移时的兜底。
      if (this.status === 'coast' && this.tS2Cut !== null && !this.burning.s3) {
        if (this.diff.autoIgnite3 || this.demoMode) {
          var vrNow = this.tele.v * Math.sin(this.tele.gamma);
          var atApogee = (this._vrPrev !== undefined) && this._vrPrev > 0 && vrNow <= 0;
          if (atApogee || this.t - this.tS2Cut >= this.coastDuration) {
            this.igniteStage3();
          }
          this._vrPrev = vrNow;
        }
      }

      // 三级工作中：闭环制导的关机判据在 guideStage3() 里；
      // 这里只留一条兜底 —— 手动关机档（硬核档）学生没按空格时，
      // 推进剂烧光也算关机（随后由 F4「推进剂耗尽」判失败）。
      if (this.burning.s3 && !this.g3AutoCutoff && this.y[7] <= 0) {
        this.cutoffStage3('propellant');
      }

      // 入轨后 20 s 船箭分离
      if (this.status === 'orbit' && this.flags.adapter) {
        if (this.t - this.tOrbit >= C.SEQ.SHIP_SEP_DELAY) {
          this.separateShip();
        }
      }

      // 失败判定（挑战模式）
      if (this.enableFailure) { this.checkFailure(); }

      // NaN / Inf 兜底（ui-spec §5）
      if (!isFinite(this.y[0]) || !isFinite(this.y[2]) || !isFinite(this.tele.m)) {
        this.status = 'failed';
        this.failure = { code: 'F0', name: '数值异常', detail: '积分出现非有限值，已暂停' };
      }
    };

    Sim.prototype.checkFailure = function () {
      var F = C.FAIL, sc = this.diff.failScale, t = this.tele;
      var f = null;
      if (t.q > F.Q_MAX * sc) {
        f = { code: 'F1', name: '动压超限解体', value: t.q / 1000, unit: 'kPa',
              hint: '最大动压区（T+70~90 s）应提前降低推力。' };
      /* F2 攻角超限：上限走 C.alphaLimitAt() 的单一口径。
       * 动压低于 Q_ALPHA_MIN（真空）时它返回 Infinity，本分支自动不成立 ——
       * 真空里攻角不产生气动载荷，判解体没有物理依据。修改前这里会在
       * 三级点火瞬间（q=0）误判，挑战模式三档必败（B3）。 */
      } else if (Math.abs(t.alpha) > C.alphaLimitAt(t.q, sc)) {
        f = { code: 'F2', name: '攻角超限解体', value: Math.abs(t.alpha) * C.RAD, unit: '°',
              hint: '不要急转弯。姿态角要跟随速度方向，不能硬掰。' };
      } else if (t.gForce > F.G_MAX * sc) {
        f = { code: 'F3', name: '过载超限', value: t.gForce, unit: 'g',
              hint: '一级末段火箭变轻，加速度会快速上升，需要提前节流。' };
      } else if (this.flags.s3 && this.y[7] <= 0 && !this.burning.s3 && this.status !== 'orbit') {
        f = { code: 'F4', name: '推进剂耗尽', value: this.tele.v, unit: 'm/s',
              hint: '重力损失吃掉了太多 Δv。试试更早开始转弯。' };
      } else if (t.h < 0 || (t.h < F.REENTRY_H && t.gamma < F.REENTRY_GAMMA && t.v > F.REENTRY_V)) {
        f = { code: 'F5', name: '再入坠毁', value: t.h, unit: 'm',
              hint: '横向速度不足。入轨靠的是横向，不是高度。' };
      }
      if (f) {
        this.status = 'failed';
        this.failure = f;
        if (this.onFailure) { this.onFailure(f, this); }
      }
    };

    /** 刷新遥测（HUD 直接读 this.tele） */
    Sim.prototype.updateTelemetry = function () {
      var o = Dyn.resolve(this, this.y, this._out);
      this.tele = o;
      this.tele.T = this.missionTime();
      var el = Orbit.elements(this.y[0], this.y[1], this.y[2], this.y[3]);
      this.tele.el = el;
      this.tele.dvIdeal = this.y[9];
      this.tele.dvGrav = this.y[10];
      this.tele.dvDrag = this.y[11];
      this.tele.dvSteer = this.y[12];       // 恒等式口径（含自转不对齐项）
      this.tele.dvSteerSelf = this.y[13];   // 教学口径（推力 vs 自速度）
      this.tele.dvRotAlign = this.y[12] - this.y[13];
      // Δv 恒等式残差（physics.md §9.1）：必须 < 1 m/s
      this.tele.residual = this.tele.v
        - (this.y[9] - this.y[10] - this.y[11] - this.y[12] + C.SITE.V_ROT);
      return o;
    };

    /** 各级推进剂（给 HUD）：{ id, name, remain, total, pct, active } */
    Sim.prototype.propellant = function () {
      var v = this.veh, y = this.y;
      var out = [];
      out.push({ id: 'booster', name: '助推', remain: this.flags.booster ? v.booster.count * y[4] : 0,
                 total: v.booster.count * v.booster.prop0, active: this.flags.booster && this.burning.s1 });
      out.push({ id: 's1', name: '一级', remain: this.flags.s1 ? y[5] : 0, total: v.s1.prop0,
                 active: this.flags.s1 && this.burning.s1 });
      out.push({ id: 's2', name: '二级', remain: this.flags.s2 ? y[6] : 0, total: v.s2.prop0,
                 active: this.flags.s2 && this.burning.s2 });
      out.push({ id: 's3', name: '三级', remain: this.flags.s3 ? y[7] : 0, total: v.s3.prop0,
                 active: this.flags.s3 && this.burning.s3 });
      out.forEach(function (p) { p.pct = p.total > 0 ? p.remain / p.total : 0; });
      return out;
    };

    /* ---------------------------------------------------------------------
     * 快照 / 恢复（mission-profile.md §5.2）
     * ------------------------------------------------------------------ */
    Sim.prototype.snapshot = function () {
      return {
        y: Array.prototype.slice.call(this.y),
        flags: JSON.parse(JSON.stringify(this.flags)),
        burning: JSON.parse(JSON.stringify(this.burning)),
        ctl: JSON.parse(JSON.stringify(this.ctl)),
        mInert: this.mInert, t: this.t, tLift: this.tLift,
        throttleEff: this.throttleEff, held: this.held,
        status: this.status, events: this.events.length,
        fired: JSON.parse(JSON.stringify(this.fired)),
        maxQ: JSON.parse(JSON.stringify(this.maxQ)),
        peakG: this.peakG, peakQ: this.peakQ,
        tS2Cut: this.tS2Cut, tOrbit: this.tOrbit, atmoPhase: this.atmoPhase,
        inputLen: this.inputTrack.length, steps: this.steps,
        acc: this._acc, vrPrev: this._vrPrev,
        orbitEl: this.orbitEl, s3PropUsed: this.s3PropUsed,
        failure: this.failure, coastDone: this._coastDone
      };
    };

    Sim.prototype.restore = function (s) {
      for (var i = 0; i < N; i++) { this.y[i] = s.y[i]; }
      this.flags = JSON.parse(JSON.stringify(s.flags));
      this.burning = JSON.parse(JSON.stringify(s.burning));
      this.ctl = JSON.parse(JSON.stringify(s.ctl));
      this.mInert = s.mInert; this.t = s.t; this.tLift = s.tLift;
      this.throttleEff = s.throttleEff; this.held = s.held;
      this.status = s.status; this.fired = JSON.parse(JSON.stringify(s.fired));
      this.maxQ = JSON.parse(JSON.stringify(s.maxQ));
      this.peakG = s.peakG; this.peakQ = s.peakQ;
      this.tS2Cut = s.tS2Cut; this.tOrbit = s.tOrbit; this.atmoPhase = s.atmoPhase;
      this.events = this.events.slice(0, s.events);
      this.inputTrack = this.inputTrack.slice(0, s.inputLen);
      this.steps = s.steps;
      this._acc = s.acc || 0;
      this._vrPrev = s.vrPrev;
      this.orbitEl = s.orbitEl || null;
      this.s3PropUsed = s.s3PropUsed || 0;
      this.failure = s.failure || null;
      this._coastDone = !!s.coastDone;
      this.updateTelemetry();
    };

    return Sim;
  });
