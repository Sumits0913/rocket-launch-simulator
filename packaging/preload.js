const { contextBridge, ipcRenderer } = require('electron');

function injectControls() {
  if (document.getElementById('wb-game-controls')) return;

  const css = `
    #wb-game-controls {
      position: fixed;
      right: 16px;
      bottom: 16px;
      display: flex;
      gap: 8px;
      z-index: 2147483647;
      opacity: 0.35;
      transition: opacity 0.25s ease;
      user-select: none;
      pointer-events: auto;
    }
    #wb-game-controls:hover,
    #wb-game-controls.wb-active {
      opacity: 1;
    }
    #wb-game-controls button {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      border: 1px solid rgba(255, 255, 255, 0.22);
      background: rgba(11, 22, 44, 0.65);
      color: #ffffff;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      transition: background 0.2s ease, transform 0.1s ease;
    }
    #wb-game-controls button:hover {
      background: rgba(38, 80, 145, 0.85);
      transform: scale(1.08);
    }
    #wb-game-controls button:active {
      transform: scale(0.96);
    }
    @media (max-width: 700px) {
      #wb-game-controls button { width: 34px; height: 34px; font-size: 16px; }
    }
  `;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const wrap = document.createElement('div');
  wrap.id = 'wb-game-controls';
  wrap.innerHTML = `
    <button id="wb-btn-home" title="返回首页">⌂</button>
    <button id="wb-btn-full" title="切换全屏">⛶</button>
    <button id="wb-btn-exit" title="退出程序">✕</button>
  `;
  document.body.appendChild(wrap);

  document.getElementById('wb-btn-home').addEventListener('click', () => ipcRenderer.send('nav-home'));
  document.getElementById('wb-btn-full').addEventListener('click', () => ipcRenderer.send('toggle-fullscreen'));
  document.getElementById('wb-btn-exit').addEventListener('click', () => ipcRenderer.send('quit-app'));

  // 点击任意按钮时临时加高亮
  wrap.addEventListener('mouseenter', () => wrap.classList.add('wb-active'));
  wrap.addEventListener('mouseleave', () => wrap.classList.remove('wb-active'));
}

window.addEventListener('DOMContentLoaded', injectControls);
