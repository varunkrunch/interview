const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const btnListen = document.getElementById('btn-listen');
const btnAnswer = document.getElementById('btn-answer');
const btnScreenshot = document.getElementById('btn-screenshot');
const btnClear = document.getElementById('btn-clear');
const typeInput = document.getElementById('type-input');
const btnTypeSend = document.getElementById('btn-type-send');
const btnSettings = document.getElementById('btn-settings');
const mainView = document.getElementById('main-view');
const settingsView = document.getElementById('settings-view');
const deviceSelect = document.getElementById('device-select');
const deviceSelect2 = document.getElementById('device-select-2');
const useSystemAudioCheckbox = document.getElementById('use-system-audio');
const resumeBox = document.getElementById('resume');
const jdBox = document.getElementById('jd');
const extraKnowledgeBox = document.getElementById('extra-knowledge');
const answerLengthSelect = document.getElementById('answer-length');
const answerToneSelect = document.getElementById('answer-tone');
const customInstructionsBox = document.getElementById('custom-instructions');
const experienceLevelSelect = document.getElementById('experience-level');
const targetRoleInput = document.getElementById('target-role');
const btnSaveSettings = document.getElementById('btn-save-settings');
const resumePdfInput = document.getElementById('resume-pdf');
const pdfStatus = document.getElementById('pdf-status');
const captionEl = document.getElementById('caption');
const chatLog = document.getElementById('chat-log');
const sttProviderSelect = document.getElementById('stt-provider');
const llmProviderSelect = document.getElementById('llm-provider');
const deepgramKeyInput = document.getElementById('deepgram-key');
const geminiKeyInput = document.getElementById('gemini-key');
const groqKeyInput = document.getElementById('groq-key');
const openaiKeyInput = document.getElementById('openai-key');
const anthropicKeyInput = document.getElementById('anthropic-key');
const btnSaveKeys = document.getElementById('btn-save-keys');
const keysStatus = document.getElementById('keys-status');
const btnDownloadBlackhole = document.getElementById('btn-download-blackhole');
const btnDownloadVbcable = document.getElementById('btn-download-vbcable');

const BACKEND_WS = 'ws://127.0.0.1:8765/ws/session';
const BACKEND_HTTP = 'http://127.0.0.1:8765';

let ws = null;
let wsReady = false;
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
let settingsOpen = false;

// The current chat entry being streamed into (created on answer_start, filled by
// answer_chunk). Kept separate from "pendingQuestionText" below.
let currentAnswerEntry = null;
let pendingQuestionText = '';
let chatHasContent = false;

// --- persistence ---
function loadSettingsFromStorage() {
  resumeBox.value = localStorage.getItem('resume') || '';
  jdBox.value = localStorage.getItem('jd') || '';
  extraKnowledgeBox.value = localStorage.getItem('extraKnowledge') || '';
  answerLengthSelect.value = localStorage.getItem('answerLength') || 'concise';
  answerToneSelect.value = localStorage.getItem('answerTone') || 'professional';
  customInstructionsBox.value = localStorage.getItem('customInstructions') || '';
  experienceLevelSelect.value = localStorage.getItem('experienceLevel') || 'fresher';
  targetRoleInput.value = localStorage.getItem('targetRole') || '';
  const storedUseSystemAudio = localStorage.getItem('useSystemAudio');
  useSystemAudioCheckbox.checked = storedUseSystemAudio === null ? true : storedUseSystemAudio === 'true';
}
loadSettingsFromStorage();

function buildContextPayload() {
  return {
    type: 'context',
    resume: resumeBox.value,
    jd: jdBox.value,
    extra_knowledge: extraKnowledgeBox.value,
    answer_length: answerLengthSelect.value,
    answer_tone: answerToneSelect.value,
    custom_instructions: customInstructionsBox.value,
    experience_level: experienceLevelSelect.value,
    target_role: targetRoleInput.value,
  };
}

function saveSettings() {
  localStorage.setItem('resume', resumeBox.value);
  localStorage.setItem('jd', jdBox.value);
  localStorage.setItem('extraKnowledge', extraKnowledgeBox.value);
  localStorage.setItem('answerLength', answerLengthSelect.value);
  localStorage.setItem('answerTone', answerToneSelect.value);
  localStorage.setItem('customInstructions', customInstructionsBox.value);
  localStorage.setItem('experienceLevel', experienceLevelSelect.value);
  localStorage.setItem('targetRole', targetRoleInput.value);
  localStorage.setItem('deviceId', deviceSelect.value);
  localStorage.setItem('deviceId2', deviceSelect2.value);
  localStorage.setItem('useSystemAudio', useSystemAudioCheckbox.checked);
  if (wsReady) {
    ws.send(JSON.stringify(buildContextPayload()));
  }
  btnSaveSettings.textContent = 'Saved ✓';
  setTimeout(() => (btnSaveSettings.textContent = 'Save Settings'), 1200);
}
btnSaveSettings.onclick = saveSettings;

