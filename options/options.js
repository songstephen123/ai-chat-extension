const fields = ['glmApiKey'];
const defaults = { glmApiKey: '' };

// Load saved values
chrome.storage.local.get(defaults, (values) => {
  for (const key of fields) {
    const el = document.getElementById(key);
    if (el) el.value = values[key] || '';
  }
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
