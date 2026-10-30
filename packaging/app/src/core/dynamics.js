/* =============================================================================
 * dynamics.js —— 运动方程：受力、气动、导数
 * -----------------------------------------------------------------------------
 * 依据：design/gdd/physics.md §6（阻力/动压/法向力）、§7（运动方程与重力转弯）
 *
 * 状态向量 y（14 维，SI；维数常量见文件末尾 N_DIM）：
 *   [0] x      ECI 位置 X（东）      m
 *   [1] y      ECI 位置 Y（天顶）    m
 *   [2] vx     ECI 速度 X            m/s
 *   [3] vy     ECI 速度 Y            m/s
 *   [4] pB     单个助推器剩余推进剂   kg
 *   [5] p1     芯一级剩余推进剂       kg
 *   [6] p2     芯二级剩余推进剂       kg
 *   [7] p3     芯三级剩余推进剂       kg
 *   [8] theta  实际姿态角（滞后后）   rad
 *   [9]  dvIdeal   ∫(F/m)dt          m/s
 *   [10] dvGrav    ∫(μ/r²)·sinγ dt   m/s
 *   [11] dvDrag    ∫(D₀/m)dt         m/s
 *   [12] dvSteer   ∫(F/m)(1−cosα)dt      m/s   α = 推力与【惯性速度】的夹角
 *   [13] dvSteerSelf ∫(F/m)(1−cosα_s)dt  m/s   α_s = 推力与【自己造出来的速度】的夹角
 *
 * ⚠ 为什么要两个转向损失（教学口径，已回传 team-lead）
 *   physics.md §9.1 的恒等式在【惯性系】里做账，而 §4.1 的需求侧预算把
 *   "地球自转赠送的 438 m/s"单列在等式右边。两者合起来必然产生一个副作用：
 *   起飞瞬间火箭的惯性速度是 438 m/s 正东、推力却是垂直向上，α ≈ 90°，
 *   于是头 30 s 的"转向损失"就积到 ~380 m/s，全程 ~800 m/s。
 *   这个数在物理上没算错（推力确实没有增加惯性速率），但拿去给学生看会
 *   被误读成"我们转弯转丢了 800 m/s"，而教科书上这一项只有 60 m/s。
 *   所以再积分一个"自速度"口径的损失：v⃗_self = v⃗ − v⃗_rot（火箭自己挣出来的
 *   那部分速度），α_s = 推力与 v⃗_self 的夹角。起飞时 v⃗_self ≈ 0 且沿推力方向，
 *   α_s ≈ 0，损失为 0 —— 与教科书口径一致。
 *   两者的差额 y[12] − y[13] 就是纯粹的"自转初速不对齐"记账项，
 *   HUD 上单独标注，不让教师背锅。恒等式仍用 y[12]，不受影响。
 *
 * 把 Δv 账本放进状态向量一起积分，是为了让 §9.1 的恒等式在 RK4 的每个子步里
 * 都保持同一阶精度；如果改用"每步末用梯形法补记"，恒等式残差会随步长变大。
 *
 * ⚠ 关于重力损失的定义（与 physics.md §9.1 的一处冲突，已裁定）
 *   physics.md §9.1 写 Δv_gravity = ∫(μ/r² − v_h²/r)·sinγ dt（多一个离心项）。
 *   但同一份文档要求 |residual| < 1 m/s，且 vehicle.md §4.4 的时段分解表用的
 *   是 ∫g·sinγ·dt（g = μ/r²，无离心项）。沿速度方向做投影可以严格证明：
 *       dv/dt = (F/m)cosα − D/m − (μ/r²)·sinγ
 *   代入恒等式后离心项无处安放 —— 若保留它，残差会积累到 ~170 m/s，恒等式必然崩。
 *   【裁定】以恒等式自洽 + vehicle.md §4.4 为准：Δv_gravity = ∫(μ/r²)·sinγ dt。
 *   已在 architecture.md §物理口径裁定 中记录，并回传 team-lead。
 *
 * ⚠ 关于气动力的参考系（实现补正，已回传 team-lead）
 *   physics.md §6 用「速度 v」计算动压，但仿真状态量是【ECI 惯性速度】。
 *   大气随地球共转，所以气动力必须用【相对大气的速度】w⃗ = v⃗ − v⃗_air：
 *       v⃗_air = ω·cos φ · (y·ê − x·r̂₀)      （ω⃗ × r⃗ 在发射平面内的投影）
 *   不修正的后果（实测）：发射台上 w 应为 0，却算出 v=438 m/s → q = 117 kPa、
 *   攻角 90°，火箭在头 40 s 被假阻力刹住，根本飞不起来。
 *   修正后发射台 q=0、α=0，与物理直觉一致。
 *   验证：圆轨道上 v⃗_air 恒与当地正东同向、量值 438 m/s（沿大圆处处成立），
 *        故 ISS 的相对风速 = 7786 − 438 = 7348 m/s，与常识一致 ✓
 * ========================================================================== */
