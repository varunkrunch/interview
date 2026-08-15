# Interview Copilot (personal build)

A personal, cross-platform live-interview assistant: captures system audio, transcribes it
in real time, and generates spoken-style answers using your resume + the job description,
shown in a floating overlay that's invisible in screen shares (Mac/Windows).

**This is for your own personal use.** No auth, no billing, no multi-user support — by design.

---

## How it works

```
system audio  →  Electron overlay  →  FastAPI backend  →  Deepgram (streaming transcription)
                                                        →  Claude (streaming answer)
                                     ←  transcript + answer stream back to overlay
```

## 1. Get API keys

Provider is configurable in `backend/.env` — no code changes needed:

```
STT_PROVIDER=deepgram    # or: openai
LLM_PROVIDER=gemini      # or: anthropic, openai
```

**Free setup (no credit card needed anywhere):**
- Deepgram: https://console.deepgram.com — free signup credit for transcription
- Gemini: https://aistudio.google.com/apikey — genuinely free tier (rate-limited: ~10-15
  requests/minute, 1500/day), no card required

This is the default in `.env.example`. Copy it to `backend/.env` and fill in both keys.

**Paid alternative:** if you'd rather use OpenAI for one or both (needs billing credit on
your OpenAI account), set `STT_PROVIDER=openai` and/or `LLM_PROVIDER=openai` and fill in
`OPENAI_API_KEY` instead.

## 2. Route your system/meeting audio to a capturable input device

**The concept:** the app "hears" audio the same way a microphone does — so we need to
insert a splitter into your audio output: normally `Zoom → speakers → your ears`, and
we change that to `Zoom → splitter → (your ears AND a fake microphone the app reads from)`.
You set this up once.

