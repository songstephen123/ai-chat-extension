// Service Worker: floating widget + realtime voice provider adapter + tool routing

const REALTIME_PROVIDERS = {
  glm: {
    id: 'glm',
    label: 'GLM Realtime',
    nativeCommand: 'realtime',
    apiKeyField: 'glmApiKey',
    defaultModel: 'glm-realtime',
    defaultVoice: 'tongtong',
    inputAudioFormat: 'pcm24',
    outputAudioFormat: 'pcm',
    supportsNoiseReduction: true,
    betaFields: {
      chat_mode: 'audio',
      tts_source: 'e2e',
      greeting_config: {
        enable: true,
        content: '你好，我是你的AI助理，有什么可以帮助你的吗？',
      },
    },
  },
  doubao: {
    id: 'doubao',
    label: '豆包端到端实时语音',
    nativeCommand: 'realtime',
    protocol: 'volc_dialogue',
    defaultEndpoint: 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue',
    defaultModel: '1.2.1.1',
    defaultVoice: '',
    defaultResourceId: 'volc.speech.dialog',
    inputAudioFormat: 'speech_opus',
    outputAudioFormat: 'ogg_opus',
    supportsNoiseReduction: false,
  },
};

let realtimePort = null;
let voiceActive = false;
let realtimeSessionReady = false;
let aiSpeaking = false;
let pendingToolResponse = false;
let activeVoiceTabId = null;
let realtimeConnectTimer = null;
let activeRealtimeAdapter = REALTIME_PROVIDERS.glm;
let activeRealtimeConfig = {
  model: REALTIME_PROVIDERS.glm.defaultModel,
  voice: REALTIME_PROVIDERS.glm.defaultVoice,
};

// --- Browser action: prefer the in-page floating widget ---

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) {
    chrome.runtime.openOptionsPage();
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle_widget' });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['lib/Readability.min.js', 'content/content.js'],
      });
      await chrome.tabs.sendMessage(tab.id, { type: 'toggle_widget' });
    } catch (innerError) {
      chrome.runtime.openOptionsPage();
    }
  }
});

// --- Config ---

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get({
      apiKey: '',
      glmApiKey: '',
      doubaoApiKey: '',
      doubaoAppId: '',
      doubaoAppKey: '',
      doubaoAccessKey: '',
      doubaoResourceId: REALTIME_PROVIDERS.doubao.defaultResourceId,
      doubaoEndpoint: REALTIME_PROVIDERS.doubao.defaultEndpoint,
      realtimeProvider: 'glm',
      realtimeModel: REALTIME_PROVIDERS.glm.defaultModel,
      realtimeVoice: REALTIME_PROVIDERS.glm.defaultVoice,
    }, (values) => {
      resolve({
        apiKey: values.apiKey || '',
        glmApiKey: values.glmApiKey || '',
        doubaoApiKey: values.doubaoApiKey || '',
        doubaoAppId: values.doubaoAppId || '',
        doubaoAppKey: values.doubaoAppKey || '',
        doubaoAccessKey: values.doubaoAccessKey || '',
        doubaoResourceId: values.doubaoResourceId || REALTIME_PROVIDERS.doubao.defaultResourceId,
        doubaoEndpoint: values.doubaoEndpoint || REALTIME_PROVIDERS.doubao.defaultEndpoint,
        realtimeProvider: values.realtimeProvider || 'glm',
        realtimeModel: values.realtimeModel || REALTIME_PROVIDERS.glm.defaultModel,
        realtimeVoice: values.realtimeVoice || REALTIME_PROVIDERS.glm.defaultVoice,
      });
    });
  });
}

function getRealtimeAdapter(config) {
  const providerId = config.realtimeProvider || 'glm';
  return REALTIME_PROVIDERS[providerId] || null;
}

function getRealtimeApiKey(config, adapter) {
  if (adapter.protocol === 'volc_dialogue') return '';
  const providerKey = config[adapter.apiKeyField] || '';
  return providerKey || config.apiKey || config.glmApiKey || '';
}

