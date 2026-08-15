const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen, desktopCapturer, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let overlayWindow = null;
let tray = null;
let isListening = false;
let backendProcess = null;

function getBackendDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(__dirname, '..', 'backend');
}

// A packaged app's install folder is typically read-only (macOS .app bundles,
// Windows Program Files without admin rights) — so the .env file the Settings
// page writes has to live somewhere always-writable instead. Dev mode keeps
// using plain backend/.env since that's what you've been editing directly.
function getEnvPath() {
  return app.isPackaged
    ? path.join(app.getPath('userData'), '.env')
    : path.join(getBackendDir(), '.env');
}

// Path to a PyInstaller-frozen backend executable, if one was built and bundled.
// When present, we skip Python entirely — this is what makes the packaged app
// work without requiring Python to be installed on the end user's machine.
function getBundledBackendExe() {
  const backendDir = getBackendDir();
  const exeName = process.platform === 'win32' ? 'backend.exe' : 'backend';
  return path.join(backendDir, 'dist', exeName);
}

// --- .env read/write --------------------------------------------------------
// Simple key=value parser/writer — enough for our own generated .env file,
// avoids adding a dependency just for this.
function readEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function writeEnvFile(envPath, values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v ?? ''}`);
  fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
}

// 16x16 transparent-ish dot icon, base64, so we don't depend on an external asset file.
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOElEQVR4Ae3OMQoAIAwDwPz' +
  '/06Kj4uLg0EJyU2gG1UpV8QIAAAAAAAAAAAAAAAAAAADAWwOU3AGVQZoCFQAAAABJRU5ErkJggg==';

// --- backend auto-start ---------------------------------------------------
// Spawns the Python backend automatically so this feels like one app instead
// of "run two terminals". In a packaged build, PyInstaller output would live
// under process.resourcesPath/backend — dev mode uses the plain backend/ folder
// with the system Python + uvicorn. Falls back from python3 -> python since
// Windows commonly only has 'python' on PATH.
function startBackend() {
  const backendDir = getBackendDir();
  const bundledExe = getBundledBackendExe();

  // --ws-max-size raises the per-message websocket limit (uvicorn's default is
  // ~1MB) — needed because a burst of screenshots gets sent as one JSON message
  // and can exceed that default with more than a few frames.
  const WS_ARGS = ['--ws-max-size', '20000000'];

  let attempts;
  if (fs.existsSync(bundledExe)) {
    // Standalone executable found (built via PyInstaller) — no Python needed at
    // all. It runs uvicorn internally via the __main__ block in main.py.
    attempts = [{ cmd: bundledExe, args: [] }];
  } else {
    // Dev mode / no bundled exe yet — try things in the same order a human would
    // type them in Terminal: plain 'uvicorn' first (matches whatever environment,
    // conda/venv/system, actually has it working), then explicit python -m uvicorn.
    const venvPython = process.platform === 'win32'
      ? path.join(backendDir, 'venv', 'Scripts', 'python.exe')
      : path.join(backendDir, 'venv', 'bin', 'python3');

    attempts = [
      { cmd: 'uvicorn', args: ['main:app', '--host', '127.0.0.1', '--port', '8765', ...WS_ARGS] },
    ];
    if (fs.existsSync(venvPython)) {
      attempts.push({ cmd: venvPython, args: ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8765', ...WS_ARGS] });
    }
    attempts.push({
      cmd: process.platform === 'win32' ? 'python' : 'python3',
      args: ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8765', ...WS_ARGS],
    });
  }

  // Merge saved API keys (from the .env file the Settings page writes) directly
  // into the spawned process's environment too, so a fresh start always has the
  // latest keys even before python-dotenv would re-read the file itself.
  const envFileValues = readEnvFile(getEnvPath());
  const spawnEnv = { ...process.env, ...envFileValues };

  function tryLaunch(index) {
    if (index >= attempts.length) {
      console.error('[backend] Could not start uvicorn through any method. Run it manually: ' +
        'cd backend && uvicorn main:app --host 127.0.0.1 --port 8765 --ws-max-size 20000000');
      return;
    }
    const { cmd, args } = attempts[index];
    const proc = spawn(cmd, args, {
      cwd: backendDir,
      env: spawnEnv,
      shell: process.platform === 'win32', // helps PATH resolution on Windows
    });

    proc.on('error', (err) => {
      console.warn(`[backend] '${cmd}' failed to start (${err.message}), trying next method...`);
      tryLaunch(index + 1);
    });

    proc.stdout.on('data', (data) => console.log(`[backend] ${data}`.trim()));
    proc.stderr.on('data', (data) => console.log(`[backend] ${data}`.trim()));

    proc.on('exit', (code) => {
      if (code !== 0 && index < attempts.length - 1 && !app.isQuitting) {
        console.warn(`[backend] '${cmd}' exited with code ${code}, trying next method...`);
        tryLaunch(index + 1);
      } else if (!app.isQuitting) {
        console.warn(`[backend] process exited unexpectedly (code ${code})`);
      }
    });

    backendProcess = proc;
  }

  tryLaunch(0);
}

function stopBackend() {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}

function createOverlayWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  overlayWindow = new BrowserWindow({
    width: 420,
    height: 300,
    x: width - 440,
    y: 40,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true, // don't show in taskbar/dock switcher
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver'); // stays above fullscreen apps/meetings
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // THE key trick: excludes this window from screen capture / screen-share / recordings
  // on macOS 13+ and Windows 10 2004+. Not supported on Linux (no OS API for it) —
  // on Linux this call is a no-op and the overlay WILL be visible in screen shares.
  overlayWindow.setContentProtection(true);

  overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
  overlayWindow.webContents.openDevTools({ mode: 'detach' });

  // Close button in UI just hides it — process keeps running via the tray.
  overlayWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      overlayWindow.hide();
    }
  });
}

function toggleOverlay() {
  if (!overlayWindow) return;
  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
  } else {
    overlayWindow.show();
  }
}

function toggleListening() {
  isListening = !isListening;
  if (overlayWindow) {
    overlayWindow.webContents.send('listening-toggled', isListening);
  }
  updateTrayMenu();
}

function updateTrayMenu() {
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show/Hide Overlay (Cmd/Ctrl+Shift+O)', click: toggleOverlay },
    { label: isListening ? 'Stop Listening (Cmd/Ctrl+Shift+L)' : 'Start Listening (Cmd/Ctrl+Shift+L)', click: toggleListening },
    { type: 'separator' },
    { label: 'Open DevTools (debug)', click: () => { if (overlayWindow) overlayWindow.webContents.openDevTools({ mode: 'detach' }); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
}

function createTray() {
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_BASE64, 'base64'));
  tray = new Tray(icon);
  tray.setToolTip('Interview Copilot');
  updateTrayMenu();
  tray.on('click', toggleOverlay);
}

app.whenReady().then(() => {
  startBackend();
  createOverlayWindow();
  createTray();

  // Built-in system audio capture — no BlackHole/VB-CABLE required. This auto-grants
  // getDisplayMedia({audio:true}) requests from the renderer, selecting the primary
  // screen and enabling loopback audio automatically (no picker dialog shown to the
  // user). Requires macOS 13+ (Ventura) or Windows 10+; on macOS this piggybacks on
  // the same Screen Recording permission already needed for the screenshot feature.
  overlayWindow.webContents.session.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        callback({ video: sources[0], audio: 'loopback' });
      });
    },
    { useSystemPicker: false }
  );

  // Global hotkeys — work even when the overlay isn't focused, e.g. while you're
  // focused on the video call window.
  globalShortcut.register('CommandOrControl+Shift+O', toggleOverlay);
  globalShortcut.register('CommandOrControl+Shift+L', toggleListening);
  globalShortcut.register('CommandOrControl+Shift+A', () => {
    // Manual "answer now" trigger, mirrors Parakeet's manual trigger option
    if (overlayWindow) overlayWindow.webContents.send('manual-trigger');
  });
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    // Screenshot the screen and ask the AI to solve whatever's shown (e.g. a
    // coding problem in a shared screen), on demand.
    if (overlayWindow) overlayWindow.webContents.send('screenshot-trigger');
  });
  globalShortcut.register('CommandOrControl+Shift+I', () => {
    // Debug helper — opens DevTools so JS errors (e.g. failed screen capture)
    // are actually visible instead of failing silently.
    if (overlayWindow) overlayWindow.webContents.toggleDevTools();
  });

  // macOS: hide dock icon so it behaves like a background utility, not a normal app
  if (process.platform === 'darwin' && app.dock) {
    app.dock.hide();
  }
});

// Keep running in the background when all windows are "closed" (hidden).
// This does NOT survive an actual Quit — no software can run after its process exits.
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopBackend();
});

ipcMain.handle('get-listening-state', () => isListening);

ipcMain.handle('resize-window', (_event, { height }) => {
  if (!overlayWindow) return;
  const [width] = overlayWindow.getSize();
  overlayWindow.setSize(width, height, true);
});

ipcMain.handle('capture-screen', async () => {
  // Capture at a size that keeps text readable without producing huge payloads —
  // important since burst-capture mode sends several of these at once.
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;
  const maxWidth = 1600;
  const scale = Math.min(1, maxWidth / width);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
  });

  if (!sources.length) return null;

  // The overlay itself is excluded from this capture automatically — the same
  // setContentProtection(true) that hides it from screen shares also hides it here.
  const primary = sources[0];
  // JPEG at quality 80 instead of PNG — much smaller payload for the same visible
  // text clarity, which matters a lot once several screenshots get bundled into
  // one message (see the --ws-max-size bump below for the other half of this fix).
  return primary.thumbnail.toJPEG(80).toString('base64');
});

// --- API keys & provider setup, all from the Settings page --------------

ipcMain.handle('get-provider-config', () => {
  const values = readEnvFile(getEnvPath());
  return {
    sttProvider: values.STT_PROVIDER || 'deepgram',
    llmProvider: values.LLM_PROVIDER || 'gemini',
    // Only report whether each key is SET, never the key itself — the renderer
    // never needs to see secrets it already gave us once.
    hasDeepgram: !!values.DEEPGRAM_API_KEY,
    hasOpenai: !!values.OPENAI_API_KEY,
    hasGemini: !!values.GEMINI_API_KEY,
    hasGroq: !!values.GROQ_API_KEY,
    hasAnthropic: !!values.ANTHROPIC_API_KEY,
  };
});

ipcMain.handle('save-provider-config', async (_event, config) => {
  const envPath = getEnvPath();
  const existing = readEnvFile(envPath);

  // Only overwrite a key if the user actually typed something new — leaves
  // previously-saved keys intact if the field was left blank this time.
  const merged = {
    STT_PROVIDER: config.sttProvider || existing.STT_PROVIDER || 'deepgram',
    LLM_PROVIDER: config.llmProvider || existing.LLM_PROVIDER || 'gemini',
    DEEPGRAM_API_KEY: config.deepgramKey || existing.DEEPGRAM_API_KEY || '',
    OPENAI_API_KEY: config.openaiKey || existing.OPENAI_API_KEY || '',
    GEMINI_API_KEY: config.geminiKey || existing.GEMINI_API_KEY || '',
    GROQ_API_KEY: config.groqKey || existing.GROQ_API_KEY || '',
    ANTHROPIC_API_KEY: config.anthropicKey || existing.ANTHROPIC_API_KEY || '',
  };
  writeEnvFile(envPath, merged);

  // Keys only take effect on process start (python-dotenv reads once at
  // import time) — restart the backend now so the change is live immediately.
  stopBackend();
  await new Promise((resolve) => setTimeout(resolve, 300)); // let the old port free up
  startBackend();
  return { ok: true };
});

ipcMain.handle('open-external', (_event, url) => {
  shell.openExternal(url);
});