### macOS
1. Install [BlackHole](https://existential.audio/blackhole/) (2ch is enough) — this is the splitter.
2. Open **Audio MIDI Setup** (Spotlight search — built into every Mac).
3. Bottom-left **+** → **Create Multi-Output Device**.
4. Check the boxes for **your normal output** (speakers/earphones/AirPods — whatever
   you're actually using) **and** **BlackHole 2ch**.
5. Click the volume icon in your menu bar → set output to this new **Multi-Output Device**.
   You'll still hear everything normally; it's now also being copied into BlackHole.
6. In the app's Settings, select **BlackHole 2ch** as the input device.

Whenever you switch physical output (e.g. speakers → earphones), just re-check the new
device's box inside the Multi-Output Device in Audio MIDI Setup — 5 seconds, no reinstall.

### Windows
Windows' old built-in method (Stereo Mix) is unreliable on Windows 11 — many machines
don't expose it at all anymore. Use **VB-CABLE** instead, it's the same splitter concept:

1. Install [VB-CABLE](https://vb-audio.com/Cable/) (free), restart if prompted.
2. Right-click the speaker icon → **Sound settings** → set default output to **"CABLE Input"**.
   (This alone would mute your own audio — next step fixes that.)
3. Still in Sound settings → **CABLE Input** → **Properties** → **Listen tab** → check
   **"Listen to this device"** → set it to play through your real speakers/headphones.
4. In the app's Settings, select **"CABLE Output"** as the input device.

If Stereo Mix *does* show up under Recording devices on your machine (right-click in the
Recording tab → *Show Disabled Devices* to check), it works too and skips the install —
but don't rely on it being there.

### Linux (PulseAudio/PipeWire)
1. Run `pactl list sources short` and find the `*.monitor` source matching your output device.
2. Select it in the app's Settings dropdown (it'll show up as a normal input device).

## 3. Install and run

The backend now starts automatically when you launch the app — you only need one terminal.

```bash
# Backend deps (one-time setup)
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cd ..

# Electron app — this also auto-starts the backend for you
npm install
npm start          # macOS
npm run start:win  # Windows
```

If you'd rather run the backend yourself in a separate terminal (e.g. to watch its logs
more easily), that still works exactly as before — just run `npm run backend` in one
terminal and `npm start` in another; the app detects the already-running backend and
won't start a second copy... actually it will try to start its own regardless, so if you
want manual control, comment out the `startBackend()` call in `electron/main.js`.

## 4. Using it

- **Cmd/Ctrl+Shift+O** — show/hide the overlay
- **Cmd/Ctrl+Shift+L** — start/stop listening
- **Cmd/Ctrl+Shift+A** — manually force an answer from the last thing heard (mirrors
  Parakeet's manual "start answering" trigger, useful if auto-detection of question-end
  misses a beat)
- Fill in your resume, job description, experience level, and target role in Settings
  before the call — this is what grounds and tailors every generated answer.
- Closing the overlay window just hides it; the tray icon keeps it running. Quitting from
  the tray menu fully exits (as with any app, nothing runs after that) and also stops the
  backend process automatically.

## Building a real installer (.dmg / .exe)

This packages the app into something double-clickable and shareable, instead of running
via `npm start` from a terminal every time. The backend now gets compiled into a
**standalone executable** first (via PyInstaller), so the installed app doesn't require
Python to be installed on the machine that runs it — a genuine "download and it works"
installer, not just a dev-mode shortcut.

```bash
# One-time: install PyInstaller into the backend's venv
cd backend
source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt   # now includes pyinstaller
cd ..

# Build (this also runs the PyInstaller step automatically first)
npm run dist:mac    # produces a .dmg — must be run ON a Mac
npm run dist:win    # produces an installer .exe — must be run ON Windows
```

**Important limitation:** you can't reliably cross-build a Windows installer from a Mac
(or vice versa) — Electron+Python packaging depends on platform-specific binaries that
need to be built on that actual OS. To get a Windows build, use the included GitHub
Actions workflow (`.github/workflows/build-windows.yml`) — it builds the PyInstaller exe
and the installer automatically on a free cloud Windows machine. Push this repo to GitHub,
go to the Actions tab, run "Build Windows installer" manually, and download the `.exe`
from the run's Artifacts once it finishes.

**PyInstaller honesty note:** bundling an async Python stack with several different AI
SDKs (`anthropic`, `google-genai`, `openai`, `ollama`) is the one part of this project
that's genuinely hard to guarantee will work first try without actually running it on
each target OS. If the frozen executable fails to start with a `ModuleNotFoundError` for
something, that's a missing "hidden import" PyInstaller didn't auto-detect — the fix is
adding `--hidden-import <module_name>` to the `build:backend:mac` / `build:backend:win`
scripts in `package.json` for whatever module it's missing, then rebuilding. Test the
built executable directly first (`backend/dist/backend` or `backend/dist/backend.exe`)
before assuming the full installer is broken — that isolates whether the problem is the
PyInstaller bundling or something else in Electron's packaging.

API keys are entered through the app's own Settings page (no `.env` editing needed) —
for a packaged/installed app, they're saved to Electron's per-user data folder instead of
inside the (usually read-only) install directory, so Settings → Save Keys works the same
whether you're running in dev mode or from the installed app.

## Screen-share invisibility — what actually works

`setContentProtection(true)` (used in `electron/main.js`) hides the overlay from screen
capture on **macOS 13+ and Windows 10 2004+**. There is currently no equivalent OS API on
**Linux** — the overlay will be visible there if you share your full screen. Workaround on
Linux: share only the specific application/browser tab window, not your full screen.

## Long sessions (1-2 hour interviews)

OpenAI's realtime transcription connection has a hard 60-minute cap per session (server-side,
can't be extended). The backend automatically reconnects when this happens — you shouldn't
notice anything beyond a brief gap in transcription. This reconnect logic is in
`Session.listen_stt_forever()` in `backend/main.py`. It hasn't been tested against a real
60+ minute session yet — if you hit issues on an actual long call, check the terminal running
`uvicorn` for `[stt] connection dropped` log lines to see if/when it's reconnecting.

The LLM side (answer generation) has no session-length limit — each answer is an independent
API call, not a persistent connection.

## Known rough edges (this is a scaffold, not a polished product)

- Question-end detection relies on Deepgram's `speech_final` endpointing (500ms silence).
  Tune the `endpointing` param in `backend/main.py` if it cuts off too early/late.
- No persistence of past sessions/transcripts yet — add SQLite storage in `backend/main.py`
  if you want a history log.
- No screenshot-based coding-question support yet (Parakeet's screenshot → explanation
  feature) — would hook in via a vision-capable Claude call triggered by a new hotkey.
- ScriptProcessorNode (used for audio capture in `renderer/overlay.js`) is deprecated in
  favor of AudioWorklet; kept simple here since it still works fine for single-user use.
# interview