function getRealtimeCredentials(config, adapter) {
  if (adapter.protocol === 'volc_dialogue') {
    return {
      app_id: config.doubaoAppId,
      app_key: config.doubaoAppKey || config.doubaoApiKey,
      access_key: config.doubaoAccessKey,
      resource_id: config.doubaoResourceId || adapter.defaultResourceId,
      endpoint: config.doubaoEndpoint || adapter.defaultEndpoint,
    };
  }
  return {
    api_key: getRealtimeApiKey(config, adapter),
  };
}

function validateRealtimeCredentials(credentials, adapter) {
  if (adapter.protocol !== 'volc_dialogue') {
    return credentials.api_key ? '' : `请先在设置中配置 ${adapter.label} API Key`;
  }
  const missing = [];
  if (!credentials.app_id) missing.push('App ID');
  if (!credentials.app_key) missing.push('App Key');
  if (!credentials.access_key) missing.push('Access Key');
  if (!credentials.resource_id) missing.push('Resource ID');
  if (!credentials.endpoint) missing.push('Endpoint');
  return missing.length ? `请先在设置中配置豆包端到端实时语音：${missing.join('、')}` : '';
}

// --- Tool definitions (GLM-Realtime Function Calling) ---

const TOOLS = [
  {
    type: 'function',
    name: 'get_page_content',
    description: '获取当前浏览器页面的内容，包括标题和正文',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '用户关于页面内容的问题或需求' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'lark_search_docs',
    description: '搜索飞书文档',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'lark_create_doc',
    description: '创建飞书文档',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '文档标题' },
        content: { type: 'string', description: '文档内容（Markdown 格式）' },
      },
      required: ['title', 'content'],
    },
  },
  {
    type: 'function',
    name: 'lark_send_message',
    description: '发送飞书消息',
    parameters: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: '飞书聊天 ID' },
        text: { type: 'string', description: '消息内容' },
      },
      required: ['text'],
    },
  },
  {
    type: 'function',
    name: 'lark_calendar',
    description: '查看或管理飞书日历日程',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['agenda', 'create', 'search'], description: '操作类型' },
        args: { type: 'string', description: '操作参数（JSON 格式）' },
      },
      required: ['action'],
    },
  },
  {
    type: 'function',
    name: 'lark_create_task',
    description: '创建飞书任务',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', description: '任务标题' } },
      required: ['title'],
    },
  },
  {
    type: 'function',
    name: 'lark_search_contact',
    description: '搜索飞书联系人',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'lark_fetch_doc',
    description: '获取飞书文档内容',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '飞书文档 URL 或文档 ID' },
      },
      required: ['url'],
    },
  },
  {
    type: 'function',
    name: 'lark_cli_help',
    description: '查看 Lark CLI 命令帮助，用于发现飞书 CLI 支持的业务域、快捷命令、参数和用法',
    parameters: {
      type: 'object',
      properties: {
        argv: {
          type: 'array',
          items: { type: 'string' },
          description: 'lark-cli 后面的参数数组，例如 ["calendar", "--help"] 或 ["docs", "+search", "--help"]。不要包含 lark-cli 本身。',
        },
      },
      required: ['argv'],
    },
  },
  {
    type: 'function',
    name: 'lark_cli_schema',
    description: '查看 Lark CLI 某个 OpenAPI 方法的参数、scope、风险级别和类型定义',
    parameters: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          description: 'API 方法名，例如 calendar.events.create、im.message.create、drive.file.list',
        },
        format: {
          type: 'string',
          enum: ['json', 'pretty'],
          description: '输出格式，默认 json',
        },
      },
      required: ['method'],
    },
  },
  {
    type: 'function',
    name: 'lark_cli_capabilities',
    description: '查询 Lark CLI 可用业务域、常见任务和推荐调用方式。处理复杂飞书请求前先调用它；domain 传空字符串可查看总览。',
    parameters: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: '业务域名称，例如 docs、drive、base、sheets、slides、im、calendar、task、wiki；空字符串表示总览',
        },
      },
      required: ['domain'],
    },
  },
  {
    type: 'function',
    name: 'lark_cli_shortcut',
    description: '执行 Lark CLI 的 +shortcut 命令。适合 docs +search、sheets +create、calendar +agenda、im +messages-send 等快捷能力；args 用 JSON 字符串传参数。',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', description: '业务域，例如 docs、drive、base、sheets、calendar、im、task' },
        shortcut: { type: 'string', description: '以 + 开头的 shortcut，例如 +search、+create、+fetch、+agenda、+messages-send' },
        args: { type: 'string', description: '参数 JSON 对象字符串，例如 {"query":"项目复盘"} 或 {"title":"周报"}' },
        as: { type: 'string', enum: ['user', 'bot'], description: '调用身份。个人资源通常 user，应用资源通常 bot' },
        format: { type: 'string', enum: ['json', 'ndjson', 'table', 'csv', 'pretty'], description: '输出格式，默认由 CLI 决定' },
        page_all: { type: 'boolean', description: '是否自动分页获取全部结果' },
        jq: { type: 'string', description: 'jq 过滤表达式，用于裁剪输出' },
        dry_run: { type: 'boolean', description: '只预览请求，不实际执行写入/删除/权限变更' },
        timeout_seconds: { type: 'number', description: '超时时间，默认 60 秒，最大 180 秒' },
      },
      required: ['service', 'shortcut'],
    },
  },
  {
    type: 'function',
    name: 'lark_cli_api_command',
    description: '执行 Lark CLI 的 service resource method 结构化 API 命令，例如 calendar events create、base records list。比 raw API 更适合模型调用。',
    parameters: {
      type: 'object',
      properties: {
        service: { type: 'string', description: '业务域，例如 calendar、base、drive、wiki、mail、approval' },
        resource: { type: 'string', description: '资源名，例如 events、records、files、spaces、messages' },
        method: { type: 'string', description: '方法名，例如 list、get、create、update、delete' },
        params: { type: 'string', description: 'URL/query 参数 JSON 字符串，可省略' },
        data: { type: 'string', description: '请求体 JSON 字符串，可省略' },
        as: { type: 'string', enum: ['user', 'bot'], description: '调用身份。个人资源通常 user，应用资源通常 bot' },
        format: { type: 'string', enum: ['json', 'ndjson', 'table', 'csv', 'pretty'], description: '输出格式，默认 json' },
        page_all: { type: 'boolean', description: '是否自动分页获取全部结果' },
        jq: { type: 'string', description: 'jq 过滤表达式，用于裁剪输出' },
        dry_run: { type: 'boolean', description: '只预览请求，不实际执行写入/删除/权限变更' },
        timeout_seconds: { type: 'number', description: '超时时间，默认 60 秒，最大 180 秒' },
      },
      required: ['service', 'resource', 'method'],
    },
  },
  {
    type: 'function',
    name: 'lark_cli_api',
    description: '通过 Lark CLI 的 raw API 模式调用飞书开放平台接口，可覆盖 shortcuts 未封装的 API',
    parameters: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], description: 'HTTP 方法' },
        path: { type: 'string', description: 'OpenAPI 路径，例如 /open-apis/calendar/v4/calendars' },
        params: { type: 'string', description: 'URL/query 参数 JSON 字符串，可省略' },
        data: { type: 'string', description: '请求体 JSON 字符串，可省略' },
        as: { type: 'string', enum: ['user', 'bot'], description: '调用身份，可省略' },
        page_all: { type: 'boolean', description: '是否自动分页获取全部结果' },
        jq: { type: 'string', description: 'jq 过滤表达式，用于裁剪输出' },
        dry_run: { type: 'boolean', description: '只预览请求，不实际执行写入' },
      },
      required: ['method', 'path'],
    },
  },
  {
    type: 'function',
    name: 'lark_cli_run',
    description: '执行任意 Lark CLI 业务命令，用于使用 docs、drive、base、sheets、slides、im、mail、calendar、task、wiki、approval、okr、minutes、vc、whiteboard 等全部能力。优先先用 lark_cli_help 或 lark_cli_schema 确认参数。',
    parameters: {
      type: 'object',
      properties: {
        argv: {
          type: 'array',
          items: { type: 'string' },
          description: 'lark-cli 后面的参数数组，例如 ["sheets", "+create", "--title", "周报"]。不要包含 lark-cli 本身，不要使用 shell 字符串。',
        },
        timeout_seconds: { type: 'number', description: '超时时间，默认 60 秒，最大 180 秒' },
        dry_run: { type: 'boolean', description: '对写操作先追加 --dry-run 预览请求' },
      },
      required: ['argv'],
    },
  },
  {
    type: 'function',
    name: 'lark_cli_passthrough',
    description: 'Lark CLI 接近完整能力透传通道。用 JSON array 字符串传 lark-cli 后面的完整 argv；native host 不经 shell 执行，只阻止 auth/config/profile/update、--yes 和非 Lark 业务命令。',
    parameters: {
      type: 'object',
      properties: {
        argv_json: {
          type: 'string',
          description: 'JSON 数组字符串，例如 ["base","records","list","--params","{\\"app_token\\":\\"xxx\\"}","--page-all"]。不要传 shell 字符串。',
        },
        timeout_seconds: { type: 'number', description: '超时时间，默认 60 秒，最大 180 秒' },
        dry_run: { type: 'boolean', description: '对写入、删除、权限、批量操作先追加 --dry-run 预览请求' },
      },
      required: ['argv_json'],
    },
  },
  {
    type: 'function',
    name: 'lark_doc_to_frontend_slides',
    description: '读取飞书文档，并使用 frontend-slides skill 准备或生成精美 HTML/PPT 风格演示稿',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '飞书文档 URL 或文档 ID' },
        title: { type: 'string', description: '演示稿标题，可省略' },
        mode: {
          type: 'string',
          enum: ['prepare', 'generate'],
          description: 'prepare 只生成转换工作包；generate 会尝试调用本机 Claude Code + frontend-slides 直接生成 HTML',
        },
        style: {
          type: 'string',
          description: '期望视觉风格，例如 Bold Signal、Swiss Modern、Dark Botanical、Neon Cyber；省略则自动选择',
        },
        slide_count: {
          type: 'number',
          description: '期望页数，默认 10-14 页',
        },
      },
      required: ['url'],
    },
  },
  {
    type: 'function',
    name: 'lark_update_doc',
    description: '更新飞书文档内容（追加、覆盖或替换）',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '飞书文档 URL 或文档 ID' },
        content: { type: 'string', description: '要写入的内容（Markdown 格式）' },
        mode: { type: 'string', enum: ['append', 'overwrite'], description: '写入模式：append 追加，overwrite 覆盖' },
      },
      required: ['url', 'content'],
    },
  },
  {
    type: 'function',
    name: 'generate_html_slides',
    description: '根据内容生成 HTML 幻灯片演示文稿',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '幻灯片标题' },
        content: { type: 'string', description: '幻灯片内容大纲（Markdown）' },
        style: { type: 'string', enum: ['dark', 'light', 'terminal', 'neon'], description: '视觉风格' },
      },
      required: ['title', 'content'],
    },
  },
  {
    type: 'function',
    name: 'open_file',
    description: '在浏览器中打开本地文件',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } },
      required: ['path'],
    },
  },
];

