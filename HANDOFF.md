# Interview Copilot — Project Handoff

This is a personal, Parakeet-AI-style live interview copilot: it captures audio during a
real interview (interviewer's voice via system audio, and optionally the user's own mic),
transcribes it in real time, generates an AI answer grounded in the user's resume/JD, and
displays it in a floating overlay that's invisible during screen shares. It also has an
on-demand "read the screen" feature for coding questions.

**Owner/user context:** Varun, a recent B.Tech (AI & Data Science) grad, building this for
personal use on his own MacBook Air (Apple Silicon, macOS, uses Homebrew + Anaconda's
Python). Not a SaaS product — no auth, no billing, single user.

This doc is a complete snapshot for handoff to another assistant. It includes full current
file contents, the environment-specific issues already solved (so they aren't re-debugged
from scratch), and the current open issue.

---

## 1. Architecture

```
System/meeting audio ─┐
                       ├─► BlackHole 2ch (virtual audio device, macOS)
Mic (optional, mixed) ─┘         │
                                  ▼
                    Electron overlay (renderer/overlay.html + overlay.js)
                    captures via getUserMedia, downsamples to 24kHz PCM16,
                    streams over WebSocket
                                  │
                                  ▼
                 FastAPI backend (backend/main.py) — ws://127.0.0.1:8765/ws/session
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                             ▼
          STT provider (streaming)        LLM provider (streaming)
          Deepgram (default) or            Gemini (default) or
          OpenAI Realtime API              Anthropic or OpenAI
                    │                             │
                    └──────────► transcript + AI answer streamed back to overlay
```

- **Electron main process** (`electron/main.js`): creates the floating overlay window,
  system tray, global hotkeys, and screen-capture IPC handler.
- **Renderer** (`renderer/overlay.html` + `overlay.js`): the actual UI — audio capture,
  WebSocket client, buttons, settings panel.
- **Backend** (`backend/main.py`): FastAPI WebSocket server. Provider-agnostic — proxies
  audio to whichever STT provider is configured, and calls whichever LLM provider is
  configured, streaming both back to the overlay.
- **`renderer/test.html`**: a standalone browser-based test harness (no Electron needed) —
  same logic as the overlay but runs in a plain Chrome tab, with a visible debug log. This
  was essential for isolating bugs from Electron packaging issues, and is fully working.

---

## 2. Current provider configuration

Default and currently in use (both free, no credit card required):
- **STT_PROVIDER=deepgram** — Deepgram streaming transcription (free signup credit)
- **LLM_PROVIDER=gemini** — Google Gemini 2.5 Flash (genuinely free tier, ~10-15 req/min,
  1500/day, no card required via aistudio.google.com/apikey)

Also implemented and switchable via `.env` with zero code changes:
- STT_PROVIDER=openai (OpenAI's realtime transcription API — implemented and working,
  requires OpenAI billing credit, uses model `gpt-4o-transcribe`)
- LLM_PROVIDER=anthropic (Claude, model `claude-sonnet-4-6`)
- LLM_PROVIDER=openai (GPT-4o)

**Important:** the screenshot-solving features (`answer_from_screenshot` and
`answer_from_screenshot_sequence`) are currently **hardcoded to require
LLM_PROVIDER=gemini** — they weren't extended to Anthropic/OpenAI vision. If the LLM
provider is switched away from Gemini, screenshot solving will just error out with a
message saying so, but voice Q&A will still work fine on the other provider.

---

## 3. Environment-specific issues already solved (do not re-debug these)

These took a long time to work through and are now resolved. Documenting so a future
assistant doesn't repeat the same debugging loop:

### 3.1 `.env` not loading
FastAPI/Python doesn't auto-load `.env` files. Fixed by adding `python-dotenv` and calling
`load_dotenv()` at the top of `main.py` before reading any env vars.

### 3.2 `websockets` library API change
The installed version of the `websockets` Python package uses `additional_headers=` instead
of the older `extra_headers=` parameter for `websockets.connect()`. Both STT connection
functions in `main.py` already use `additional_headers=` — correct as-is.

### 3.3 OpenAI Realtime API protocol changed since original training data
As of mid-2026, OpenAI's realtime API works differently than older documentation describes:
- Connect via `wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1` (not the old
  `?intent=transcription` shortcut)
- Configure the session via a `session.update` event with a nested schema:
  `session.type = "transcription"`, `session.audio.input.format = {"type": "audio/pcm",
  "rate": 24000}`, `session.audio.input.transcription.model = "gpt-4o-transcribe"`
- Required audio sample rate is **24000 Hz**, not 16000 Hz (this is why both Deepgram's URL
  and the client-side downsampling target 24000 now — kept consistent across both providers
  even though Deepgram doesn't strictly require it)
- No `OpenAI-Beta: realtime=v1` header needed anymore
- `turn_detection` is set to `null` (manual mode) — the client does its own silence
  detection (RMS-based, see `overlay.js`) and sends `{"type": "input_audio_buffer.commit"}`
  when it detects the interviewer stopped talking, since the older automatic VAD schema
  wasn't reliable to guess at from stale docs
- OpenAI's realtime connection **force-closes every session at 60 minutes** (hard
  server-side cap) — handled via `listen_stt_forever()` which auto-reconnects transparently
  on any `ConnectionClosed`, so long interview sessions don't lose transcription

### 3.4 macOS-specific Electron installation nightmare
This consumed the most debugging time. In order, the actual sequence of problems and fixes:

1. **npm's `allow-scripts` blocked Electron's postinstall script** silently. Fix:
   `npm approve-scripts electron` (must be re-run after every full `rm -rf node_modules`).
2. **`Electron failed to install correctly` error** — caused by a missing
   `node_modules/electron/path.txt` file (npm's install script wasn't completing). This file
   must contain exactly `Electron.app/Contents/MacOS/Electron` with **no trailing newline**
   (use `printf`, not `echo`, when creating it manually — `echo` adds a newline that breaks
   the path).
