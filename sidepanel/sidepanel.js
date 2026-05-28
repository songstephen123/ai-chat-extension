const btnVoice = document.getElementById('btn-voice');
const btnSettings = document.getElementById('btn-settings');
const voiceStatus = document.getElementById('voice-status');
const voiceStatusDot = document.getElementById('voice-status-dot');
const voiceStatusText = document.getElementById('voice-status-text');
const toolStatus = document.getElementById('tool-status');
const toolStatusText = document.getElementById('tool-status-text');
const stateTitle = document.getElementById('state-title');
const stateDetail = document.getElementById('state-detail');
const activityLine = document.getElementById('activity-line');

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

// --- Status rendering ---

function showActivity(text) {
  activityLine.textContent = text;
  activityLine.classList.remove('hidden');
}

function hideActivity() {
  activityLine.classList.add('hidden');
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
  document.body.classList.add('voice-active');
  voiceStatus.classList.remove('hidden');
  hideActivity();
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
  document.body.classList.remove('voice-active');
  voiceStatus.classList.add('hidden');
  stateTitle.textContent = '点击开始语音';
  stateDetail.textContent = '实时文字内容已隐藏';
  hideActivity();
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
  const titles = {
    listening: '正在听你说',
    speaking: '正在收音',
    thinking: '正在思考',
    replying: '正在回复',
    connecting: '正在连接',
    stopped: '语音已停止',
  };
  const details = {
    listening: '你可以直接说出飞书、网页或演示稿需求',
    speaking: '实时转录不会显示在面板里',
    thinking: '正在理解你的请求',
    replying: '回复会以语音播放，不显示完整文字',
    connecting: '正在建立实时语音通道',
    stopped: '点击按钮可重新开始',
  };

  if (status.startsWith('error: ')) {
    voiceStatusDot.className = 'error';
    voiceStatusText.textContent = status.slice(7);
    stateTitle.textContent = '连接出错';
    stateDetail.textContent = status.slice(7);
    return;
  }

  voiceStatusDot.className = status;
  voiceStatusText.textContent = labels[status] || status;
  stateTitle.textContent = titles[status] || '语音助理';
  stateDetail.textContent = details[status] || '实时文字内容已隐藏';
}

// --- Listen for messages from service worker ---

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'stream_chunk':
      break;

    case 'stream_end':
      showActivity('语音回复完成');
      break;

    case 'stream_error':
      showActivity('回复出错：' + msg.error);
      break;

    case 'user_transcript':
      break;

    case 'user_transcript_done':
      showActivity('已收到你的语音');
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
