const { app, BrowserWindow, Menu, ipcMain, screen } = require('electron');
const path = require('path');

const isDev = !app.isPackaged;
let mainWindow = null;

// 单实例锁：避免双击产生多个窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  mainWindow = new BrowserWindow({
    title: '长征十号·火箭发射模拟器（发射→入轨）',
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#05070f',
    show: false,
    autoHideMenuBar: true,
    fullscreen: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // 彻底隐藏菜单栏
  Menu.setApplicationMenu(null);

  // 加载游戏首页
  mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // 课堂场景默认全屏
    mainWindow.setFullScreen(true);
  });

  // 屏蔽右键菜单
  mainWindow.webContents.on('context-menu', (e) => e.preventDefault());

  // 屏蔽开发者工具、F5 刷新、退格键等课堂中容易误触的按键
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const { key, control, shift } = input;

    // F12 / Ctrl+Shift+I / Ctrl+Shift+J
    if (
      key === 'F12' ||
      (control && shift && (key === 'I' || key === 'J' || key === 'C'))
    ) {
      event.preventDefault();
      return;
    }

    // F5 / Ctrl+R 刷新
    if (key === 'F5' || (control && key === 'r')) {
      event.preventDefault();
      return;
    }

    // 退格键误触导致页面后退
    if (key === 'Backspace' && !input.isEditable) {
      event.preventDefault();
      return;
    }

    // F11 切换全屏
    if (key === 'F11') {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      return;
    }

    // Esc 退出全屏
    if (key === 'Escape' && mainWindow.isFullScreen()) {
      event.preventDefault();
      mainWindow.setFullScreen(false);
      return;
    }

    // Ctrl+Q 退出程序
    if (control && key === 'q') {
      event.preventDefault();
      app.quit();
      return;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// IPC：供 preload 调用
ipcMain.on('nav-home', () => {
  if (mainWindow) {
    mainWindow.loadFile(path.join(__dirname, 'app', 'index.html'));
  }
});

ipcMain.on('toggle-fullscreen', () => {
  if (mainWindow) {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
  }
});

ipcMain.on('quit-app', () => {
  app.quit();
});
