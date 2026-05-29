const providerDefaults = {
  glm: {
    model: 'glm-realtime',
    voice: 'tongtong',
    voices: [
      { value: 'xiaochen', label: '通用男声 xiaochen' },
      { value: 'tongtong', label: '童童 tongtong' },
      { value: 'female-tianmei', label: '甜美女性 female-tianmei' },
      { value: 'female-shaonv', label: '少女 female-shaonv' },
      { value: 'male-qn-daxuesheng', label: '青年大学生 male-qn-daxuesheng' },
      { value: 'male-qn-jingying', label: '精英青年 male-qn-jingying' },
      { value: 'lovely_girl', label: '萌萌女童 lovely_girl' },
    ],
  },
  doubao: {
    model: '1.2.1.1',
    voice: '',
    voices: [
      { value: '', label: '使用模型默认音色' },
      { value: 'zh_female_vv_jupiter_bigtts', label: 'vv 活泼女声 zh_female_vv_jupiter_bigtts' },
      { value: 'zh_female_xiaohe_jupiter_bigtts', label: 'xiaohe 甜美女声 zh_female_xiaohe_jupiter_bigtts' },
      { value: 'zh_male_yunzhou_jupiter_bigtts', label: 'yunzhou 沉稳男声 zh_male_yunzhou_jupiter_bigtts' },
      { value: 'zh_male_xiaotian_jupiter_bigtts', label: 'xiaotian 磁性男声 zh_male_xiaotian_jupiter_bigtts' },
    ],
  },
};

const fields = [
  'realtimeProvider',
  'realtimeModel',
  'realtimeVoice',
  'glmApiKey',
  'doubaoAppId',
  'doubaoAccessKey',
];
const defaults = {
  realtimeProvider: 'glm',
  realtimeModel: providerDefaults.glm.model,
  realtimeVoice: providerDefaults.glm.voice,
  glmApiKey: '',
  doubaoAppId: '',
  doubaoAccessKey: '',
};

const storage = globalThis.chrome?.storage?.local;
const runtime = globalThis.chrome?.runtime;

function updateCredentialVisibility(provider) {
  for (const el of document.querySelectorAll('.provider-credential')) {
    const visible = el.dataset.provider === provider;
    el.hidden = !visible;
  }
}

function setVoiceOptions(provider, selectedValue = '') {
  const select = document.getElementById('realtimeVoice');
  if (!select) return;

  const preset = providerDefaults[provider] || providerDefaults.glm;
  const savedValue = selectedValue ?? preset.voice;
  select.innerHTML = '';

  for (const option of preset.voices) {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    select.appendChild(el);
  }

  const hasSavedValue = Array.from(select.options).some((option) => option.value === savedValue);
  if (savedValue && !hasSavedValue) {
    const custom = document.createElement('option');
    custom.value = savedValue;
    custom.textContent = `${savedValue}（已保存）`;
    select.appendChild(custom);
  }

  select.value = savedValue;
}

function applyValues(values) {
  const provider = values.realtimeProvider || defaults.realtimeProvider;
  for (const key of fields) {
    const el = document.getElementById(key);
    if (el && key !== 'realtimeVoice') el.value = values[key] || '';
  }
  setVoiceOptions(provider, values.realtimeVoice ?? providerDefaults[provider]?.voice ?? '');
  updateCredentialVisibility(provider);
}

// Load saved values
if (storage) {
  storage.get(defaults, applyValues);
} else {
  applyValues(defaults);
}

document.getElementById('realtimeProvider').addEventListener('change', (event) => {
  const preset = providerDefaults[event.target.value];
  if (!preset) return;
  document.getElementById('realtimeModel').value = preset.model;
  setVoiceOptions(event.target.value, preset.voice);
  updateCredentialVisibility(event.target.value);
});

// Save
document.getElementById('btn-save').addEventListener('click', () => {
  const data = {};
  for (const key of fields) {
    const el = document.getElementById(key);
    if (el) data[key] = el.value;
  }
  const showSaved = () => {
    const status = document.getElementById('save-status');
    status.classList.remove('hidden');
    setTimeout(() => status.classList.add('hidden'), 2000);
  };
  if (storage) {
    storage.set(data, showSaved);
  } else {
    showSaved();
  }
});

// Check native host
(async () => {
  const el = document.getElementById('larkStatus');
  if (!runtime?.sendNativeMessage) {
    el.textContent = '仅预览模式';
    el.style.color = '#a6adc8';
    return;
  }
  try {
    const result = await new Promise((resolve) => {
      runtime.sendNativeMessage('com.aichat.nativehost', { command: 'ping' }, resolve);
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