3. **macOS's built-in XProtect malware scanner was silently deleting the downloaded
   Electron.app** (or specifically its internal `Electron Framework` component) immediately
   after extraction, with zero error output from npm — it just silently produced an empty
   `dist/` folder. This was diagnosed by running `DEBUG=* node node_modules/electron/install.js`
   directly, which showed the real extraction happening in detail (vs. npm's silent wrapper).
4. **Bumped Electron from ^31.0.0 to ^33.0.0** in `package.json` hoping a newer version
   wouldn't be flagged — helped partially (got further) but macOS still eventually rejected
   it with "Electron is damaged and can't be opened" (Gatekeeper rejecting an ad-hoc-signed
   binary) even via a fresh Homebrew Cask install (`brew install --cask electron`), which
   itself printed: *"Warning: electron has been deprecated because it does not pass the
   macOS Gatekeeper check! It will be disabled on 2026-09-01."*
5. **Final working fix:**
   ```bash
   brew install --cask electron
   xattr -cr /Applications/Electron.app   # strips the quarantine flag causing Gatekeeper's block
   export ELECTRON_OVERRIDE_DIST_PATH=/Applications
   npm start
   ```
   `ELECTRON_OVERRIDE_DIST_PATH` tells the `electron` npm package to use the
   Homebrew-installed, already-trusted copy instead of downloading (and getting blocked on)
   its own. **This env var must be re-exported in every new terminal session** before
   `npm start` — it does not persist. (Could be made permanent by adding the export line to
   `~/.zshrc` — not yet done.)

This got the real Electron overlay running successfully (confirmed working by the user).

### 3.5 BlackHole / audio routing conceptual confusion (resolved, worth knowing)
BlackHole only captures **system output audio** (what's playing through speakers — a video,
a call), not microphone/room audio. Several rounds of "no answer coming through" were
traced back to the user speaking out loud (which BlackHole can't hear) instead of playing
audio through the Mac. Setup used: BlackHole 2ch (installed via `brew install
blackhole-2ch`) + a Multi-Output Device (Audio MIDI Setup → created combining normal
output + BlackHole 2ch) selected as the Mac's system output. To also allow testing/live use
by speaking, the app supports **mixing a second input device** (e.g. the built-in mic)
alongside BlackHole — both `overlay.js` and `test.html` have a second device dropdown for
this, connected to the same Web Audio processor node so both sources sum together.

### 3.6 Backend crash on dropped STT connection (real bug, fixed)
Originally, if the Deepgram/OpenAI STT websocket dropped, `pump_audio()` would throw an
uncaught `ConnectionClosed` exception that crashed the whole FastAPI session handler
(cascading into a `RuntimeError` on the next `receive()` call). Fixed by wrapping all
`stt_ws.send()` calls in try/except for `ConnectionClosed`, and by checking for
`message.get("type") == "websocket.disconnect"` explicitly in the main receive loop, plus
catching `RuntimeError` alongside `WebSocketDisconnect` at the top level.

---

## 4. Current open issue (unresolved — where to pick up)

**Symptom:** In the real Electron overlay app (not `test.html`, which works fine), audio
isn't reaching the backend at all — Deepgram repeatedly logs:
```
[stt] connection dropped (received 1011 (internal error) Deepgram did not receive audio
data or a text message within the timeout window...); reconnecting...
```
This is the exact same "no audio arriving" signature seen earlier when the issue was
BlackHole/output routing — but this time it's happening in the packaged Electron app
specifically, after `test.html` in a regular Chrome tab was already confirmed fully working
with the same BlackHole setup.

**Leading hypothesis (not yet confirmed):** macOS requires **separate microphone
permission per application** — the permission granted to Chrome (for `test.html`) does not
carry over to the Electron app, which is a distinct application as far as macOS's Privacy &
Security settings are concerned. The Electron app may need its own mic permission grant, or
may have been silently denied one.

**Next diagnostic steps (given to the user, not yet confirmed as fixed):**
1. Check System Settings → Privacy & Security → Microphone — is "Electron" listed, and is
   its toggle ON?
2. If not listed: fully quit the app (via tray → Quit) and relaunch with `npm start` to
   re-trigger the permission prompt.
3. Re-verify the device dropdown *inside the Electron overlay's own Settings panel* actually
   has BlackHole 2ch selected (this is a separate app from Chrome, so localStorage/settings
   don't carry over from `test.html`).
4. Also worth checking: Screen Recording permission (needed separately for the
   screenshot-reading feature) under the same Privacy & Security pane.

This is where the next assistant should start.

---

## 5. Features implemented

- Real-time audio capture → streaming transcription → streaming AI answer, end to end
- Manual "Get Answer" button + global hotkey (Cmd/Ctrl+Shift+A) — forces an answer from
  the last transcript even if silence-detection/endpointing hasn't fired yet
- **Screen reading for coding questions**: click "Read Screen" (or Cmd/Ctrl+Shift+S) to
  start a **burst capture** — grabs a screenshot every ~900ms for up to 10 frames (~9
  seconds) while the user scrolls through a problem that doesn't fit on one screen, then
  combines all frames into a single Gemini vision request that reconstructs the full
  problem and solves it. (Single-shot `answer_from_screenshot` also still exists as a
  method but the UI now always uses the burst/sequence version.)
- **Typed-question fallback**: a text input + "Ask" button (Enter also works) at the bottom
  of the overlay, for when audio didn't transcribe correctly — mirrors a feature seen in
  actual Parakeet AI's UI (its "Chat" button, per user-provided screenshots)
- **Clear button**: resets the displayed question/answer and the server-side transcript
  buffer
- Screen-share invisibility via Electron's `setContentProtection(true)` — confirmed to also
  exclude the overlay from its own screenshot captures (nice side effect: the overlay never
  accidentally screenshots itself)
- Background operation via system tray (closing the window just hides it; only Quit from
  the tray fully exits)
- Global hotkeys: Cmd/Ctrl+Shift+O (show/hide), +L (start/stop listening), +A (manual
  answer), +S (read screen)
- Mixing a second audio input (e.g. mic) alongside the main device, for testing/flexibility
- Provider-agnostic backend (swap STT/LLM providers via `.env`, zero code changes needed
  for already-implemented providers)
- Auto-reconnect for STT connections that drop (handles OpenAI's 60-min cap and any network
  blips) without losing the user-facing session

## 6. Known gaps / explicitly not done

- Windows and Linux audio-routing setup (VB-CABLE / PulseAudio monitor) is documented in
  `README.md` but **never actually tested** — only macOS has been verified end-to-end
- Screenshot-solving only works when `LLM_PROVIDER=gemini` (see §2)
- No persistence of past sessions/transcripts (no database)
- `ScriptProcessorNode` (deprecated Web Audio API) is used for audio processing instead of
  the modern `AudioWorklet` — a deliberate simplicity tradeoff for a single-user tool, noted
  in code comments
- Current open bug in §4 blocking full end-to-end use of the real overlay app

---

## 7. Complete current file contents

### `package.json`
```json
{
  "name": "interview-copilot",
  "version": "0.1.0",
  "description": "Personal live interview copilot (Parakeet-style) — system audio capture, real-time transcription, AI-generated answers, screen-share-invisible overlay.",
  "main": "electron/main.js",
  "scripts": {
    "start": "electron .",
    "backend": "cd backend && uvicorn main:app --host 127.0.0.1 --port 8765"
  },
  "author": "",
  "license": "MIT",
  "devDependencies": {
    "electron": "^33.0.0"
  }
}
```

### `backend/requirements.txt`
```
fastapi==0.115.0
uvicorn[standard]==0.30.6
websockets==13.1
anthropic==0.34.2
openai==1.51.0
python-dotenv==1.0.1
google-genai==1.3.0
```

### `backend/.env.example`
```
# STT_PROVIDER: deepgram | openai
# LLM_PROVIDER: gemini | anthropic | openai
STT_PROVIDER=deepgram
LLM_PROVIDER=gemini

# Free options (no credit card needed):
DEEPGRAM_API_KEY=your_deepgram_key_here
GEMINI_API_KEY=your_gemini_key_here

# Only needed if you switch a provider above back to these:
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
```
(The user's actual `backend/.env` has real keys filled in for Deepgram + Gemini, confirmed
working via the `/health` endpoint showing both as `configured: true`.)

### `electron/main.js`
```javascript
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, screen, desktopCapturer } = require('electron');
const path = require('path');

let overlayWindow = null;
let tray = null;
let isListening = false;

// 16x16 transparent-ish dot icon, base64, so we don't depend on an external asset file.
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOElEQVR4Ae3OMQoAIAwDwPz' +
  '/06Kj4uLg0EJyU2gG1UpV8QIAAAAAAAAAAAAAAAAAAADAWwOU3AGVQZoCFQAAAABJRU5ErkJggg==';

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
  createOverlayWindow();
  createTray();

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
});

ipcMain.handle('get-listening-state', () => isListening);

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
  return primary.thumbnail.toPNG().toString('base64');
});
```

### `electron/preload.js`
```javascript
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('copilot', {
  onListeningToggled: (cb) => ipcRenderer.on('listening-toggled', (_e, val) => cb(val)),
  onManualTrigger: (cb) => ipcRenderer.on('manual-trigger', () => cb()),
  onScreenshotTrigger: (cb) => ipcRenderer.on('screenshot-trigger', () => cb()),
  getListeningState: () => ipcRenderer.invoke('get-listening-state'),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
});
```

### `renderer/overlay.html`
```html
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  html, body {
    margin: 0; padding: 0; background: transparent;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-app-region: drag; /* whole window draggable by default */
    user-select: none;
  }
  #panel {
    background: rgba(20, 20, 24, 0.88);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px;
    color: #eaeaea;
    height: 100vh;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  #topbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 10px; font-size: 12px; font-weight: 600;
    border-bottom: 1px solid rgba(255,255,255,0.06);
  }
  #status-dot { width: 8px; height: 8px; border-radius: 50%; background: #555; margin-right: 6px; display: inline-block; }
  #status-dot.live { background: #3ecf6e; }
  .no-drag { -webkit-app-region: no-drag; }
  #controls { display: flex; gap: 6px; }
  button {
    background: rgba(255,255,255,0.08); border: none; color: #eaeaea;
    border-radius: 5px; padding: 3px 7px; font-size: 11px; cursor: pointer;
  }
  button:hover { background: rgba(255,255,255,0.16); }
  #body { flex: 1; overflow-y: auto; padding: 10px; font-size: 13px; line-height: 1.45; -webkit-app-region: no-drag; }
  #question { color: #9fb8ff; font-size: 12px; margin-bottom: 6px; min-height: 14px; }
  #answer { white-space: pre-wrap; }
  #settings { display: none; padding: 10px; border-top: 1px solid rgba(255,255,255,0.06); -webkit-app-region: no-drag; }
  #settings.open { display: block; }
  select, textarea {
    width: 100%; box-sizing: border-box; background: #1c1c22; color: #eaeaea;
    border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 5px; font-size: 11px; margin-top: 4px;
  }
  label { font-size: 11px; color: #9a9a9a; }
  #typebar {
    display: flex; gap: 6px; padding: 8px 10px;
    border-top: 1px solid rgba(255,255,255,0.06);
  }
  #type-input {
    flex: 1; background: #1c1c22; color: #eaeaea;
    border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;
    padding: 5px 8px; font-size: 12px;
  }
  #type-input::placeholder { color: #666; }
</style>
</head>
<body>
  <div id="panel">
    <div id="topbar">
      <div><span id="status-dot"></span><span id="status-text">Idle</span></div>
      <div id="controls" class="no-drag">
        <button id="btn-listen">Start</button>
        <button id="btn-answer">Get Answer</button>
        <button id="btn-screenshot">Read Screen</button>
        <button id="btn-clear">Clear</button>
        <button id="btn-settings">Settings</button>
      </div>
    </div>
    <div id="body">
      <div id="question"></div>
      <div id="answer">Press Start, select your loopback/monitor audio device in Settings, then speak — answers appear here.</div>
    </div>
    <div id="typebar" class="no-drag">
      <input id="type-input" type="text" placeholder="Type a question if audio didn't catch it..." />
      <button id="btn-type-send">Ask</button>
    </div>
    <div id="settings">
      <label>Audio input device (route your system/meeting audio here — BlackHole on Mac, WASAPI loopback device on Windows, monitor source on Linux)</label>
      <select id="device-select"></select>
      <label>Also capture this device (optional — e.g. your mic, so you can test by speaking)</label>
      <select id="device-select-2"><option value="">None</option></select>
      <label>Resume (pasted text)</label>
      <textarea id="resume" rows="4"></textarea>
      <label>Job description (pasted text)</label>
      <textarea id="jd" rows="4"></textarea>
      <button id="btn-save" style="margin-top:6px;">Save</button>
    </div>
  </div>
  <script src="overlay.js"></script>
</body>
</html>
```

### `renderer/overlay.js`
```javascript
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const btnListen = document.getElementById('btn-listen');
const btnAnswer = document.getElementById('btn-answer');
const btnScreenshot = document.getElementById('btn-screenshot');
const btnClear = document.getElementById('btn-clear');
const typeInput = document.getElementById('type-input');
const btnTypeSend = document.getElementById('btn-type-send');
const btnSettings = document.getElementById('btn-settings');
const settingsPanel = document.getElementById('settings');
const deviceSelect = document.getElementById('device-select');
const deviceSelect2 = document.getElementById('device-select-2');
const resumeBox = document.getElementById('resume');
const jdBox = document.getElementById('jd');
const btnSave = document.getElementById('btn-save');
const questionEl = document.getElementById('question');
const answerEl = document.getElementById('answer');

const BACKEND_WS = 'ws://127.0.0.1:8765/ws/session';

let ws = null;
let audioCtx = null;
let sourceNode = null;
let sourceNode2 = null;
let processorNode = null;
let mediaStream = null;
let mediaStream2 = null;
let listening = false;
let capturingScreen = false;
let screenFrames = [];
let screenCaptureInterval = null;

// --- persistence (plain localStorage — this is a real desktop app, not a sandboxed artifact) ---
resumeBox.value = localStorage.getItem('resume') || '';
jdBox.value = localStorage.getItem('jd') || '';
btnSave.onclick = () => {
  localStorage.setItem('resume', resumeBox.value);
  localStorage.setItem('jd', jdBox.value);
  localStorage.setItem('deviceId', deviceSelect.value);
  localStorage.setItem('deviceId2', deviceSelect2.value);
  btnSave.textContent = 'Saved';
  setTimeout(() => (btnSave.textContent = 'Save'), 1000);
};

btnSettings.onclick = () => settingsPanel.classList.toggle('open');

// --- populate audio input devices ---
async function loadDevices() {
  // Requesting a throwaway getUserMedia first is required in Chromium before
  // device labels are populated.
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (e) {
    console.warn('Mic permission needed to list devices', e);
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  deviceSelect.innerHTML = '';
  deviceSelect2.innerHTML = '<option value="">None</option>';
  devices
    .filter((d) => d.kind === 'audioinput')
    .forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || 'Input device';
      deviceSelect.appendChild(opt);
      deviceSelect2.appendChild(opt.cloneNode(true));
    });
  const saved = localStorage.getItem('deviceId');
  if (saved) deviceSelect.value = saved;
  const saved2 = localStorage.getItem('deviceId2');
  if (saved2) deviceSelect2.value = saved2;
}
loadDevices();

// --- downsample Float32 [-1,1] audio to 24kHz PCM16 (required sample rate for
// both Deepgram and OpenAI's current realtime transcription API) ---
function floatTo16BitPCM(input, inSampleRate, outSampleRate) {
  const ratio = inSampleRate / outSampleRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Client-side silence detection: used to trigger OpenAI's input_audio_buffer.commit
// when that provider is active (its turn detection is off; Deepgram has its own
// endpointing and ignores the 'commit' message harmlessly).
const SILENCE_RMS_THRESHOLD = 0.01;
const SILENCE_MS_BEFORE_COMMIT = 700;
let hasSpeechSinceCommit = false;
let lastSpeechTime = 0;

function rms(float32arr) {
  let sum = 0;
  for (let i = 0; i < float32arr.length; i++) sum += float32arr[i] * float32arr[i];
  return Math.sqrt(sum / float32arr.length);
}

async function startListening() {
  const deviceId = deviceSelect.value;
  const deviceId2 = deviceSelect2.value;
  if (!deviceId) {
    setStatus('No input device selected', false);
    return;
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false },
  });

  audioCtx = new AudioContext();
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  // ScriptProcessorNode is deprecated but simplest for a single-user personal tool;
  // swap for an AudioWorklet if you want to modernize later.
  processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
  sourceNode.connect(processorNode);

  // Optional second input (e.g. your mic) — connecting it to the same processor
  // node mixes both sources together automatically.
  if (deviceId2) {
    mediaStream2 = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId2 }, echoCancellation: false, noiseSuppression: false },
    });
    sourceNode2 = audioCtx.createMediaStreamSource(mediaStream2);
    sourceNode2.connect(processorNode);
  }

  ws = new WebSocket(BACKEND_WS);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    // Send context (resume/JD) once at session start
    ws.send(JSON.stringify({ type: 'context', resume: resumeBox.value, jd: jdBox.value }));
    setStatus('Listening', true);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'transcript') {
      questionEl.textContent = msg.text;
    } else if (msg.type === 'answer_chunk') {
      answerEl.textContent += msg.text;
    } else if (msg.type === 'answer_start') {
      answerEl.textContent = '';
    } else if (msg.type === 'error') {
      answerEl.textContent = 'Error: ' + msg.message;
    }
  };

  ws.onclose = () => setStatus('Disconnected', false);
  ws.onerror = () => setStatus('Connection error', false);

  processorNode.onaudioprocess = (e) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = floatTo16BitPCM(input, audioCtx.sampleRate, 24000);
    ws.send(pcm16.buffer);

    const level = rms(input);
    const now = performance.now();
    if (level > SILENCE_RMS_THRESHOLD) {
      hasSpeechSinceCommit = true;
      lastSpeechTime = now;
    } else if (hasSpeechSinceCommit && now - lastSpeechTime > SILENCE_MS_BEFORE_COMMIT) {
      ws.send(JSON.stringify({ type: 'commit' }));
      hasSpeechSinceCommit = false;
    }
  };

  processorNode.connect(audioCtx.destination);

  listening = true;
  btnListen.textContent = 'Stop';
}

function stopListening() {
  if (processorNode) processorNode.disconnect();
  if (sourceNode) sourceNode.disconnect();
  if (sourceNode2) sourceNode2.disconnect();
  if (audioCtx) audioCtx.close();
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  if (mediaStream2) mediaStream2.getTracks().forEach((t) => t.stop());
  if (ws) ws.close();
  listening = false;
  btnListen.textContent = 'Start';
  setStatus('Idle', false);
}

function setStatus(text, live) {
  statusText.textContent = text;
  statusDot.classList.toggle('live', !!live);
}

btnListen.onclick = () => (listening ? stopListening() : startListening());

btnAnswer.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'manual_trigger' }));
  }
};

async function solveFromScreen() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setStatus('Not connected — click Start first', false);
    return;
  }
  if (!window.copilot || !window.copilot.captureScreen) {
    answerEl.textContent = 'Error: screen capture is only available in the desktop app.';
    return;
  }

  if (capturingScreen) {
    // Second click — stop early and send whatever was captured so far.
    stopScreenCapture();
    return;
  }

  // Start a capture burst: grab a frame every ~900ms for up to MAX_FRAMES frames
  // (roughly 9 seconds), so the user has time to scroll through a problem that
  // doesn't fit on one screen. Click the button again to stop early once they've
  // scrolled through everything.
  capturingScreen = true;
  screenFrames = [];
  btnScreenshot.textContent = 'Stop (0)';
  answerEl.textContent = 'Capturing — scroll through the problem now, click again when done...';

  const MAX_FRAMES = 10;
  screenCaptureInterval = setInterval(async () => {
    const base64Png = await window.copilot.captureScreen();
    if (base64Png) {
      screenFrames.push(base64Png);
      btnScreenshot.textContent = `Stop (${screenFrames.length})`;
    }
    if (screenFrames.length >= MAX_FRAMES) {
      stopScreenCapture();
    }
  }, 900);

  // Grab the first frame immediately rather than waiting for the first interval tick.
  const firstFrame = await window.copilot.captureScreen();
  if (firstFrame) {
    screenFrames.push(firstFrame);
    btnScreenshot.textContent = `Stop (${screenFrames.length})`;
  }
}

function stopScreenCapture() {
  capturingScreen = false;
  if (screenCaptureInterval) {
    clearInterval(screenCaptureInterval);
    screenCaptureInterval = null;
  }
  btnScreenshot.textContent = 'Read Screen';

  if (screenFrames.length === 0) {
    answerEl.textContent = 'Error: no frames captured.';
    return;
  }
  ws.send(JSON.stringify({ type: 'screenshot_sequence', images: screenFrames }));
  screenFrames = [];
}

btnScreenshot.onclick = solveFromScreen;

btnClear.onclick = () => {
  questionEl.textContent = '';
  answerEl.textContent = '';
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'clear' }));
  }
};

function sendTypedQuestion() {
  const text = typeInput.value.trim();
  if (!text) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setStatus('Not connected — click Start first', false);
    return;
  }
  questionEl.textContent = text;
  ws.send(JSON.stringify({ type: 'manual_text_question', text }));
  typeInput.value = '';
}

btnTypeSend.onclick = sendTypedQuestion;
typeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendTypedQuestion();
});

// Wire up global hotkeys forwarded from main process
if (window.copilot) {
  window.copilot.onListeningToggled((state) => {
    if (state && !listening) startListening();
    if (!state && listening) stopListening();
  });
  window.copilot.onManualTrigger(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'manual_trigger' }));
    }
  });
  window.copilot.onScreenshotTrigger(() => {
    solveFromScreen();
  });
}
```

### `renderer/test.html` (browser-only test harness, fully working, no Electron needed)
```html
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Interview Copilot - Browser Test</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #14141a; color: #eaeaea; padding: 20px; max-width: 600px; margin: 0 auto; }
  h2 { font-size: 16px; }
  #status-dot { width: 10px; height: 10px; border-radius: 50%; background: #555; display: inline-block; margin-right: 8px; }
  #status-dot.live { background: #3ecf6e; }
  select, textarea, button { width: 100%; box-sizing: border-box; background: #1c1c22; color: #eaeaea; border: 1px solid #333; border-radius: 6px; padding: 8px; margin-top: 6px; font-size: 13px; }
  button { background: #2a2a35; cursor: pointer; margin-top: 12px; }
  button:hover { background: #35354a; }
  label { font-size: 12px; color: #999; margin-top: 12px; display: block; }
  #question { color: #9fb8ff; margin-top: 16px; font-size: 13px; }
  #answer { white-space: pre-wrap; margin-top: 6px; line-height: 1.5; }
</style>
</head>
<body>
  <h2><span id="status-dot"></span><span id="status-text">Idle</span> — Interview Copilot (browser test, not the real overlay)</h2>

  <label>Audio input device — pick BlackHole 2ch (captures system/meeting audio)</label>
  <select id="device-select"></select>

  <label>Also capture this device (optional — e.g. your mic, so you can test by speaking)</label>
  <select id="device-select-2">
    <option value="">None</option>
  </select>

  <label>Resume (paste text)</label>
  <textarea id="resume" rows="4"></textarea>

  <label>Job description (paste text)</label>
  <textarea id="jd" rows="4"></textarea>

  <button id="btn-listen">Start Listening</button>
  <button id="btn-get-answer" style="margin-top:6px;">Get Answer (manual)</button>

  <div id="question"></div>
  <div id="answer">Answers will appear here once you click Start and audio plays through BlackHole.</div>

  <label style="margin-top:16px;">Debug log (raw messages from backend)</label>
  <div id="debug-log" style="background:#0c0c10; border:1px solid #333; border-radius:6px; padding:8px; font-size:11px; font-family:monospace; height:150px; overflow-y:auto; white-space:pre-wrap;"></div>

<script>
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const btnListen = document.getElementById('btn-listen');
const btnGetAnswer = document.getElementById('btn-get-answer');
const deviceSelect = document.getElementById('device-select');
const deviceSelect2 = document.getElementById('device-select-2');
const resumeBox = document.getElementById('resume');
const jdBox = document.getElementById('jd');
const questionEl = document.getElementById('question');
const answerEl = document.getElementById('answer');
const debugLog = document.getElementById('debug-log');

function logDebug(msg) {
  const time = new Date().toLocaleTimeString();
  debugLog.textContent += `[${time}] ${msg}\n`;
  debugLog.scrollTop = debugLog.scrollHeight;
}

const BACKEND_WS = 'ws://127.0.0.1:8765/ws/session';
let ws = null, audioCtx = null, sourceNode = null, sourceNode2 = null, processorNode = null, mediaStream = null, mediaStream2 = null, listening = false;

async function loadDevices() {
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (e) { console.warn('Mic permission needed', e); }
  const devices = await navigator.mediaDevices.enumerateDevices();
  deviceSelect.innerHTML = '';
  deviceSelect2.innerHTML = '<option value="">None</option>';
  devices.filter((d) => d.kind === 'audioinput').forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || 'Input device';
    deviceSelect.appendChild(opt);
    deviceSelect2.appendChild(opt.cloneNode(true));
  });
}
loadDevices();

function floatTo16BitPCM(input, inRate, outRate) {
  const ratio = inRate / outRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Simple client-side silence detection: OpenAI's transcription session has automatic
// turn detection turned off (backend config), so we decide when the interviewer has
// stopped talking and tell the backend to finalize that turn.
const SILENCE_RMS_THRESHOLD = 0.01;
const SILENCE_MS_BEFORE_COMMIT = 700;
let hasSpeechSinceCommit = false;
let lastSpeechTime = 0;

function rms(float32arr) {
  let sum = 0;
  for (let i = 0; i < float32arr.length; i++) sum += float32arr[i] * float32arr[i];
  return Math.sqrt(sum / float32arr.length);
}

async function startListening() {
  const deviceId = deviceSelect.value;
  const deviceId2 = deviceSelect2.value;
  if (!deviceId) { setStatus('No device selected', false); return; }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false },
  });
  audioCtx = new AudioContext();
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
  sourceNode.connect(processorNode);

  // Optional second input (e.g. your mic) — connecting it to the same processor
  // node mixes both sources together automatically, no extra code needed.
  if (deviceId2) {
    mediaStream2 = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId2 }, echoCancellation: false, noiseSuppression: false },
    });
    sourceNode2 = audioCtx.createMediaStreamSource(mediaStream2);
    sourceNode2.connect(processorNode);
    logDebug('Mixing in second input device (mic).');
  }

  ws = new WebSocket(BACKEND_WS);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'context', resume: resumeBox.value, jd: jdBox.value }));
    setStatus('Listening', true);
    logDebug('WebSocket connected, context sent.');
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    logDebug('Received: ' + event.data.slice(0, 200));
    if (msg.type === 'transcript') questionEl.textContent = msg.text;
    else if (msg.type === 'answer_chunk') answerEl.textContent += msg.text;
    else if (msg.type === 'answer_start') answerEl.textContent = '';
    else if (msg.type === 'error') answerEl.textContent = 'Error: ' + msg.message;
  };
  ws.onclose = () => { setStatus('Disconnected', false); logDebug('WebSocket closed.'); };
  ws.onerror = () => { setStatus('Connection error', false); logDebug('WebSocket error.'); };

  let lastLevelLog = 0;
  processorNode.onaudioprocess = (e) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = floatTo16BitPCM(input, audioCtx.sampleRate, 24000);
    ws.send(pcm16.buffer);

    // Silence detection to trigger OpenAI's input_audio_buffer.commit
    const level = rms(input);
    const now = performance.now();
    if (now - lastLevelLog > 1000) {
      logDebug(`Audio level (RMS): ${level.toFixed(4)} ${level > SILENCE_RMS_THRESHOLD ? '(speech detected)' : '(quiet)'}`);
      lastLevelLog = now;
    }
    if (level > SILENCE_RMS_THRESHOLD) {
      hasSpeechSinceCommit = true;
      lastSpeechTime = now;
    } else if (hasSpeechSinceCommit && now - lastSpeechTime > SILENCE_MS_BEFORE_COMMIT) {
      ws.send(JSON.stringify({ type: 'commit' }));
      hasSpeechSinceCommit = false;
    }
  };
  processorNode.connect(audioCtx.destination);
  listening = true;
  btnListen.textContent = 'Stop Listening';
}

function stopListening() {
  if (processorNode) processorNode.disconnect();
  if (sourceNode) sourceNode.disconnect();
  if (sourceNode2) sourceNode2.disconnect();
  if (audioCtx) audioCtx.close();
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  if (mediaStream2) mediaStream2.getTracks().forEach((t) => t.stop());
  if (ws) ws.close();
  listening = false;
  btnListen.textContent = 'Start Listening';
  setStatus('Idle', false);
}

function setStatus(text, live) {
  statusText.textContent = text;
  statusDot.classList.toggle('live', !!live);
}

btnListen.onclick = () => (listening ? stopListening() : startListening());

btnGetAnswer.onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'manual_trigger' }));
    logDebug('Sent manual_trigger.');
  } else {
    logDebug('Not connected — click Start Listening first.');
  }
};
</script>
</body>
</html>
```

### `backend/main.py`
```python
"""
Interview Copilot backend.

Bridges: browser (Electron overlay) --audio(PCM16)--> this server --> STT provider (streaming)
                                                                    --> on finalized question --> LLM provider (streaming) --> back to overlay

Provider-agnostic: set STT_PROVIDER and LLM_PROVIDER in .env to switch without code changes.
  STT_PROVIDER = deepgram | openai
  LLM_PROVIDER = gemini | anthropic | openai

Run with:
    uvicorn main:app --host 127.0.0.1 --port 8765
"""

import asyncio
import json
import os

import websockets
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

load_dotenv()  # reads backend/.env into os.environ — must happen before reading keys below

app = FastAPI()

STT_PROVIDER = os.environ.get("STT_PROVIDER", "deepgram").lower()
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "gemini").lower()

DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY", "")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")

DEEPGRAM_URL = (
    "wss://api.deepgram.com/v1/listen"
    "?encoding=linear16&sample_rate=24000&channels=1"
    "&punctuate=true&interim_results=true&endpointing=500"
)

# Realtime API connection. As of mid-2026, OpenAI connects with a model query param,
# then configures the session as transcription-type via a session.update event
# (the older ?intent=transcription shortcut is no longer reliable).
OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1"

anthropic_client = None
openai_client = None
gemini_client = None

if LLM_PROVIDER == "anthropic" and ANTHROPIC_API_KEY:
    from anthropic import AsyncAnthropic
    anthropic_client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)

if LLM_PROVIDER == "openai" and OPENAI_API_KEY:
    from openai import AsyncOpenAI
    openai_client = AsyncOpenAI(api_key=OPENAI_API_KEY)

if LLM_PROVIDER == "gemini" and GEMINI_API_KEY:
    from google import genai
    gemini_client = genai.Client(api_key=GEMINI_API_KEY)


def build_system_prompt(resume: str, jd: str) -> str:
    return (
        "You are a live interview answer assistant. The user is in a real-time job "
        "interview and needs a spoken-style answer FAST.\n"
        "Rules:\n"
        "- Answer directly, first person, as if the candidate is speaking.\n"
        "- Keep it concise: 3-6 sentences for behavioral questions, or working code/"
        "steps for technical ones. Never pad with filler.\n"
        "- Ground answers in the candidate's actual background below — do not invent "
        "experience that isn't supported by it.\n"
        "- If the question is ambiguous, give the most likely useful answer rather than "
        "asking for clarification (there's no time to ask back).\n\n"
        f"CANDIDATE RESUME:\n{resume or '(not provided)'}\n\n"
        f"JOB DESCRIPTION:\n{jd or '(not provided)'}\n"
    )


class Session:
    def __init__(self, client_ws: WebSocket):
        self.client_ws = client_ws
        self.resume = ""
        self.jd = ""
        self.system_prompt = build_system_prompt("", "")
        self.stt_ws = None
        self.last_transcript = ""

    # ---------------- STT: connect ----------------

    async def connect_stt(self):
        if STT_PROVIDER == "deepgram":
            await self._connect_deepgram()
        elif STT_PROVIDER == "openai":
            await self._connect_openai_realtime()
        else:
            await self._send_error(f"Unknown STT_PROVIDER '{STT_PROVIDER}'")

    async def _connect_deepgram(self):
        if not DEEPGRAM_API_KEY:
            await self._send_error("DEEPGRAM_API_KEY is not set on the backend.")
            return
        self.stt_ws = await websockets.connect(
            DEEPGRAM_URL,
            additional_headers={"Authorization": f"Token {DEEPGRAM_API_KEY}"},
        )

    async def _connect_openai_realtime(self):
        if not OPENAI_API_KEY:
            await self._send_error("OPENAI_API_KEY is not set on the backend.")
            return
        self.stt_ws = await websockets.connect(
            OPENAI_REALTIME_URL,
            additional_headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
            open_timeout=20,
        )
        # Configure as a transcription-only session: 24kHz PCM input (required by the
        # current API), automatic turn detection off — we detect silence client-side
        # and send input_audio_buffer.commit ourselves.
        await self.stt_ws.send(json.dumps({
            "type": "session.update",
            "session": {
                "type": "transcription",
                "audio": {
                    "input": {
                        "format": {"type": "audio/pcm", "rate": 24000},
                        "transcription": {"model": "gpt-4o-transcribe"},
                        "turn_detection": None,
                    }
                },
            },
        }))

    # ---------------- STT: audio in ----------------

    async def pump_audio(self, chunk: bytes):
        if self.stt_ws is None:
            return
        try:
            if STT_PROVIDER == "openai":
                import base64
                await self.stt_ws.send(json.dumps({
                    "type": "input_audio_buffer.append",
                    "audio": base64.b64encode(chunk).decode("ascii"),
                }))
            else:
                await self.stt_ws.send(chunk)
        except websockets.exceptions.ConnectionClosed:
            # The reconnect loop (listen_stt_forever) will replace self.stt_ws shortly —
            # just drop this chunk instead of crashing the whole session.
            pass

    async def commit_audio(self):
        """OpenAI's transcription session (turn_detection: null) requires us to
        explicitly tell it a turn is finished — the client detects silence and
        calls this. Deepgram doesn't need this (it has its own endpointing)."""
        if self.stt_ws is not None and STT_PROVIDER == "openai":
            try:
                await self.stt_ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
            except websockets.exceptions.ConnectionClosed:
                pass

    # ---------------- STT: transcripts out ----------------

    async def listen_stt_forever(self):
        """Keeps transcription alive indefinitely. OpenAI's realtime endpoint force-closes
        every session at 60 minutes (a hard server-side cap, not a bug) — Deepgram doesn't
        have this limit but network drops can still happen. Either way, reconnect
        transparently so a 1-2 hour interview never actually stops listening."""
        while True:
            try:
                if STT_PROVIDER == "deepgram":
                    await self._listen_deepgram()
                elif STT_PROVIDER == "openai":
                    await self._listen_openai_realtime()
                return  # clean close (client disconnected) — stop reconnecting
            except (websockets.exceptions.ConnectionClosed, ConnectionError) as exc:
                print(f"[stt] connection dropped ({exc}); reconnecting...")
                await asyncio.sleep(0.5)
                try:
                    await self.connect_stt()
                except Exception as reconnect_exc:  # noqa: BLE001
                    await self._send_error(f"STT reconnect failed: {reconnect_exc}")
                    return

    async def _listen_deepgram(self):
        assert self.stt_ws is not None
        async for raw in self.stt_ws:
            data = json.loads(raw)
            alt = data.get("channel", {}).get("alternatives", [{}])[0]
            text = alt.get("transcript", "")
            if not text:
                continue
            self.last_transcript = text
            await self.client_ws.send_text(json.dumps({"type": "transcript", "text": text}))
            if data.get("speech_final"):
                await self.generate_answer(text)

    async def _listen_openai_realtime(self):
        assert self.stt_ws is not None
        async for raw in self.stt_ws:
            data = json.loads(raw)
            event_type = data.get("type", "")

            if event_type == "conversation.item.input_audio_transcription.delta":
                self.last_transcript += data.get("delta", "")
                await self.client_ws.send_text(json.dumps({
                    "type": "transcript", "text": self.last_transcript,
                }))
            elif event_type == "conversation.item.input_audio_transcription.completed":
                final_text = data.get("transcript", self.last_transcript)
                await self.client_ws.send_text(json.dumps({"type": "transcript", "text": final_text}))
                await self.generate_answer(final_text)
                self.last_transcript = ""  # reset for the next turn
            elif event_type == "error":
                await self._send_error(f"OpenAI realtime error: {data.get('error', data)}")

    # ---------------- LLM: answer generation ----------------

    async def generate_answer(self, question: str):
        if not question.strip():
            return
        if LLM_PROVIDER == "anthropic":
            await self._generate_answer_anthropic(question)
        elif LLM_PROVIDER == "openai":
            await self._generate_answer_openai(question)
        elif LLM_PROVIDER == "gemini":
            await self._generate_answer_gemini(question)
        else:
            await self._send_error(f"Unknown LLM_PROVIDER '{LLM_PROVIDER}'")

    async def _generate_answer_anthropic(self, question: str):
        if anthropic_client is None:
            await self._send_error("ANTHROPIC_API_KEY is not set on the backend.")
            return
        await self.client_ws.send_text(json.dumps({"type": "answer_start"}))
        try:
            async with anthropic_client.messages.stream(
                model="claude-sonnet-4-6",
                max_tokens=600,
                system=self.system_prompt,
                messages=[{"role": "user", "content": question}],
            ) as stream:
                async for text_chunk in stream.text_stream:
                    await self.client_ws.send_text(json.dumps({
                        "type": "answer_chunk", "text": text_chunk,
                    }))
        except Exception as exc:  # noqa: BLE001
            await self._send_error(f"LLM error: {exc}")

    async def _generate_answer_openai(self, question: str):
        if openai_client is None:
            await self._send_error("OPENAI_API_KEY is not set on the backend.")
            return
        await self.client_ws.send_text(json.dumps({"type": "answer_start"}))
        try:
            stream = await openai_client.chat.completions.create(
                model="gpt-4o",
                max_tokens=600,
                stream=True,
                messages=[
                    {"role": "system", "content": self.system_prompt},
                    {"role": "user", "content": question},
                ],
            )
            async for chunk in stream:
                delta = chunk.choices[0].delta.content if chunk.choices else None
                if delta:
                    await self.client_ws.send_text(json.dumps({
                        "type": "answer_chunk", "text": delta,
                    }))
        except Exception as exc:  # noqa: BLE001
            await self._send_error(f"LLM error: {exc}")

    async def _generate_answer_gemini(self, question: str):
        if gemini_client is None:
            await self._send_error("GEMINI_API_KEY is not set on the backend.")
            return
        await self.client_ws.send_text(json.dumps({"type": "answer_start"}))
        try:
            from google.genai import types
            stream = await gemini_client.aio.models.generate_content_stream(
                model="gemini-2.5-flash",
                contents=question,
                config=types.GenerateContentConfig(
                    system_instruction=self.system_prompt,
                    max_output_tokens=600,
                ),
            )
            async for chunk in stream:
                if chunk.text:
                    await self.client_ws.send_text(json.dumps({
                        "type": "answer_chunk", "text": chunk.text,
                    }))
        except Exception as exc:  # noqa: BLE001
            await self._send_error(f"LLM error: {exc}")

    async def answer_from_screenshot(self, base64_png: str):
        """Solves/explains whatever problem is shown on screen (e.g. a coding
        question during a screen-share). Currently implemented for Gemini only,
        since it's the default/free vision-capable provider — extend with an
        OpenAI/Anthropic vision branch if you switch LLM_PROVIDER."""
        if not base64_png:
            await self._send_error("No screenshot data received.")
            return
        if LLM_PROVIDER != "gemini" or gemini_client is None:
            await self._send_error(
                "Screenshot solving currently requires LLM_PROVIDER=gemini with GEMINI_API_KEY set."
            )
            return

        await self.client_ws.send_text(json.dumps({
            "type": "transcript", "text": "[Screenshot captured — analyzing...]",
        }))
        await self.client_ws.send_text(json.dumps({"type": "answer_start"}))
        try:
            import base64
            from google.genai import types

            image_bytes = base64.b64decode(base64_png)
            image_part = types.Part.from_bytes(data=image_bytes, mime_type="image/png")
            prompt = (
                "This screenshot shows a problem from a live technical interview "
                "(could be a coding problem, a system design question, a diagram, or "
                "written text). Identify the problem and solve it. For coding problems, "
                "give working code with a brief explanation. For conceptual questions, "
                "give a clear, direct answer suited for speaking out loud."
            )
            stream = await gemini_client.aio.models.generate_content_stream(
                model="gemini-2.5-flash",
                contents=[prompt, image_part],
                config=types.GenerateContentConfig(
                    system_instruction=self.system_prompt,
                    max_output_tokens=1200,
                ),
            )
            async for chunk in stream:
                if chunk.text:
                    await self.client_ws.send_text(json.dumps({
                        "type": "answer_chunk", "text": chunk.text,
                    }))
        except Exception as exc:  # noqa: BLE001
            await self._send_error(f"Screenshot analysis error: {exc}")

    async def answer_from_screenshot_sequence(self, base64_pngs: list):
        """Combines several screenshots (captured while the user scrolled) into one
        request so the model can read content that didn't fit on a single screen —
        e.g. a long coding problem statement, or a page requiring scrolling."""
        if not base64_pngs:
            await self._send_error("No screenshots received.")
            return
        if LLM_PROVIDER != "gemini" or gemini_client is None:
            await self._send_error(
                "Screenshot solving currently requires LLM_PROVIDER=gemini with GEMINI_API_KEY set."
            )
            return

        await self.client_ws.send_text(json.dumps({
            "type": "transcript",
            "text": f"[{len(base64_pngs)} screenshots captured — reading and analyzing...]",
        }))
        await self.client_ws.send_text(json.dumps({"type": "answer_start"}))
        try:
            import base64
            from google.genai import types

            image_parts = [
                types.Part.from_bytes(data=base64.b64decode(png), mime_type="image/png")
                for png in base64_pngs
            ]
            prompt = (
                f"These {len(base64_pngs)} screenshots were captured in sequence while "
                "scrolling through a problem shown during a live technical interview — "
                "together they cover content that didn't fit on one screen (e.g. a long "
                "coding problem, a scrolled document, or a multi-part question). "
                "Reconstruct the full problem from all the screenshots combined (ignore "
                "any overlapping/repeated content between consecutive frames), then solve "
                "it. For coding problems, give working code with a brief explanation. For "
                "conceptual questions, give a clear, direct answer suited for speaking out loud."
            )
            stream = await gemini_client.aio.models.generate_content_stream(
                model="gemini-2.5-flash",
                contents=[prompt, *image_parts],
                config=types.GenerateContentConfig(
                    system_instruction=self.system_prompt,
                    max_output_tokens=1500,
                ),
            )
            async for chunk in stream:
                if chunk.text:
                    await self.client_ws.send_text(json.dumps({
                        "type": "answer_chunk", "text": chunk.text,
                    }))
        except Exception as exc:  # noqa: BLE001
            await self._send_error(f"Screenshot analysis error: {exc}")

    async def _send_error(self, message: str):
        try:
            await self.client_ws.send_text(json.dumps({"type": "error", "message": message}))
        except Exception:  # noqa: BLE001
            pass  # client already disconnected — nothing to send to

    async def close(self):
        if self.stt_ws is not None:
            await self.stt_ws.close()


@app.websocket("/ws/session")
async def session_endpoint(websocket: WebSocket):
    await websocket.accept()
    session = Session(websocket)
    await session.connect_stt()

    stt_task = None
    if session.stt_ws is not None:
        stt_task = asyncio.create_task(session.listen_stt_forever())

    try:
        while True:
            message = await websocket.receive()

            if message.get("type") == "websocket.disconnect":
                break

            if "bytes" in message and message["bytes"] is not None:
                await session.pump_audio(message["bytes"])

            elif "text" in message and message["text"] is not None:
                payload = json.loads(message["text"])
                if payload.get("type") == "context":
                    session.resume = payload.get("resume", "")
                    session.jd = payload.get("jd", "")
                    session.system_prompt = build_system_prompt(session.resume, session.jd)
                elif payload.get("type") == "manual_trigger":
                    # Force an answer from whatever was last transcribed, even if
                    # Deepgram hasn't marked the utterance as finished yet.
                    if session.last_transcript:
                        await session.generate_answer(session.last_transcript)
                elif payload.get("type") == "commit":
                    # Client detected the interviewer went silent — finalize the
                    # current OpenAI transcription turn.
                    await session.commit_audio()
                elif payload.get("type") == "screenshot":
                    # Base64 PNG of the screen — ask the vision-capable model to
                    # solve/explain whatever problem is shown.
                    await session.answer_from_screenshot(payload.get("image", ""))
                elif payload.get("type") == "screenshot_sequence":
                    # Multiple frames captured while the user scrolled through a
                    # problem that didn't fit on one screen — combine them.
                    await session.answer_from_screenshot_sequence(payload.get("images", []))
                elif payload.get("type") == "manual_text_question":
                    # Fallback for when audio didn't capture the question correctly —
                    # user typed it directly instead.
                    text = payload.get("text", "").strip()
                    if text:
                        session.last_transcript = text
                        await session.generate_answer(text)
                elif payload.get("type") == "clear":
                    session.last_transcript = ""

    except (WebSocketDisconnect, RuntimeError):
        # RuntimeError covers the case where the socket was already disconnected
        # before we called receive() again — treat it the same as a clean disconnect.
        pass
    finally:
        if stt_task is not None:
            stt_task.cancel()
        await session.close()


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "stt_provider": STT_PROVIDER,
        "llm_provider": LLM_PROVIDER,
        "deepgram_configured": bool(DEEPGRAM_API_KEY),
        "anthropic_configured": bool(ANTHROPIC_API_KEY),
        "openai_configured": bool(OPENAI_API_KEY),
        "gemini_configured": bool(GEMINI_API_KEY),
    }
```

---

## 8. How to run it (recap for a fresh session)

**Backend:**
```bash
cd backend
source venv/bin/activate   # venv already exists in the project
uvicorn main:app --host 127.0.0.1 --port 8765
```
Check `http://127.0.0.1:8765/health` — should show `deepgram_configured: true`,
`gemini_configured: true`.

**Electron overlay (separate terminal, every time — env var doesn't persist):**
```bash
cd interview-copilot
export ELECTRON_OVERRIDE_DIST_PATH=/Applications
npm start
```

**Browser test harness (no Electron needed, useful for isolating bugs):**
Just open `renderer/test.html` directly in Chrome while the backend is running.

---

## 9. Suggested next steps for whoever picks this up

1. Resolve the open issue in §4 (mic permission for the Electron app specifically).
2. Once working end-to-end, consider making `ELECTRON_OVERRIDE_DIST_PATH` permanent via
   `~/.zshrc` so it doesn't need re-exporting every session.
3. Consider extending screenshot-solving to work with Anthropic/OpenAI too (currently
   Gemini-only), if the user ever switches `LLM_PROVIDER`.
4. Windows/Linux audio setup is documented but untested — would need real testing on those
   platforms if the user ever needs them.
