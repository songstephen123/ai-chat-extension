const providerDefaults = {
  glm: {
    model: 'glm-realtime',
    voice: 'tongtong',
  },
  doubao: {
    model: '1.2.1.1',
    voice: '',
    resourceId: 'volc.speech.dialog',
    endpoint: 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue',
  },
};

const fields = [
  'realtimeProvider',
  'realtimeModel',
  'realtimeVoice',
  'glmApiKey',
  'doubaoApiKey',
  'doubaoAppId',
  'doubaoAppKey',
  'doubaoAccessKey',
  'doubaoResourceId',
  'doubaoEndpoint',
];
const defaults = {
  realtimeProvider: 'glm',
  realtimeModel: providerDefaults.glm.model,
  realtimeVoice: providerDefaults.glm.voice,
  glmApiKey: '',
  doubaoApiKey: '',
  doubaoAppId: '',
  doubaoAppKey: '',
  doubaoAccessKey: '',
  doubaoResourceId: providerDefaults.doubao.resourceId,
  doubaoEndpoint: providerDefaults.doubao.endpoint,
};

// Load saved values
chrome.storage.local.get(defaults, (values) => {
  for (const key of fields) {
    const el = document.getElementById(key);
    if (el) el.value = values[key] || '';
  }
});

document.getElementById('realtimeProvider').addEventListener('change', (event) => {
  const preset = providerDefaults[event.target.value];
  if (!preset) return;
  document.getElementById('realtimeModel').value = preset.model;
  document.getElementById('realtimeVoice').value = preset.voice;
  if (preset.resourceId) document.getElementById('doubaoResourceId').value = preset.resourceId;
  if (preset.endpoint) document.getElementById('doubaoEndpoint').value = preset.endpoint;
});

// Save
document.getElementById('btn-save').addEventListener('click', () => {
  const data = {};
  for (const key of fields) {
    const el = document.getElementById(key);
    if (el) data[key] = el.value;
  }
  chrome.storage.local.set(data, () => {
    const status = document.getElementById('save-status');
    status.classList.remove('hidden');
    setTimeout(() => status.classList.add('hidden'), 2000);
  });
});

// Check native host
(async () => {
  const el = document.getElementById('larkStatus');
  try {
    const result = await new Promise((resolve) => {
      chrome.runtime.sendNativeMessage('com.aichat.nativehost', { command: 'ping' }, resolve);
    });
    if (result?.success) {
      el.textContent = '已连接';
      el.style.color = '#a6e3a1';
    } else {
      el.textContent = '未连接 — 请运行 install.sh';
      el.style.color = '#f38ba8';
    }
  } catch {
    el.textContent = '未安装 — 请运行 native-host/install.sh';
    el.style.color = '#f38ba8';
  }
})();
