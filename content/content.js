// Content script: page extraction + floating voice assistant widget.

let pageContent = null;

function extractContent() {
  try {
    const clonedDoc = document.cloneNode(true);
    const reader = new Readability(clonedDoc);
    const article = reader.parse();

    if (article) {
      let text = article.textContent || '';
      const MAX_FRONT = 4000;
      const MAX_END = 1000;
      if (text.length > MAX_FRONT + MAX_END) {
        text = text.slice(0, MAX_FRONT) + '\n\n...[内容已截断]...\n\n' + text.slice(-MAX_END);
      }
      pageContent = {
        title: article.title || document.title,
        text,
        url: window.location.href,
        excerpt: article.excerpt || '',
      };
    } else {
      pageContent = {
        title: document.title,
        text: document.body.innerText.slice(0, 5000),
        url: window.location.href,
        excerpt: '',
      };
    }
  } catch (e) {
    pageContent = {
      title: document.title,
      text: document.body.innerText.slice(0, 5000),
      url: window.location.href,
      error: e.message,
    };
  }
  return pageContent;
}

extractContent();

const WIDGET_ID = 'ai-voice-assistant-floating-widget';

let widgetRoot = null;
let voiceActive = false;
let playbackCtx = null;
let nextPlayTime = 0;
let dragState = null;
let voiceStartTimer = null;

function base64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

