const messagesEl = document.getElementById('messages');
const btnVoice = document.getElementById('btn-voice');
const btnSettings = document.getElementById('btn-settings');
const voiceStatus = document.getElementById('voice-status');
const voiceStatusDot = document.getElementById('voice-status-dot');
const voiceStatusText = document.getElementById('voice-status-text');
const toolStatus = document.getElementById('tool-status');
const toolStatusText = document.getElementById('tool-status-text');

let voiceActive = false;

// Playback state
let playbackCtx = null;
let nextPlayTime = 0;

// --- Helpers ---

function base64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

// --- Message rendering ---

function addMessage(role, content) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (content.includes('\n')) {
    div.innerHTML = content.split('\n').map(line => document.createTextNode(line).textContent).join('<br>');
  } else {
    div.textContent = content;
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addStreamingMessage(role) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  messagesEl.appendChild(div);
  return div;
}

function appendToMessage(div, chunk) {
  div.textContent += chunk;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function showToolStatus(text) {
  toolStatusText.textContent = text;
  toolStatus.classList.remove('hidden');
}

function hideToolStatus() {
  toolStatus.classList.add('hidden');
}

// --- Audio playback ---

function playAudioChunk(base64PCM) {
  if (!playbackCtx) {
    playbackCtx = new AudioContext({ sampleRate: 24000 });
    nextPlayTime = 0;
    console.log('[Audio] Created AudioContext, state:', playbackCtx.state);
  }
  if (playbackCtx.state === 'suspended') {
    playbackCtx.resume();
    console.log('[Audio] Resumed AudioContext, state:', playbackCtx.state);
  }

  const int16 = base64ToInt16(base64PCM);
  console.log('[Audio] Playing chunk, samples:', int16.length, 'ctx state:', playbackCtx.state);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 0x8000;
  }

  const buffer = playbackCtx.createBuffer(1, float32.length, 24000);
  buffer.getChannelData(0).set(float32);

  const source = playbackCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackCtx.destination);

  const now = playbackCtx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now;
  source.start(nextPlayTime);
  nextPlayTime += buffer.duration;
}

function stopPlayback() {
  if (playbackCtx) {
    playbackCtx.close();
    playbackCtx = null;
    nextPlayTime = 0;
  }
}

// --- Voice control ---
// Mic capture is handled by native host (Python sounddevice), not Chrome getUserMedia

async function startVoice() {
  voiceActive = true;
  btnVoice.classList.add('active');
  voiceStatus.classList.remove('hidden');
  updateVoiceStatus('connecting');

  // Pre-create AudioContext during user gesture (click)
  // Chrome blocks AudioContext playback if created outside user gesture
  if (!playbackCtx) {
    playbackCtx = new AudioContext({ sampleRate: 24000 });
    nextPlayTime = 0;
  }
  if (playbackCtx.state === 'suspended') {
    await playbackCtx.resume();
  }

  chrome.runtime.sendMessage({ type: 'voice_start' });
}

function stopVoice() {
  voiceActive = false;
  btnVoice.classList.remove('active');
  voiceStatus.classList.add('hidden');
  stopPlayback();
  chrome.runtime.sendMessage({ type: 'voice_stop' });
}

function toggleVoice() {
  if (voiceActive) {
    stopVoice();
  } else {
    startVoice();
  }
}

function updateVoiceStatus(status) {
  const labels = {
    listening: '监听中...',
    speaking: '说话中...',
    thinking: '思考中...',
    replying: '回复中...',
    connecting: '连接中...',
    stopped: '已停止',
  };

  if (status.startsWith('error: ')) {
    voiceStatusDot.className = 'error';
    voiceStatusText.textContent = status.slice(7);
    return;
  }

  voiceStatusDot.className = status;
  voiceStatusText.textContent = labels[status] || status;
}

// --- Listen for messages from service worker ---

let currentAssistantDiv = null;
let currentUserDiv = null;

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'stream_chunk':
      if (!currentAssistantDiv) {
        currentAssistantDiv = addStreamingMessage('assistant');
      }
      appendToMessage(currentAssistantDiv, msg.content);
      break;

    case 'stream_end':
      currentAssistantDiv = null;
      break;

    case 'stream_error':
      if (!currentAssistantDiv) {
        currentAssistantDiv = addStreamingMessage('assistant');
      }
      currentAssistantDiv.textContent = 'Error: ' + msg.error;
      currentAssistantDiv = null;
      break;

    case 'user_transcript':
      if (!currentUserDiv) {
        currentUserDiv = addMessage('user', msg.text);
      } else {
        currentUserDiv.textContent = msg.text;
      }
      break;

    case 'user_transcript_done':
      currentUserDiv = null;
      break;

    case 'tool_call':
      showToolStatus(msg.status || `正在调用 ${msg.name}...`);
      break;

    case 'tool_done':
      hideToolStatus();
      break;

    case 'voice_status':
      updateVoiceStatus(msg.status);
      break;

    case 'play_audio':
      playAudioChunk(msg.data);
      break;

    case 'stop_playback':
      stopPlayback();
      break;

    case 'audio_flush':
      nextPlayTime = 0;
      break;
  }
});

// --- Event listeners ---

btnVoice.addEventListener('click', toggleVoice);
btnSettings.addEventListener('click', () => chrome.runtime.openOptionsPage());

// Cleanup on unload
window.addEventListener('unload', () => {
  if (voiceActive) {
    chrome.runtime.sendMessage({ type: 'voice_stop' });
  }
});