// --- Tool execution ---

async function executeTool(name, args) {
  broadcastToSidePanel({ type: 'tool_call', name, status: `正在执行 ${name}...` });

  let result;
  try {
    switch (name) {
      case 'get_page_content':
        result = await getPageContent();
        break;
      case 'lark_search_docs':
        result = await executeNativeCommand('lark', { action: 'search_docs', query: args.query });
        break;
      case 'lark_create_doc':
        result = await executeNativeCommand('lark', { action: 'create_doc', title: args.title, content: args.content });
        break;
      case 'lark_send_message':
        result = await executeNativeCommand('lark', { action: 'send_message', chat_id: args.chat_id, text: args.text });
        break;
      case 'lark_calendar':
        try {
          const calendarArgs = typeof args.args === 'string' ? JSON.parse(args.args) : (args.args || {});
          result = await executeNativeCommand('lark', { action: 'calendar', action_type: args.action, ...calendarArgs });
        } catch (e) {
          result = await executeNativeCommand('lark', { action: 'calendar', action_type: args.action });
        }
        break;
      case 'lark_create_task':
        result = await executeNativeCommand('lark', { action: 'create_task', title: args.title });
        break;
      case 'lark_search_contact':
        result = await executeNativeCommand('lark', { action: 'search_contact', query: args.query });
        break;
      case 'lark_fetch_doc':
        result = await executeNativeCommand('lark', { action: 'fetch_doc', url: args.url });
        break;
      case 'lark_cli_help':
        result = await executeNativeCommand('lark', { action: 'cli_help', argv: args.argv || [] });
        break;
      case 'lark_cli_schema':
        result = await executeNativeCommand('lark', { action: 'schema', method: args.method, format: args.format || 'json' });
        break;
      case 'lark_cli_capabilities':
        result = await executeNativeCommand('lark', { action: 'capabilities', domain: args.domain || '' });
        break;
      case 'lark_cli_shortcut':
        result = await executeNativeCommand('lark', {
          action: 'shortcut',
          service: args.service,
          shortcut: args.shortcut,
          args: args.args || {},
          as: args.as,
          format: args.format,
          page_all: args.page_all,
          jq: args.jq,
          dry_run: args.dry_run,
          timeout_seconds: args.timeout_seconds,
        });
        break;
      case 'lark_cli_api_command':
        result = await executeNativeCommand('lark', {
          action: 'api_command',
          service: args.service,
          resource: args.resource,
          method: args.method,
          params: args.params,
          data: args.data,
          as: args.as,
          format: args.format,
          page_all: args.page_all,
          jq: args.jq,
          dry_run: args.dry_run,
          timeout_seconds: args.timeout_seconds,
        });
        break;
      case 'lark_cli_api':
        result = await executeNativeCommand('lark', {
          action: 'api',
          method: args.method,
          path: args.path,
          params: args.params,
          data: args.data,
          as: args.as,
          page_all: args.page_all,
          jq: args.jq,
          dry_run: args.dry_run,
        });
        break;
      case 'lark_cli_run':
        result = await executeNativeCommand('lark', {
          action: 'run',
          argv: args.argv,
          timeout_seconds: args.timeout_seconds,
          dry_run: args.dry_run,
        });
        break;
      case 'lark_cli_passthrough':
        result = await executeNativeCommand('lark', {
          action: 'passthrough',
          argv_json: args.argv_json,
          timeout_seconds: args.timeout_seconds,
          dry_run: args.dry_run,
        });
        break;
      case 'lark_doc_to_frontend_slides':
        result = await executeNativeCommand('frontend_slides', {
          url: args.url,
          title: args.title,
          mode: args.mode || 'prepare',
          style: args.style,
          slide_count: args.slide_count,
        });
        break;
      case 'lark_update_doc':
        result = await executeNativeCommand('lark', { action: 'update_doc', url: args.url, content: args.content, mode: args.mode || 'append' });
        break;
      case 'generate_html_slides':
        result = await executeNativeCommand('slides', args);
        break;
      case 'open_file':
        result = await executeNativeCommand('open', { path: args.path });
        break;
      default:
        result = { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    result = { error: e.message };
  }

  broadcastToSidePanel({ type: 'tool_done' });
  return result;
}

async function getPageContent() {
  // Query all active tabs across all windows (side panel context may not be the browser window)
  const allTabs = await chrome.tabs.query({ active: true });
  const tab = allTabs.find(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'));
  if (!tab) return { error: 'No accessible tab found' };
  console.log('[PageContent] targeting tab:', tab.url);

  // Try content script first
  const result = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: 'get_page_content' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
  if (result) return result;

  // Fallback: inject Readability + extraction script
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['lib/Readability.min.js'],
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        try {
          const article = new Readability(document.cloneNode(true)).parse();
          let text = article?.textContent || document.body.innerText.slice(0, 5000);
          if (text.length > 5000) text = text.slice(0, 4000) + '\n\n...[truncated]...\n\n' + text.slice(-1000);
          return { title: article?.title || document.title, text, url: location.href };
        } catch (e) {
          return { title: document.title, text: document.body.innerText.slice(0, 5000), url: location.href, error: e.message };
        }
      },
    });
    return results[0]?.result || { error: 'No result from script' };
  } catch (e) {
    return { error: e.message };
  }
}