// --- PDF resume upload ---
resumePdfInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  pdfStatus.textContent = 'Extracting...';
  pdfStatus.className = 'file-status';
  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${BACKEND_HTTP}/extract-pdf`, { method: 'POST', body: formData });
    const data = await res.json();
    if (data.text) {
      resumeBox.value = data.text;
      pdfStatus.textContent = `Loaded ${file.name}`;
      pdfStatus.className = 'file-status';
    } else {
      pdfStatus.textContent = data.error || 'Extraction failed';
      pdfStatus.className = 'file-status error';
    }
  } catch (err) {
    pdfStatus.textContent = 'Backend not reachable — is uvicorn running?';
    pdfStatus.className = 'file-status error';
  }
});

// --- API keys & provider setup (Electron-only — falls back gracefully in browser test.html) ---
async function loadProviderConfig() {
  if (!window.copilot || !window.copilot.getProviderConfig) return;
  const cfg = await window.copilot.getProviderConfig();
  sttProviderSelect.value = cfg.sttProvider;
  llmProviderSelect.value = cfg.llmProvider;
  document.getElementById('status-deepgram').textContent = cfg.hasDeepgram ? '✓ set' : '';
  document.getElementById('status-gemini').textContent = cfg.hasGemini ? '✓ set' : '';
  document.getElementById('status-groq').textContent = cfg.hasGroq ? '✓ set' : '';
  document.getElementById('status-openai').textContent = cfg.hasOpenai ? '✓ set' : '';
  document.getElementById('status-anthropic').textContent = cfg.hasAnthropic ? '✓ set' : '';
}
loadProviderConfig();

btnSaveKeys.onclick = async () => {
  if (!window.copilot || !window.copilot.saveProviderConfig) {
    keysStatus.textContent = 'API key management is only available in the desktop app.';
    keysStatus.className = 'file-status error';
    return;
  }
  btnSaveKeys.textContent = 'Restarting backend...';
  keysStatus.textContent = '';
  await window.copilot.saveProviderConfig({
    sttProvider: sttProviderSelect.value,
    llmProvider: llmProviderSelect.value,
    deepgramKey: deepgramKeyInput.value.trim(),
    geminiKey: geminiKeyInput.value.trim(),
    groqKey: groqKeyInput.value.trim(),
    openaiKey: openaiKeyInput.value.trim(),
    anthropicKey: anthropicKeyInput.value.trim(),
  });
  [deepgramKeyInput, geminiKeyInput, groqKeyInput, openaiKeyInput, anthropicKeyInput].forEach((el) => (el.value = ''));
  btnSaveKeys.textContent = 'Save Keys & Restart Backend';
  keysStatus.textContent = 'Saved. Backend restarting — reconnecting automatically in a moment.';
  keysStatus.className = 'file-status';
  await loadProviderConfig();
};

btnDownloadBlackhole.onclick = () => {
  if (window.copilot && window.copilot.openExternal) {
    window.copilot.openExternal('https://existential.audio/blackhole/');
  }
};
btnDownloadVbcable.onclick = () => {
  if (window.copilot && window.copilot.openExternal) {
    window.copilot.openExternal('https://vb-audio.com/Cable/');
  }
};

document.querySelectorAll('[data-link]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    if (window.copilot && window.copilot.openExternal) {
      window.copilot.openExternal(el.getAttribute('data-link'));
    }
  });
});

// --- settings page toggle (full view, not a small panel) ---
btnSettings.onclick = () => {
  settingsOpen = !settingsOpen;
  if (settingsOpen) {
    mainView.classList.add('hidden');
    settingsView.classList.add('open');
    btnSettings.textContent = 'Done';
    if (window.copilot && window.copilot.resizeWindow) window.copilot.resizeWindow(680);
  } else {
    mainView.classList.remove('hidden');
    settingsView.classList.remove('open');
    btnSettings.textContent = 'Settings';
    saveSettings();
    if (window.copilot && window.copilot.resizeWindow) window.copilot.resizeWindow(300);
  }
};

// --- populate audio input devices ---
async function loadDevices() {
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

// --- chat log rendering ---
function scrollChatToBottom() {
  chatLog.scrollTop = chatLog.scrollHeight;
}

function startNewChatEntry(questionText) {
  if (!chatHasContent) {
    chatLog.innerHTML = '';
    chatHasContent = true;
  }
  const entry = document.createElement('div');
  entry.className = 'chat-entry';
  const qEl = document.createElement('div');
  qEl.className = 'chat-question';
  qEl.textContent = 'Q: ' + (questionText || '(unlabeled)');
  const aEl = document.createElement('div');
  aEl.className = 'chat-answer';
  entry.appendChild(qEl);
  entry.appendChild(aEl);
  chatLog.appendChild(entry);
  scrollChatToBottom();
  return aEl;
}

// --- connect to the backend immediately, independent of audio ---
function connectBackend() {
  ws = new WebSocket(BACKEND_WS);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    wsReady = true;
    ws.send(JSON.stringify(buildContextPayload()));
    setStatus('Connected', false);
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    console.log('Received from backend:', msg.type, msg);

    if (msg.type === 'transcript') {
      // Live captions only — does NOT create/append a chat entry. The user
      // decides when to actually ask (Enter / Get Answer button).
      captionEl.textContent = msg.text;
      pendingQuestionText = msg.text;
    } else if (msg.type === 'answer_start') {
      currentAnswerEntry = startNewChatEntry(pendingQuestionText);
      captionEl.textContent = '';
    } else if (msg.type === 'answer_chunk') {
      if (!currentAnswerEntry) currentAnswerEntry = startNewChatEntry(pendingQuestionText);
      currentAnswerEntry.textContent += msg.text;
      scrollChatToBottom();
    } else if (msg.type === 'error') {
      const entry = currentAnswerEntry || startNewChatEntry(pendingQuestionText);
      entry.textContent += (entry.textContent ? '\n' : '') + 'Error: ' + msg.message;
      scrollChatToBottom();
    } else if (msg.type === 'stt_status') {
      console.warn('STT status:', msg.message);
    }
  };

  ws.onclose = () => {
    wsReady = false;
    setStatus('Disconnected — reconnecting...', false);
    setTimeout(connectBackend, 1500);
  };
  ws.onerror = () => setStatus('Connection error', false);
}
connectBackend();

// --- downsample Float32 [-1,1] audio to 24kHz PCM16 ---
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

let systemAudioStream = null; // the getDisplayMedia stream (video discarded, audio kept)

async function startListening() {
  if (!wsReady) {
    setStatus('Not connected yet — try again in a second', false);
    return;
  }

  const useBuiltIn = useSystemAudioCheckbox.checked;

  audioCtx = new AudioContext();
  processorNode = audioCtx.createScriptProcessor(4096, 1, 1);

  if (useBuiltIn) {
    // Built-in system audio loopback (macOS 13+ / Windows 10+) — no BlackHole/
    // VB-CABLE needed. main.js auto-grants this without a picker dialog.
    try {
      systemAudioStream = await navigator.mediaDevices.getDisplayMedia({
        video: true, // required by the API even though we discard it
        audio: true,
      });
    } catch (err) {
      setStatus('System audio capture failed — try the manual device option in Settings', false);
      console.error('getDisplayMedia failed:', err);
      return;
    }
    systemAudioStream.getVideoTracks().forEach((t) => t.stop()); // don't need video at all
    if (systemAudioStream.getAudioTracks().length === 0) {
      setStatus('No system audio track available — try the manual device option', false);
      return;
    }
    sourceNode = audioCtx.createMediaStreamSource(systemAudioStream);
    sourceNode.connect(processorNode);
  } else {
    const deviceId = deviceSelect.value;
    if (!deviceId) {
      setStatus('No input device selected', false);
      return;
    }
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false },
    });
    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    sourceNode.connect(processorNode);
  }

  // Optional second input (e.g. your mic) — works the same regardless of which
  // primary mode is active above, useful for testing by speaking.
  const deviceId2 = deviceSelect2.value;
  if (deviceId2) {
    mediaStream2 = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId2 }, echoCancellation: false, noiseSuppression: false },
    });
    sourceNode2 = audioCtx.createMediaStreamSource(mediaStream2);
    sourceNode2.connect(processorNode);
  }

  ws.send(JSON.stringify({ type: 'start_audio' }));
  setStatus('Listening', true);

  // NOTE: silence-based auto-commit is intentionally NOT used to trigger answers —
  // it still helps OpenAI's transcription finalize sentences, but the actual
  // "get an answer" step always waits for the user (Enter / Get Answer button).
  const SILENCE_RMS_THRESHOLD = 0.01;
  const SILENCE_MS_BEFORE_COMMIT = 700;
  let hasSpeechSinceCommit = false;
  let lastSpeechTime = 0;

  processorNode.onaudioprocess = (e) => {
    if (!wsReady) return;
    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = floatTo16BitPCM(input, audioCtx.sampleRate, 24000);
    ws.send(pcm16.buffer);

    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const level = Math.sqrt(sum / input.length);
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
  if (systemAudioStream) systemAudioStream.getTracks().forEach((t) => t.stop());
  systemAudioStream = null;
  if (wsReady) ws.send(JSON.stringify({ type: 'stop_audio' }));
  listening = false;
  btnListen.textContent = 'Start';
  setStatus('Connected', false);
}

function setStatus(text, live) {
  statusText.textContent = text;
  statusDot.classList.toggle('live', !!live);
}

btnListen.onclick = () => (listening ? stopListening() : startListening());

function triggerAnswer() {
  if (!wsReady) {
    setStatus('Not connected yet — try again in a second', false);
    return;
  }
  if (screenFrames.length > 0) {
    pendingQuestionText = `[${screenFrames.length} screenshot(s)]`;
    ws.send(JSON.stringify({ type: 'screenshot_sequence', images: screenFrames }));
    screenFrames = [];
    btnScreenshot.textContent = 'Read Screen';
  } else {
    ws.send(JSON.stringify({ type: 'manual_trigger' }));
  }
}
btnAnswer.onclick = triggerAnswer;

// Global Enter key: triggers an answer from wherever the live transcript / captured
// screenshots currently stand — as long as focus isn't in the typed-question box
// (which has its own Enter behavior: send that specific typed question instead).
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.activeElement !== typeInput && !settingsOpen) {
    triggerAnswer();
  }
});

async function solveFromScreen() {
  if (!window.copilot || !window.copilot.captureScreen) {
    startNewChatEntry('(screenshot)').textContent = 'Error: screen capture is only available in the desktop app.';
    return;
  }

  if (capturingScreen) {
    stopScreenCapture();
    return;
  }

  capturingScreen = true;
  screenFrames = [];
  btnScreenshot.textContent = 'Stop (0)';
  captionEl.textContent = 'Capturing — scroll through the problem, click "Stop" when done, then Enter/Get Answer.';

  const MAX_FRAMES = 10;
  screenCaptureInterval = setInterval(async () => {
    try {
      const base64Png = await window.copilot.captureScreen();
      if (base64Png) {
        screenFrames.push(base64Png);
        btnScreenshot.textContent = `Stop (${screenFrames.length})`;
      } else {
        captionEl.textContent = 'Error: screen capture returned no data. Check Screen Recording permission for Electron.';
        stopScreenCapture();
      }
    } catch (err) {
      captionEl.textContent = 'Screen capture error: ' + (err && err.message ? err.message : String(err));
      stopScreenCapture();
    }
    if (screenFrames.length >= MAX_FRAMES) {
      stopScreenCapture();
    }
  }, 900);

  try {
    const firstFrame = await window.copilot.captureScreen();
    if (firstFrame) {
      screenFrames.push(firstFrame);
      btnScreenshot.textContent = `Stop (${screenFrames.length})`;
    } else {
      captionEl.textContent = 'Error: screen capture returned no data. Check Screen Recording permission for Electron.';
      stopScreenCapture();
    }
  } catch (err) {
    captionEl.textContent = 'Screen capture error: ' + (err && err.message ? err.message : String(err));
    stopScreenCapture();
  }
}

function stopScreenCapture() {
  capturingScreen = false;
  if (screenCaptureInterval) {
    clearInterval(screenCaptureInterval);
    screenCaptureInterval = null;
  }
  if (screenFrames.length > 0) {
    btnScreenshot.textContent = `Read Screen (${screenFrames.length} ready)`;
    captionEl.textContent = `${screenFrames.length} screenshot(s) captured. Press Enter or "Get Answer" to analyze them.`;
  } else {
    btnScreenshot.textContent = 'Read Screen';
  }
}

btnScreenshot.onclick = solveFromScreen;

btnClear.onclick = () => {
  captionEl.textContent = '';
  pendingQuestionText = '';
  currentAnswerEntry = null;
  chatHasContent = false;
  chatLog.innerHTML = '<div class="chat-placeholder">Chat cleared.</div>';
  screenFrames = [];
  btnScreenshot.textContent = 'Read Screen';
  if (wsReady) {
    ws.send(JSON.stringify({ type: 'clear' }));
  }
};

function sendTypedQuestion() {
  const text = typeInput.value.trim();
  if (!text) return;
  if (!wsReady) {
    setStatus('Not connected yet — try again in a second', false);
    return;
  }
  pendingQuestionText = text;
  ws.send(JSON.stringify({ type: 'manual_text_question', text }));
  typeInput.value = '';
}

btnTypeSend.onclick = sendTypedQuestion;
typeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendTypedQuestion();
});

if (window.copilot) {
  window.copilot.onListeningToggled((state) => {
    if (state && !listening) startListening();
    if (!state && listening) stopListening();
  });
  window.copilot.onManualTrigger(() => {
    triggerAnswer();
  });
  window.copilot.onScreenshotTrigger(() => {
    solveFromScreen();
  });
}
