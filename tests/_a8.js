/* =============================================================================
 * _a8.js —— 临时验证：A8（400 km 目标轨道入轨）的解锁与不解锁
 * 用完即删，不进交付。
 *
 * Score.check 依赖 localStorage（readJSON / writeRaw），这里用一个内存替身
 * 顶掉，不碰真实存档。
 * ========================================================================== */
'use strict';

var path = require('path');
var M = require(path.join(__dirname, '..', 'src', 'app', 'score.js'));
var K = require(path.join(__dirname, '..', 'src', 'core', 'constants.js'));
var Sim = require(path.join(__dirname, '..', 'src', 'core', 'sim.js'));
var Modes = require(path.join(__dirname, '..', 'src', 'app', 'modes.js'));

/* ---- localStorage 替身（必须在 require score.js 之前就位，但 score.js 是
 *      在 require 时才读的，所以这里补上即可） ------------------------------ */
var store = {};
global.window = {
  localStorage: {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  }
};

var fails = 0;
function ok(d, p, det) {
  if (!p) { fails++; }
  console.log('  ' + (p ? '✓' : '✗') + ' ' + d + (det !== undefined ? '   → ' + det : ''));
}
function head(s) { console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(0, 46 - s.length))); }

function fakeCfg(o) {
  o = o || {};
  return { get: function (k) { return o[k]; }, set: function () {} };
}

/** 跑一整发到结束，返回 { sim, res } */
function fly(mode, diff, altKm) {
  var d = new Modes.Director(fakeCfg({ mode: mode, difficulty: diff, targetAlt: altKm }));
  var opts = d.buildOpts();
  var sim = new Sim(opts);
  var gate = K.TARGETS[altKm].orbitOk;
  var vp = null, cut = false, guard = 0;
  while (sim.status !== 'complete' && sim.status !== 'failed' && guard++ < 400000) {
    if (sim.tS2Cut !== null && !sim.burning.s3) {
      var vr = sim.tele.v * Math.sin(sim.tele.gamma);
      if (vp !== null && vp > 0 && vr <= 0) { sim.pushInput('ignite3', 1); }
      vp = vr;
    }
    if (sim.burning.s3 && !cut && sim.tele.el && sim.tele.el.hp >= gate.successHp) {
      sim.pushInput('cutoff3', 1);
      cut = true;
    }
    sim.advance(0.5);
  }
  return { sim: sim, res: M.evaluate(sim, {
    targetAlt: sim.veh.targetAlt, s3BudgetKg: sim.target.s3Budget
  }) };
}

/** 按 main.js 的两条分支构造 ctx —— 与生产代码同形，避免测了个假接口 */
function ctxOf(f, mode, altKm) {
  var sim = f.sim;
  if (mode === 'demo') {
    // main.js:247 演示分支：result 恒为 null
    return { result: null, demoPlays: 1, checkMinutes: 0 };
  }
  return {
    result: f.res, sim: sim, targetAlt: altKm * 1000,
    manual: !!sim.ctl.manual && !sim.ctl.apEnabled,
    demoPlays: 0, checkMinutes: 0
  };
}

function unlockedIds(mode, diff, altKm) {
  store = {};                                   // 清空成就存档，隔离每次用例
  var f = fly(mode, diff, altKm);
  var got = M.check(ctxOf(f, mode, altKm));
  return { got: got.map(function (a) { return a.id; }), f: f };
}

/* ------------------------------------------------------------------------- */
head('① 标准档 400 km 入轨 → A8 解锁');
var r1 = unlockedIds('challenge', 'normal', 400);
ok('飞行确实入轨（res.ok = true）', r1.f.res.ok === true,
  'hp/ha = ' + (r1.f.sim.tele.el.hp / 1000).toFixed(1) + ' / ' +
  (r1.f.sim.tele.el.ha / 1000).toFixed(1) + ' km');
ok('A8 已解锁', r1.got.indexOf('A8') >= 0, '本次解锁 = [' + r1.got.join(', ') + ']');

head('② 标准档 200 km 入轨 → A8 不解锁');
var r2 = unlockedIds('challenge', 'normal', 200);
ok('飞行确实入轨（res.ok = true）', r2.f.res.ok === true,
  'hp/ha = ' + (r2.f.sim.tele.el.hp / 1000).toFixed(1) + ' / ' +
  (r2.f.sim.tele.el.ha / 1000).toFixed(1) + ' km');
ok('A8 未解锁', r2.got.indexOf('A8') < 0, '本次解锁 = [' + r2.got.join(', ') + ']');
ok('但 200 km 该拿的成就还在（A1 首次入轨）', r2.got.indexOf('A1') >= 0, '—');

head('③ 演示模式 400 km 放到入轨 → A8 不解锁');
var r3 = unlockedIds('demo', 'normal', 400);
ok('演示模式确实飞到了入轨状态',
  r3.f.sim.status === 'complete' &&
  r3.f.sim.tele.el.hp >= K.TARGETS[400].orbitOk.successHp,
  'status = ' + r3.f.sim.status + '，hp = ' +
  (r3.f.sim.tele.el.hp / 1000).toFixed(1) + ' km（若为空则会误报）');
ok('A8 未解锁（演示模式不送成就）', r3.got.indexOf('A8') < 0,
  '本次解锁 = [' + r3.got.join(', ') + ']');
ok('A1 也未解锁（守卫覆盖整个 if (res.ok) 块）', r3.got.indexOf('A1') < 0, '—');

head('④ 边界：ctx 缺 targetAlt 时不误发');
store = {};
var g4 = M.check({ result: { ok: true, parts: {}, detail: {} } });
ok('没有 targetAlt 就不给 A8', g4.map(function (a) { return a.id; }).indexOf('A8') < 0,
  '本次解锁 = [' + g4.map(function (a) { return a.id; }).join(', ') + ']');

head('⑤ ACH 表完整性');
var all = M.ACH;
ok('ACH 仍是 10 条、id 连续 A1–A10',
  all && all.length === 10 &&
  all.map(function (a) { return a.id; }).join(',') === 'A1,A2,A3,A4,A5,A6,A7,A8,A9,A10',
  all ? all.map(function (a) { return a.id; }).join(',') : 'M.ACH 不存在');
var a8 = M.ACH_BY_ID.A8;
ok('A8 定义是「空间站轨道 / 400 km」，不再是 70 t 满载荷',
  !!a8 && a8.name === '空间站轨道' && /400 km/.test(a8.desc) && !/70 t/.test(a8.desc),
  a8 ? a8.id + ' ' + a8.name + '：' + a8.desc : 'A8 不存在');

console.log('\n' + '='.repeat(52));
console.log(fails === 0 ? 'A8 验证：全部通过 ✅' : 'A8 验证：' + fails + ' 项未通过 ❌');
console.log('='.repeat(52));
process.exit(fails === 0 ? 0 : 1);