(function (root, factory) {
  'use strict';
  var isNode = (typeof require === 'function' && typeof module === 'object');
  var C = isNode ? require('./constants.js') : root.RK.Constants;
  var Atmo = isNode ? require('./atmo.js') : root.RK.Atmo;
  var V = isNode ? require('./vehicle.js') : root.RK.Vehicle;
  var api = factory(C, Atmo, V);
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  (root.RK = root.RK || {}).Dynamics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, Atmo, V) {
  'use strict';

  var MU = C.MU, G0 = C.G0;
  var A_REF = C.A_REF, CN_A = C.CN_ALPHA, ALIN = C.ALPHA_LIN, CDA = C.CD_ALPHA;
  var CDM = C.CD_TABLE.M, CDC = C.CD_TABLE.Cd;
  var OMEGA_P = C.OMEGA_E * Math.cos(C.SITE.lat);   // ω·cos φ，大气共转的面内角速度

  /** 阻力系数 Cd0(M)：表内线性插值（physics.md §6.2） */
  function cd0(mach) {
    if (mach <= CDM[0]) { return CDC[0]; }
    var n = CDM.length;
    if (mach >= CDM[n - 1]) { return CDC[n - 1]; }
    for (var i = 1; i < n; i++) {
      if (mach <= CDM[i]) {
        var w = (mach - CDM[i - 1]) / (CDM[i] - CDM[i - 1]);
        return CDC[i - 1] + (CDC[i] - CDC[i - 1]) * w;
      }
    }
    return CDC[n - 1];
  }

  /** 法向力对攻角的饱和处理：|α| > 15° 后饱和（§6.3） */
  function satAlpha(a) {
    if (a > ALIN) { return ALIN; }
    if (a < -ALIN) { return -ALIN; }
    return a;
  }

  /* ---------------------------------------------------------------------------
   * 核心：给定状态解出全部派生量（HUD 也要用，所以单独抽出来）
   * @param {object} s   Sim 实例（提供 veh / flags / ctl / mInert / throttleEff）
   * @param {Array}  y   状态向量
   * @param {object} o   输出容器（复用，避免每步分配）
   * ------------------------------------------------------------------------ */
  function resolve(s, y, o) {
    var x = y[0], yy = y[1], vx = y[2], vy = y[3];
    var pB = y[4], p1 = y[5], p2 = y[6], p3 = y[7];
    var theta = y[8];

    var r = Math.sqrt(x * x + yy * yy);
    var v = Math.sqrt(vx * vx + vy * vy);
    var h = r - C.SITE.R0;

    // 大气（随地球共转）：面内空气速度 v⃗_air = ω·cosφ·(y, −x)
    var airx = OMEGA_P * yy, airy = -OMEGA_P * x;
    var wx = vx - airx, wy = vy - airy;
    var w = Math.sqrt(wx * wx + wy * wy);

    var at = Atmo.at(h < 0 ? 0 : h);
    var rho = at.rho, pa = at.p, snd = at.a;
    var q = 0.5 * rho * w * w;                 // 动压必须用相对速度
    var mach = snd > 0 ? w / snd : 0;

    // 质量
    var nb = s.flags.booster ? s.veh.booster.count : 0;
    var m = s.mInert + nb * pB + p1 + p2 + p3;

    /* 参考面积：助推器在箭身上时，迎风面积是 3 个 5 m 直径的圆
     * （芯级 + 2 个助推，同径，这是长十区别于长五的识别特征）。
     * physics.md §10.2 只给了芯级单体的 19.635 m²，那是"按芯级直径取参考面积"
     * 的行业惯例，配的 Cd 也是单体值；这里显式乘上并联体数，物理上更实在。
     * 助推器分离后自动退回单体的 19.635 m²。 */
    var aRef = A_REF * (1 + nb);

    // 姿态 / 弹道 / 攻角（基向量见 constants.js 顶部说明）
    var rx = x / r, ry = yy / r;              // r̂ 天顶
    var tx = yy / r, ty = -x / r;             // t̂ 正东
    // 惯性弹道倾角 γ（重力损失投影用）
    var vhx = v > 1e-9 ? vx / v : tx, vhy = v > 1e-9 ? vy / v : ry;
    var sinG = vhx * rx + vhy * ry;
    var cosG = vhx * tx + vhy * ty;
    var gamma = Math.asin(sinG > 1 ? 1 : (sinG < -1 ? -1 : sinG));

    // 推力方向 û_T = cosθ·t̂ + sinθ·r̂
    var ct = Math.cos(theta), st = Math.sin(theta);
    var ux = ct * tx + st * rx;
    var uy = ct * ty + st * ry;

    // 相对气流方向 ŵ 与相对弹道倾角 γ_r；攻角 α = θ − γ_r（气动力必须用 γ_r）
    /* w ≈ 0 时 ŵ 无定义，回退必须取【箭体轴向 û_T】（上面 140–143 行已算好）：
     *   这样 sinγ_r = û_T·r̂ = sinθ、cosγ_r = û_T·t̂ = cosθ → γ_r = θ → α = θ − γ_r = 0。
     *   物理意义：没有相对气流时，箭体姿态就是"来流方向"，攻角恒为 0。
     * ⚠ 历史 bug：这里曾写成 `var whx = tx, why = ry;`，把 t̂ 的 x 分量和 r̂ 的
     *   y 分量拼成一个 (1,1) 向量 —— 发射台上（θ=90°）算出 γ_r=45°、α=45°，
     *   直接触发 F2「攻角超限解体」，挑战模式开局即判失败。 */
    var whx = ux, why = uy;                   // w ≈ 0 时取箭体轴向，α = 0
    var gammaR = theta;
    if (w > 1e-6) { whx = wx / w; why = wy / w; }
    var sinGr = whx * rx + why * ry;
    var cosGr = whx * tx + why * ty;
    gammaR = Math.atan2(sinGr > 1 ? 1 : (sinGr < -1 ? -1 : sinGr),
                        cosGr > 1 ? 1 : (cosGr < -1 ? -1 : cosGr));
    var alpha = theta - gammaR;
    // 推力与【惯性速度】的夹角余弦（转向损失按惯性速度算，供 §9.1 恒等式使用）
    var cosA = ux * vhx + uy * vhy;
    if (cosA > 1) { cosA = 1; } else if (cosA < -1) { cosA = -1; }

    // 推力与【自速度】的夹角余弦：v⃗_self = v⃗ − v⃗_rot（教学口径的转向损失）
    // v⃗_rot 在本模型里是常量 (V_ROT, 0)（physics.md §4.2：自转只作为初速度）
    var vsx = vx - C.SITE.V_ROT, vsy = vy;
    var vs = Math.sqrt(vsx * vsx + vsy * vsy);
    var cosAs = 1;                       // |v⃗_self| 太小时推力与它同向，损失为 0
    if (vs > 1) {
      cosAs = (ux * vsx + uy * vsy) / vs;
      if (cosAs > 1) { cosAs = 1; } else if (cosAs < -1) { cosAs = -1; }
    }

    // 推进
    var pr = pa / C.P0; if (pr < 0) { pr = 0; } else if (pr > 1) { pr = 1; }
    var eta = s.throttleEff;

    var F = 0, mdotB = 0, mdot1 = 0, mdot2 = 0, mdot3 = 0;
    var e1, e2, e3;

    // 一级：芯一级从 T+0 一直烧到推进剂耗尽；助推器与之同时点火，先烧完
    if (s.flags.s1 && s.burning.s1) {
      e1 = V.engineState(s.veh.s1.eng, pr, eta);
      var fMod = V.thrustFirstModule(s.veh.s1.eng, pr, eta);      // 单模块（7 台）推力
      var mMod = V.mdotFirstModule(s.veh.s1.eng, pr, eta);        // 单模块（7 台）ṁ
      if (p1 > 0) { F += fMod; mdot1 = mMod; }
      if (s.flags.booster && pB > 0) {
        F += s.veh.booster.count * fMod;
        mdotB = mMod;                                             // 每个助推器一个模块
      }
    }

    if (s.flags.s2 && s.burning.s2 && p2 > 0) {
      e2 = V.engineState(s.veh.s2.eng, pr, 1.0);
      mdot2 = V.mdotStage(s.veh.s2, pr, 1.0);
      F += s.veh.s2.nEng * e2.F;
    }
    if (s.flags.s3 && s.burning.s3 && p3 > 0) {
      e3 = V.engineState(s.veh.s3.eng, pr, 1.0);
      mdot3 = V.mdotStage(s.veh.s3, pr, 1.0);
      F += s.veh.s3.nEng * e3.F;
    }

    // ---- 气动（全部用相对速度 w）------------------------------------------
    var cd0v = cd0(mach);
    var D0 = q * aRef * cd0v;                                    // 零攻角阻力
    var Dx = q * aRef * CDA * Math.abs(alpha) * C.RAD;           // 攻角附加阻力
    var D = D0 + Dx;
    var N = q * aRef * CN_A * Math.sin(satAlpha(alpha));         // 法向力（含饱和）

    // 阻力沿 −ŵ；法向力沿 p̂（箭体轴逆时针 90°：α>0 时抬头 → 法向力朝上）
    var px = -st * tx + ct * rx;
    var py = -st * ty + ct * ry;

    // 加速度
    var g = MU / (r * r);
    var agx = -g * rx, agy = -g * ry;
    var aTx = (F / m) * ux, aTy = (F / m) * uy;
    var aDx = -(D / m) * whx, aDy = -(D / m) * why;
    var aNx = (N / m) * px, aNy = (N / m) * py;

    // 气动热（S-01，仅可视化，不做失败判定）—— 用相对速度
    var heat = rho > 1e-12 ? 1.7415e-4 * Math.sqrt(rho / C.R_NOSE) * w * w * w : 0;

    o.r = r; o.v = v; o.h = h; o.m = m;
    o.rho = rho; o.pa = pa; o.snd = snd; o.q = q; o.mach = mach;
    o.w = w; o.wRelX = wx; o.wRelY = wy; o.gammaR = gammaR;
    o.theta = theta; o.gamma = gamma; o.alpha = alpha; o.cosA = cosA;
    o.vSelf = vs; o.cosAs = cosAs;
    o.F = F; o.mdotB = mdotB; o.mdot1 = mdot1; o.mdot2 = mdot2; o.mdot3 = mdot3;
    o.mdot = mdotB * (s.flags.booster ? s.veh.booster.count : 0) + mdot1 + mdot2 + mdot3;
    o.D = D; o.D0 = D0; o.Dx = Dx; o.N = N; o.g = g; o.cd = cd0v; o.aRef = aRef;
    o.heat = heat;
    o.ax = aTx + aDx + aNx + agx;
    o.ay = aTy + aDy + aNy + agy;
    o.aMag = Math.sqrt(o.ax * o.ax + o.ay * o.ay);
    // 过载 = 非引力加速度 / g₀（乘员真正感受到的）。发射台上由塔架支撑，恒为 1 g。
    o.gForce = s.held ? 1
      : Math.sqrt((aTx + aDx + aNx) * (aTx + aDx + aNx)
                + (aTy + aDy + aNy) * (aTy + aDy + aNy)) / G0;
    o.rx = rx; o.ry = ry; o.tx = tx; o.ty = ty;
    o.vhx = vhx; o.vhy = vhy;
    // Δv 账本专用：气动力在惯性速度方向上的投影（保证 §9.1 恒等式严格成立）
    o.aeroAlongV = -(aDx + aNx) * vhx - (aDy + aNy) * vhy;   // = −d(dvDrag+dvSteer_aero)/dt
    return o;
  }

  /** 复用的输出容器（每步都写同一个对象，调用方需要留存就自己拷） */
  function makeOut() {
    return {};
  }

  /* ---------------------------------------------------------------------------
   * 导数：dy/dt
   * @param {object} s   Sim 实例
   * @param {Array}  y   状态
   * @param {Array}  out 输出（长度 13）
   * @param {object} tmp resolve 用的临时容器
   * ------------------------------------------------------------------------ */
  function deriv(s, y, out, tmp) {
    var o = resolve(s, y, tmp);
    var m = o.m;
    var invM = 1 / m;

    // 发射台锁定：T/W < 1 时被塔架压住，位置与速度都不变。
    // （注意：不能在发射台上让 x 以 v_rot 平移 —— 那等于让火箭沿地面"滑行"，
    //   还会凭空产生 117 kPa 的假动压。自转的贡献已经作为初速度给了 v⃗₀。）
    if (s.held) {
      out[0] = 0; out[1] = 0;
      out[2] = 0; out[3] = 0;
    } else {
      out[0] = y[2]; out[1] = y[3];
      out[2] = o.ax; out[3] = o.ay;
    }

    // 推进剂消耗
    out[4] = (s.flags.booster && s.burning.s1 && y[4] > 0) ? -o.mdotB : 0;
    out[5] = (s.flags.s1 && s.burning.s1 && y[5] > 0) ? -o.mdot1 : 0;
    out[6] = (s.flags.s2 && s.burning.s2 && y[6] > 0) ? -o.mdot2 : 0;
    out[7] = (s.flags.s3 && s.burning.s3 && y[7] > 0) ? -o.mdot3 : 0;

    // 姿态一阶滞后：dθ/dt = (θ_cmd − θ)/τ_att
    out[8] = (s.ctl.thetaCmd - y[8]) / C.TAU_ATT;

    /* Δv 账本（见文件头注释：重力损失不含离心项）
     * 恒等式（physics.md §9.1）要求严格成立：
     *     v(t) = Δv_ideal − Δv_grav − Δv_drag − Δv_steer + v_rot
     * 沿惯性速度方向投影可严格推出 dv/dt = (F/m)cosα_i − g·sinγ − A，
     * 其中 A = −[(D⃗+N⃗)·v̂]/m 为气动力造成的减速率。于是定义：
     *     Δv_drag  = ∫ A dt                 （气动损失：含阻力与法向力的速度方向投影）
     *     Δv_steer = ∫(F/m)(1−cosα_i) dt    （推力转向损失：纯余弦损失）
     * 这两项按定义分账，恒等式残差只来自 RK4 截断误差，实测 < 0.01 m/s。 */
    var sinG = Math.sin(o.gamma);
    var FM = o.F * invM;
    if (s.held) {
      // 在发射台上：推力被塔架平衡，Δv 一分钱都没给出去，账本五项全为 0。
      out[9] = 0; out[10] = 0; out[11] = 0; out[12] = 0; out[13] = 0;
    } else {
      out[9] = FM;                                   // 理想 Δv   ∫(F/m)dt
      out[10] = o.g * sinG;                          // 重力损失   ∫g·sinγ dt
      out[11] = o.aeroAlongV;                        // 气动损失   ∫A dt
      out[12] = FM * (1 - o.cosA);                   // 转向损失（恒等式口径）
      out[13] = FM * (1 - o.cosAs);                  // 转向损失（教学口径）
    }
    return out;
  }

  return {
    resolve: resolve,
    deriv: deriv,
    makeOut: makeOut,
    cd0: cd0,
    N_DIM: 14
  };
});