async function executeNativeCommand(command, args) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage('com.aichat.nativehost', {
      command,
      args,
    }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(response);
      }
    });
  });
}

// --- Voice mode (Native Messaging WebSocket proxy) ---

async function startVoiceMode() {
  if (realtimePort) {
    cleanupVoice({ silent: true });
  }

  const config = await getConfig();
  const adapter = getRealtimeAdapter(config);
  if (!adapter) {
    const message = `不支持的实时语音 Provider：${config.realtimeProvider}`;
    broadcastToSidePanel({ type: 'voice_status', status: 'error: ' + message });
    return { ok: false, error: message };
  }

  const credentials = getRealtimeCredentials(config, adapter);
  const credentialError = validateRealtimeCredentials(credentials, adapter);
  if (credentialError) {
    broadcastToSidePanel({ type: 'voice_status', status: 'error: ' + credentialError });
    return { ok: false, error: credentialError };
  }
  if (adapter.protocol === 'volc_dialogue') {
    const message = '豆包端到端实时语音使用火山 openspeech 二进制 dialogue 协议，已完成配置项对齐；还需要实现 StartConnection/StartSession/Opus 音频帧协议后才能开始会话。';
    broadcastToSidePanel({ type: 'voice_status', status: 'error: ' + message });
    return { ok: false, error: message };
  }

  activeRealtimeAdapter = adapter;
  activeRealtimeConfig = {
    model: config.realtimeModel || adapter.defaultModel,
    voice: config.realtimeVoice || adapter.defaultVoice,
  };
  realtimeSessionReady = false;
  broadcastToSidePanel({ type: 'voice_status', status: 'starting' });
  if (realtimeConnectTimer) clearTimeout(realtimeConnectTimer);
  realtimeConnectTimer = setTimeout(() => {
    if (!realtimeSessionReady) {
      broadcastToSidePanel({ type: 'voice_status', status: 'error: 连接超时，请检查 Native Host、网络或 API Key' });
      cleanupVoice({ silent: true });
    }
  }, 12000);

  try {
    realtimePort = chrome.runtime.connectNative('com.aichat.nativehost');
  } catch (e) {
    broadcastToSidePanel({ type: 'voice_status', status: 'error: 连接创建失败' });
    return { ok: false, error: '连接创建失败：' + e.message };
  }

  realtimePort.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'realtime_connected':
        voiceActive = true;
        break;
      case 'realtime_event':
        handleRealtimeEvent(msg.event);
        break;
      case 'realtime_error':
        console.error('[Voice] realtime error:', msg.error);
        if (realtimeConnectTimer) {
          clearTimeout(realtimeConnectTimer);
          realtimeConnectTimer = null;
        }
        broadcastToSidePanel({ type: 'voice_status', status: 'error: ' + msg.error });
        voiceActive = false;
        realtimeSessionReady = false;
        if (realtimePort) {
          realtimePort.disconnect();
          realtimePort = null;
        }
        break;
      case 'realtime_disconnected':
        cleanupVoice();
        break;
    }
  });

  realtimePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message;
    const wasReady = realtimeSessionReady || voiceActive;
    realtimePort = null;
    voiceActive = false;
    realtimeSessionReady = false;
    if (realtimeConnectTimer) {
      clearTimeout(realtimeConnectTimer);
      realtimeConnectTimer = null;
    }
    if (error) {
      broadcastToSidePanel({ type: 'voice_status', status: 'error: Native Host 连接断开：' + error });
    } else if (wasReady) {
      broadcastToSidePanel({ type: 'voice_status', status: 'stopped' });
    } else {
      broadcastToSidePanel({ type: 'voice_status', status: 'error: Native Host 未能启动或已退出' });
    }
  });

  realtimePort.postMessage({
    command: adapter.nativeCommand,
    provider: adapter.id,
    ...credentials,
    model: activeRealtimeConfig.model,
  });
  return { ok: true };
}

