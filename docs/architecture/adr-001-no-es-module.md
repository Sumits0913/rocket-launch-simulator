# ADR-001：禁用 ES Module，改用全局命名空间 + 顺序加载

| 项目 | 内容 |
|---|---|
| 编号 | ADR-001 |
| 状态 | **已接受（Accepted）** |
| 决策日期 | 2026-09-01 |
| 决策人 | 程基岩（技术负责人 / RL-03） |
| 影响范围 | 全部前端代码、交付方式、后续维护 |

---

## 1. 背景（Context）

本项目的终端用户是**中国科技馆的航天科普辅导员**，非技术人员。交付要求的第一条硬约束是：

> **零依赖，双击即玩**：原生 HTML + JS + Canvas/SVG，无构建工具、无 npm、无外部图片/字体/CDN。双击 `index.html` 就能跑。

这意味着程序的运行协议是 **`file://`**，而不是 `http://`。在这个前提下，现代前端的默认做法（ES Module）会直接失效。

## 2. 问题（Problem）

### 2.1 `file://` 下的 CORS 行为

浏览器对 `file://` 协议下的模块加载采取了**最严格的安全策略**：

- 普通脚本 `<script src="...">`：走的是"经典脚本"加载路径，**不受 CORS 限制**，同源的 `file://` 文件可以直接加载。
- 模块脚本 `<script type="module">`：**强制走 CORS 检查**。而 `file://` 的 origin 是 `null`（不透明源），任何 CORS 请求都会因为没有合法的 `Access-Control-Allow-Origin` 而被拒绝。

具体表现（Chrome / Edge / Firefox 行为一致）：

```
Access to script at 'file:///C:/.../src/core/atmo.js' from origin 'null'
has been blocked by CORS policy: Cross origin requests are only supported
for protocol schemes: http, data, isolated-app, chrome-extension, chrome,
https, chrome-untrusted.
```

### 2.2 为什么不能绕过

| 绕过方案 | 为什么不行 |
|---|---|
| 起一个本地 HTTP 服务器（如 `python -m http.server`） | 违反"双击即玩"。辅导员在展厅用展台电脑，不会开命令行。 |
| 给 Chrome 加 `--allow-file-access-from-files` 启动参数 | 要求用户改快捷方式目标；展厅电脑通常有还原卡/统一管理，改了会被刷掉；换台电脑就失效。 |
| 把所有代码内联进单个 HTML 文件 | 技术上可行，但本项目代码量已达 **5978 行**，单文件会让后续接手的工程师完全无法定位和修改。可维护性不可接受。 |
| 用 `fetch` + `eval` | 同样是 CORS 拦截对象，而且 `eval` 在部分环境下被 CSP 禁止。 |

## 3. 决策（Decision）

**禁止使用 `<script type="module">` 和 `import` / `export` 语法。**

改为：

1. **传统 `<script src="...">` 顺序加载**，在 `index.html` 中按依赖顺序手写脚本列表。
2. **全局命名空间 `window.RK`** 挂载所有模块。
3. **每个模块文件使用 UMD 风格包装**，使其同时能在浏览器（挂 `window.RK`）和 Node（挂 `module.exports`）下工作 —— 这一点对 `tests/physics-audit.js` 至关重要，因为物理自检脚本需要直接 `require` 这些核心模块。

### 3.1 模块包装模板

```js
;(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;                       // Node 环境：供测试脚本 require
  }
  root.RK = root.RK || {};
  root.RK.Atmo = mod;                           // 浏览器环境：挂到全局命名空间
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // ... 模块实现 ...
  return { at: at, exact: exact, selfTest: selfTest, REF: REF };
});
```

### 3.2 `index.html` 中的加载顺序

加载顺序 = 依赖拓扑序，注释里写明了每一层的依赖关系：

```html
<!-- 第 1 层：常量与基础模型（无依赖） -->
<script src="src/core/constants.js"></script>
<script src="src/core/atmo.js"></script>
<script src="src/core/orbit.js"></script>
<!-- 第 2 层：依赖第 1 层 -->
<script src="src/core/vehicle.js"></script>
<script src="src/core/dynamics.js"></script>
<script src="src/core/steering.js"></script>
<!-- 第 3 层：仿真内核，依赖 1+2 -->
<script src="src/core/sim.js"></script>
<!-- 第 4 层：应用层 -->
<script src="src/app/config.js"></script>
<script src="src/app/a11y.js"></script>
<script src="src/app/replay.js"></script>
<script src="src/app/input.js"></script>
<script src="src/app/svg-rocket.js"></script>
<script src="src/app/render.js"></script>
<script src="src/app/hud.js"></script>
<script src="src/app/timeline.js"></script>
<script src="src/app/score.js"></script>
<script src="src/app/modes.js"></script>
<!-- 第 5 层：入口，依赖全部 -->
<script src="src/app/main.js"></script>
```

`index.html` 顶部有一段加粗注释，明确说明了**为什么这里没有 `type="module"`**，避免后续维护者"好心"加上去导致程序打不开。

## 4. 代价与缓解（Consequences）

### 4.1 负面代价

| 代价 | 缓解措施 |
|---|---|
| 失去静态依赖分析，无法 tree-shaking | 本项目零依赖、无打包，不需要 |
| 全局命名污染 | 只占用 `window.RK` **一个**全局符号，其余全部收敛在其下 |
| 加载顺序需手工维护，容易出错 | 在 `index.html` 中按层分组 + 注释标注依赖方向；新增模块时只需按层插入 |
| 没有模块级作用域隔离 | 每个文件用 IIFE 包裹并 `'use strict'`，内部变量不泄漏 |
| 无法用 `import` 做循环依赖检测 | 靠分层约定（core → app → main 单向），目前无循环依赖 |

### 4.2 正面收益

- **双击即玩**：直接满足交付的第一条硬约束。
- **物理内核可在 Node 下直接测试**：`tests/physics-audit.js` 可以 `require('../src/core/sim.js')`，无需任何构建步骤、无需 jsdom、无需 babel。这是本项目"物理正确性 > 视觉华丽"质量标准的落地基础。
- **代码可维护**：18 个文件、5978 行，按职责拆分，接手的人能按图索骥。
- **无网络依赖**：展厅断网也能跑。

## 5. 验证方式

```bash
# 1. 语法检查：所有文件必须是合法脚本
for f in src/core/*.js src/app/*.js; do node --check "$f"; done

# 2. 物理自检：证明 UMD 包装在 Node 下确实可用
node tests/physics-audit.js
```

物理自检脚本内部有 6 个 `require('../src/core/*.js')` 调用，60 项断言全部通过 —— 这本身就是本 ADR 有效性的直接证据。

## 6. 备注：如果将来要上 HTTP 服务

如果项目后续需要部署到 Web 服务器（不再是 `file://`），本 ADR **不需要推翻**。UMD 包装在浏览器里继续工作，无需任何改动。届时只需在 `index.html` 里可选地加 `<script type="module">` 版本即可，两套可以并存。