function playAudioChunk(base64PCM) {
  if (!playbackCtx) {
    playbackCtx = new AudioContext({ sampleRate: 24000 });
    nextPlayTime = 0;
  }
  if (playbackCtx.state === 'suspended') {
    playbackCtx.resume();
  }

  const int16 = base64ToInt16(base64PCM);
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

function widgetElements() {
  if (!widgetRoot) return {};
  return {
    host: document.getElementById(WIDGET_ID),
    panel: widgetRoot.querySelector('.panel'),
    button: widgetRoot.querySelector('.voice-button'),
    title: widgetRoot.querySelector('.title'),
    detail: widgetRoot.querySelector('.detail'),
    dot: widgetRoot.querySelector('.dot'),
    tool: widgetRoot.querySelector('.tool'),
    settings: widgetRoot.querySelector('.settings'),
    collapse: widgetRoot.querySelector('.collapse'),
  };
}

function setWidgetStatus(status) {
  const els = widgetElements();
  if (!els.title) return;

  const labels = {
    listening: ['正在听你说', '直接说出你的飞书、网页或演示稿需求'],
    speaking: ['正在收音', '不会显示实时转录内容'],
    thinking: ['正在思考', '正在理解你的请求'],
    replying: ['正在回复', '语音回复中'],
    connecting: ['正在连接', '建立实时语音通道'],
    starting: ['正在启动', '已收到请求，正在启动本机语音服务'],
    stopped: ['已停止', '点击按钮重新开始'],
  };

  if (status !== 'connecting' && voiceStartTimer) {
    clearTimeout(voiceStartTimer);
    voiceStartTimer = null;
  }

  if (status.startsWith('error: ')) {
    voiceActive = false;
    els.host.classList.remove('active');
    els.host.dataset.status = 'error';
    els.button.classList.remove('active');
    els.dot.className = 'dot error';
    els.title.textContent = '连接出错';
    els.detail.textContent = status.slice(7);
    return;
  }

  if (status === 'stopped') {
    voiceActive = false;
    els.host.classList.remove('active');
    els.button.classList.remove('active');
  }

  const [title, detail] = labels[status] || ['语音助理', '待命中'];
  els.host.dataset.status = status;
  els.dot.className = `dot ${status}`;
  els.title.textContent = title;
  els.detail.textContent = detail;
}

function setToolStatus(text) {
  const { tool } = widgetElements();
  if (!tool) return;
  if (text) {
    tool.textContent = text;
    tool.hidden = false;
  } else {
    tool.hidden = true;
    tool.textContent = '';
  }
}

function armVoiceStartWatchdog() {
  if (voiceStartTimer) {
    clearTimeout(voiceStartTimer);
  }
  voiceStartTimer = setTimeout(() => {
    if (voiceActive) {
      setWidgetStatus('error: 连接超时，请检查扩展后台、Native Host 或 API Key');
      stopPlayback();
    }
  }, 16000);
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      if (!chrome?.runtime?.id) {
        reject(new Error('Extension context invalidated.'));
        return;
      }
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
        } else {
          resolve(response);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

function normalizeRuntimeError(error) {
  const message = error?.message || String(error || '');
  if (message.includes('Extension context invalidated')) {
    return '扩展已重新加载，请刷新当前网页后再试';
  }
  return message;
}

async function startVoice() {
  voiceActive = true;
  const { host, button, panel } = widgetElements();
  host.classList.add('active');
  button.classList.add('active');
  panel.hidden = false;
  setWidgetStatus('connecting');
  armVoiceStartWatchdog();

  try {
    if (!playbackCtx) {
      playbackCtx = new AudioContext({ sampleRate: 24000 });
      nextPlayTime = 0;
    }
    if (playbackCtx.state === 'suspended') {
      playbackCtx.resume().catch((e) => {
        setToolStatus('音频播放初始化失败：' + e.message);
      });
    }
  } catch (e) {
    setToolStatus('音频播放初始化失败：' + e.message);
  }

  try {
    const response = await sendRuntimeMessage({ type: 'voice_start' });
    if (!response?.ok) {
      throw new Error(response?.error || '语音服务未能启动');
    }
  } catch (e) {
    setWidgetStatus('error: ' + normalizeRuntimeError(e));
    stopPlayback();
  }
}

function stopVoice() {
  voiceActive = false;
  const { host, button } = widgetElements();
  host.classList.remove('active');
  button.classList.remove('active');
  setToolStatus('');
  setWidgetStatus('stopped');
  stopPlayback();
  sendRuntimeMessage({ type: 'voice_stop' }).catch(() => {});
}

function toggleVoice() {
  if (voiceActive) {
    stopVoice();
  } else {
    startVoice();
  }
}

function savePosition(left, top) {
  try {
    localStorage.setItem('aiVoiceAssistantWidgetPosition', JSON.stringify({ left, top }));
  } catch {}
}

function restorePosition(host) {
  try {
    const saved = JSON.parse(localStorage.getItem('aiVoiceAssistantWidgetPosition') || 'null');
    if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
      host.style.left = `${Math.max(8, Math.min(saved.left, window.innerWidth - 72))}px`;
      host.style.top = `${Math.max(8, Math.min(saved.top, window.innerHeight - 72))}px`;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    }
  } catch {}
}

function injectFloatingWidget() {
  if (!document.body) return;

  const existing = document.getElementById(WIDGET_ID);
  if (existing) {
    if (widgetRoot && existing === widgetRoot.host) return;
    existing.remove();
  }

  const host = document.createElement('div');
  host.id = WIDGET_ID;
  host.setAttribute('aria-live', 'polite');
  widgetRoot = host.attachShadow({ mode: 'open' });
  widgetRoot.innerHTML = `
    <style>
      :host {
        all: initial;
      }
      .wrap {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        color: #eef2f8;
      }
      .panel {
        width: 224px;
        margin-bottom: 10px;
        padding: 12px;
        border: 1px solid rgba(75, 197, 189, 0.22);
        border-radius: 10px;
        background: rgba(17, 19, 24, 0.94);
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
        backdrop-filter: blur(12px);
      }
      .top {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: #8d98aa;
        flex: none;
      }
      .dot.listening { background: #59c878; animation: pulse 1.5s infinite; }
      .dot.speaking { background: #58a9f6; animation: pulse 0.8s infinite; }
      .dot.thinking { background: #f0b854; animation: pulse 1s infinite; }
      .dot.replying { background: #4bc5bd; animation: pulse 0.7s infinite; }
      .dot.connecting { background: #f17c56; animation: pulse 0.5s infinite; }
      .dot.error { background: #e45d55; }
      .copy {
        min-width: 0;
        flex: 1;
      }
      .title {
        font: 650 13px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        color: #eef2f8;
      }
      .detail {
        margin-top: 2px;
        font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        color: #8d98aa;
      }
      .controls {
        display: flex;
        gap: 4px;
        flex: none;
      }
      .icon-button {
        width: 26px;
        height: 26px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.05);
        color: #c6d0df;
        cursor: pointer;
        display: grid;
        place-items: center;
        padding: 0;
      }
      .tool {
        margin-top: 10px;
        padding: 8px;
        border-radius: 8px;
        background: rgba(75, 197, 189, 0.08);
        color: #8ee1dc;
        font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      }
      .voice-button {
        width: 52px;
        height: 52px;
        margin-left: auto;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 999px;
        background:
          radial-gradient(circle at 32% 22%, rgba(255, 255, 255, 0.46), transparent 25%),
          radial-gradient(circle at 72% 78%, rgba(255, 91, 177, 0.34), transparent 34%),
          linear-gradient(145deg, #22f6cf 0%, #32a6ff 58%, #7c5cff 100%);
        color: white;
        box-shadow:
          0 18px 36px rgba(8, 18, 28, 0.24),
          0 0 0 7px rgba(34, 246, 207, 0.12),
          0 0 28px rgba(50, 166, 255, 0.34),
          inset 0 1px 0 rgba(255, 255, 255, 0.42);
        cursor: grab;
        display: grid;
        place-items: center;
        touch-action: none;
        position: relative;
        overflow: hidden;
      }
      .voice-button::before {
        content: "";
        position: absolute;
        inset: 7px;
        border-radius: inherit;
        border: 1px solid rgba(255, 255, 255, 0.2);
        background:
          linear-gradient(150deg, rgba(255, 255, 255, 0.2), transparent 42%),
          rgba(5, 14, 23, 0.08);
      }
      .voice-button:active {
        cursor: grabbing;
        transform: scale(0.97);
      }
      .voice-button.active {
        background:
          radial-gradient(circle at 32% 22%, rgba(255, 255, 255, 0.42), transparent 25%),
          radial-gradient(circle at 76% 78%, rgba(255, 205, 85, 0.34), transparent 36%),
          linear-gradient(145deg, #ff7a5c 0%, #ff3f8f 58%, #8c4dff 100%);
        color: white;
        border-color: rgba(255, 255, 255, 0.18);
        box-shadow:
          0 18px 36px rgba(109, 23, 40, 0.24),
          0 0 0 7px rgba(255, 63, 143, 0.14),
          0 0 30px rgba(255, 122, 92, 0.3),
          inset 0 1px 0 rgba(255, 255, 255, 0.4);
      }
      .voice-button svg {
        pointer-events: none;
        position: relative;
        z-index: 1;
        filter: drop-shadow(0 2px 4px rgba(3, 12, 20, 0.24));
      }
      .voice-wave path {
        transform-box: fill-box;
        transform-origin: center;
        transition: opacity 0.18s ease, transform 0.18s ease;
      }
      :host([data-status="listening"]) .voice-wave path {
        animation: wave-breathe 1.45s ease-in-out infinite;
      }
      :host([data-status="speaking"]) .voice-wave path,
      :host([data-status="replying"]) .voice-wave path {
        animation: wave-dance 0.72s ease-in-out infinite;
      }
      :host([data-status="thinking"]) .voice-wave path {
        animation: wave-think 1.05s ease-in-out infinite;
      }
      .voice-wave path:nth-child(1) { animation-delay: -0.32s; }
      .voice-wave path:nth-child(2) { animation-delay: -0.18s; }
      .voice-wave path:nth-child(3) { animation-delay: 0s; }
      .voice-wave path:nth-child(4) { animation-delay: -0.24s; }
      .voice-wave path:nth-child(5) { animation-delay: -0.1s; }
      @keyframes pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.48; transform: scale(1.22); }
      }
      @keyframes wave-breathe {
        0%, 100% { transform: scaleY(0.72); opacity: 0.82; }
        50% { transform: scaleY(1.06); opacity: 1; }
      }
      @keyframes wave-dance {
        0%, 100% { transform: scaleY(0.55); }
        35% { transform: scaleY(1.24); }
        70% { transform: scaleY(0.82); }
      }
      @keyframes wave-think {
        0%, 100% { transform: translateY(0) scaleY(0.7); opacity: 0.78; }
        50% { transform: translateY(-1px) scaleY(1.12); opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .voice-wave path,
        .dot {
          animation: none !important;
        }
      }
      @media (max-width: 520px) {
        .wrap {
          right: 12px;
          bottom: 12px;
        }
      }
    </style>
    <div class="wrap">
      <section class="panel" hidden>
        <div class="top">
          <span class="dot stopped"></span>
          <div class="copy">
            <div class="title">语音助理</div>
            <div class="detail">点击按钮开始</div>
          </div>
          <div class="controls">
            <button class="icon-button settings" title="设置" aria-label="设置">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">
                <path d="M4 7h9"/><path d="M17 7h3"/><path d="M4 17h3"/><path d="M11 17h9"/>
                <circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>
              </svg>
            </button>
            <button class="icon-button collapse" title="收起" aria-label="收起">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M6 9l6 6 6-6"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="tool" hidden></div>
      </section>
      <button class="voice-button" title="语音助理" aria-label="语音助理">
        <svg class="voice-wave" width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round">
          <path d="M4.5 12h.01"/>
          <path d="M8 15.5v-7"/>
          <path d="M12 18.5v-13"/>
          <path d="M16 15.5v-7"/>
          <path d="M19.5 12h.01"/>
        </svg>
      </button>
    </div>
  `;
  document.documentElement.appendChild(host);

  const { button, panel, settings, collapse } = widgetElements();
  restorePosition(widgetRoot.querySelector('.wrap'));
  setWidgetStatus('stopped');

  button.addEventListener('click', (event) => {
    if (dragState?.moved) return;
    event.preventDefault();
    panel.hidden = false;
    toggleVoice();
  });

  button.addEventListener('pointerdown', (event) => {
    const wrap = widgetRoot.querySelector('.wrap');
    const rect = wrap.getBoundingClientRect();
    dragState = {
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    button.setPointerCapture(event.pointerId);
  });

  button.addEventListener('pointermove', (event) => {
    if (!dragState) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) dragState.moved = true;
    const wrap = widgetRoot.querySelector('.wrap');
    const left = Math.max(8, Math.min(dragState.left + dx, window.innerWidth - 58));
    const top = Math.max(8, Math.min(dragState.top + dy, window.innerHeight - 58));
    wrap.style.left = `${left}px`;
    wrap.style.top = `${top}px`;
    wrap.style.right = 'auto';
    wrap.style.bottom = 'auto';
  });

  button.addEventListener('pointerup', (event) => {
    const wrap = widgetRoot.querySelector('.wrap');
    const rect = wrap.getBoundingClientRect();
    savePosition(rect.left, rect.top);
    button.releasePointerCapture(event.pointerId);
    setTimeout(() => { dragState = null; }, 0);
  });

  settings.addEventListener('click', () => {
    sendRuntimeMessage({ type: 'open_options' }).catch((e) => {
      setWidgetStatus('error: ' + normalizeRuntimeError(e));
    });
  });
  collapse.addEventListener('click', () => {
    panel.hidden = true;
  });
}

function toggleWidgetPanel() {
  injectFloatingWidget();
  const { panel } = widgetElements();
  if (panel) {
    panel.hidden = !panel.hidden;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get_page_content') {
    sendResponse(extractContent());
    return true;
  }

  switch (msg.type) {
    case 'toggle_widget':
      toggleWidgetPanel();
      break;
    case 'voice_status':
      setWidgetStatus(msg.status);
      break;
    case 'tool_call':
      setToolStatus(msg.status || `正在调用 ${msg.name}...`);
      break;
    case 'tool_done':
      setToolStatus('');
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
    case 'stream_error':
      setToolStatus('回复出错：' + msg.error);
      break;
  }
  return false;
});

window.addEventListener('beforeunload', () => {
  if (voiceActive) {
    sendRuntimeMessage({ type: 'voice_stop' }).catch(() => {});
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectFloatingWidget, { once: true });
} else {
  injectFloatingWidget();
}