function cleanupVoice(options = {}) {
  voiceActive = false;
  realtimeSessionReady = false;
  if (realtimeConnectTimer) {
    clearTimeout(realtimeConnectTimer);
    realtimeConnectTimer = null;
  }
  if (realtimePort) {
    realtimePort.disconnect();
    realtimePort = null;
  }
  if (!options.silent) {
    broadcastToSidePanel({ type: 'voice_status', status: 'stopped' });
  }
}

function stopVoiceMode() {
  cleanupVoice();
}

function sendSessionUpdate() {
  if (!realtimePort) return;
  const adapter = activeRealtimeAdapter || REALTIME_PROVIDERS.glm;
  const providerConfig = activeRealtimeConfig || {};
  const session = {
    model: providerConfig.model || adapter.defaultModel,
    voice: providerConfig.voice || adapter.defaultVoice,
    modalities: ['audio', 'text'],
    instructions: '你是一个全能AI助理，可以通过工具帮助用户完成各种任务。当用户请求以下操作时，你必须调用对应的工具函数：\n- 获取网页内容 → 调用 get_page_content\n- 常见飞书文档操作 → 优先调用 lark_search_docs、lark_fetch_doc、lark_create_doc、lark_update_doc\n- 把飞书文档变成精美演示稿/PPT/HTML slides → 调用 lark_doc_to_frontend_slides，用户明确要直接生成时使用 mode=generate，否则先用 mode=prepare\n- 发飞书消息 → 调用 lark_send_message；查看日历/创建日程 → 调用 lark_calendar；创建飞书任务 → 调用 lark_create_task；搜索联系人 → 调用 lark_search_contact\n- 任何复杂飞书/Lark 需求，先调用 lark_cli_capabilities 选择业务域；不确定命令或参数时调用 lark_cli_help；不确定 OpenAPI 方法、scope、风险级别时调用 lark_cli_schema\n- Lark CLI 调用优先级：1) +shortcut 命令用 lark_cli_shortcut，例如 docs +search、sheets +create、calendar +agenda；2) service resource method 命令用 lark_cli_api_command，例如 calendar events create、base records list；3) raw HTTP OpenAPI 才用 lark_cli_api；4) CLI 新增能力、复杂业务域或结构化工具覆盖不到时，用 lark_cli_passthrough 传完整 argv_json；5) 只有模型能稳定构造数组时才用 lark_cli_run\n- 使用 lark_cli_passthrough 时，argv_json 必须是 JSON 数组字符串，内容是 lark-cli 后面的参数，例如 ["base","records","list","--params","{\\"app_token\\":\\"xxx\\"}","--page-all"]。不要拼 shell 字符串，不要包含 lark-cli 本身\n- native host 允许 Lark 业务域、api、schema、help、doctor；阻止 auth/config/profile/update、--yes 和非 Lark 命令。因此不要因为工具有限就说不能调用 Lark CLI，优先 discovery 后 passthrough\n- 使用 lark_cli_shortcut 的 args 必须是 JSON 对象字符串；使用 lark_cli_api_command 的 params/data 也用 JSON 字符串\n- 个人资源（日历、云空间、邮箱、自己的文档）通常使用 as=user；应用/机器人资源通常使用 as=bot。权限不足时说明缺失授权，不要假装完成\n- 写入、删除、权限变更、批量操作先 dry_run=true 预览；高风险写操作如果返回 confirmation_required，需要先向用户说明风险并等待用户明确确认，不要自行绕过确认，也不要添加 --yes\n- 生成普通 HTML 幻灯片 → 调用 generate_html_slides；打开本地文件 → 调用 open_file\n不要说你做不到，优先发现可用 Lark CLI 命令并调用工具。',
    input_audio_format: adapter.inputAudioFormat,
    output_audio_format: adapter.outputAudioFormat,
    temperature: 0.7,
    max_response_output_tokens: 'inf',
    tools: TOOLS.map(t => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  };

  if (adapter.supportsNoiseReduction) {
    session.input_audio_noise_reduction = { type: 'far_field' };
  }
  if (adapter.betaFields) {
    session.beta_fields = adapter.betaFields;
  }

  // Client VAD mode: omit turn_detection entirely (null causes 400 errors)
  realtimePort.postMessage({
    type: 'session.update',
    session,
  });
}

function handleRealtimeEvent(event) {
  switch (event.type) {
    case 'session.created':
      sendSessionUpdate();
      break;

    case 'session.updated':
      realtimeSessionReady = true;
      if (realtimeConnectTimer) {
        clearTimeout(realtimeConnectTimer);
        realtimeConnectTimer = null;
      }
      // Delay mic start so greeting finishes playing first
      setTimeout(() => {
        if (realtimePort && voiceActive) {
          realtimePort.postMessage({ type: 'start_mic' });
        }
      }, 2000);
      broadcastToSidePanel({ type: 'voice_status', status: 'listening' });
      break;

    case 'input_audio_buffer.speech_started':
      console.log('[Voice] speech started');
      broadcastToSidePanel({ type: 'voice_status', status: 'speaking' });
      if (!aiSpeaking) {
        broadcastToSidePanel({ type: 'stop_playback' });
      }
      break;

    case 'input_audio_buffer.speech_stopped':
      console.log('[Voice] speech stopped');
      broadcastToSidePanel({ type: 'voice_status', status: 'thinking' });
      break;

    case 'response.audio.delta':
      if (event.delta) {
        aiSpeaking = true;
        broadcastToSidePanel({ type: 'play_audio', data: event.delta });
        broadcastToSidePanel({ type: 'voice_status', status: 'replying' });
      }
      break;

    case 'response.audio.done':
      broadcastToSidePanel({ type: 'audio_flush' });
      break;

    case 'response.text.delta':
      console.log('[Voice] text delta:', event.delta);
      if (event.delta) {
        broadcastToSidePanel({ type: 'stream_chunk', content: event.delta });
      }
      break;

    case 'response.audio_transcript.delta':
      if (event.delta) {
        broadcastToSidePanel({ type: 'stream_chunk', content: event.delta });
      }
      break;

    case 'response.text.done':
    case 'response.audio_transcript.done':
      broadcastToSidePanel({ type: 'stream_end' });
      break;

    case 'conversation.item.input_audio_transcription.completed':
      if (event.transcript) {
        broadcastToSidePanel({ type: 'user_transcript', text: event.transcript });
        broadcastToSidePanel({ type: 'user_transcript_done' });
      }
      break;

    case 'response.function_call_arguments.done':
      handleFunctionCall(event);
      break;

    case 'response.done':
      aiSpeaking = false;
      broadcastToSidePanel({ type: 'voice_status', status: 'listening' });
      // If a tool call was handled, send response.create after brief delay
      if (pendingToolResponse) {
        pendingToolResponse = false;
        setTimeout(() => {
          if (realtimePort && voiceActive) {
            realtimePort.postMessage({ type: 'response.create' });
            console.log('[Tool] sending response.create after tool result');
          }
        }, 500);
      }
      break;

    case 'error':
      broadcastToSidePanel({
        type: 'voice_status',
        status: 'error: ' + (event.error?.message || '未知错误'),
      });
      break;

    default:
      if (event.type === 'mic_debug') {
        console.log('[Mic]', event.msg);
      }
      break;
  }
}

async function handleFunctionCall(event) {
  const name = event.name;
  let args = {};
  try {
    args = event.arguments ? JSON.parse(event.arguments) : {};
  } catch {}

  const result = await executeTool(name, args);
  console.log('[Tool]', name, 'result:', JSON.stringify(result).slice(0, 200));

  if (realtimePort) {
    // Add function result to conversation immediately
    realtimePort.postMessage({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        output: JSON.stringify(result),
        object: 'realtime.item',
      },
    });

    // Don't send response.create here — it cancels the current response
    // Queue it for after response.done
    pendingToolResponse = true;
  }
}

// --- Message routing ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'voice_start':
      activeVoiceTabId = sender.tab?.id ?? null;
      startVoiceMode().then(sendResponse).catch((e) => {
        broadcastToSidePanel({ type: 'voice_status', status: 'error: ' + e.message });
        sendResponse({ ok: false, error: e.message });
      });
      break;
    case 'voice_stop':
      if (sender.tab?.id === activeVoiceTabId) {
        activeVoiceTabId = null;
      }
      stopVoiceMode();
      sendResponse({ ok: true });
      break;
    case 'open_options':
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      break;
  }
  return true;
});

// --- Broadcast to visible clients ---

function broadcastToSidePanel(msg) {
  const audioMessageTypes = new Set(['play_audio', 'stop_playback', 'audio_flush']);
  const sendToActiveTab = activeVoiceTabId !== null
    ? chrome.tabs.sendMessage(activeVoiceTabId, msg)
    : null;

  if (audioMessageTypes.has(msg.type)) {
    if (sendToActiveTab) {
      sendToActiveTab.catch(() => chrome.runtime.sendMessage(msg).catch(() => {}));
    } else {
      chrome.runtime.sendMessage(msg).catch(() => {});
    }
    return;
  }

  chrome.runtime.sendMessage(msg).catch(() => {});
  if (sendToActiveTab) {
    sendToActiveTab.catch(() => {});
  }
}
