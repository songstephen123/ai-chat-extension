// Service Worker: Side Panel init + GLM-Realtime voice via native proxy + tool routing

const REALTIME_MODEL = 'glm-realtime';

let realtimePort = null;
let voiceActive = false;
let realtimeSessionReady = false;
let aiSpeaking = false;
let pendingToolResponse = false;

// --- Side Panel init ---

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// --- Config ---

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get({
      apiKey: '',
      glmApiKey: '',
    }, (values) => {
      resolve({
        apiKey: values.apiKey || '',
        glmApiKey: values.glmApiKey || '',
      });
    });
  });
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
          result = await executeNativeCommand('lark', { action: 'calendar', ...calendarArgs });
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
  const config = await getConfig();
  const apiKey = config.glmApiKey || config.apiKey;
  if (!apiKey) {
    broadcastToSidePanel({ type: 'voice_status', status: 'error: 请先在设置中配置 API Key' });
    return;
  }

  realtimeSessionReady = false;
  broadcastToSidePanel({ type: 'voice_status', status: 'connecting' });

  try {
    realtimePort = chrome.runtime.connectNative('com.aichat.nativehost');
  } catch (e) {
    broadcastToSidePanel({ type: 'voice_status', status: 'error: 连接创建失败' });
    return;
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
        broadcastToSidePanel({ type: 'voice_status', status: 'error: ' + msg.error });
        cleanupVoice();
        break;
      case 'realtime_disconnected':
        cleanupVoice();
        break;
    }
  });

  realtimePort.onDisconnect.addListener(() => {
    if (voiceActive) {
      cleanupVoice();
    }
  });

  realtimePort.postMessage({ command: 'realtime', api_key: apiKey });
}

function cleanupVoice() {
  voiceActive = false;
  realtimeSessionReady = false;
  if (realtimePort) {
    realtimePort.disconnect();
    realtimePort = null;
  }
  broadcastToSidePanel({ type: 'voice_status', status: 'stopped' });
}

function stopVoiceMode() {
  cleanupVoice();
}

function sendSessionUpdate() {
  if (!realtimePort) return;

  realtimePort.postMessage({
    type: 'session.update',
    session: {
      model: REALTIME_MODEL,
      voice: 'tongtong',
      input_audio_format: 'pcm24',
      output_audio_format: 'pcm',
      input_audio_noise_reduction: { type: 'far_field' },
      turn_detection: null,
      tools: TOOLS.map(t => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
      beta_fields: {
        chat_mode: 'audio',
        tts_source: 'e2e',
        greeting_config: {
          enable: true,
          content: '你好，我是你的AI助理，有什么可以帮助你的吗？',
        },
      },
    },
  });
}

function handleRealtimeEvent(event) {
  switch (event.type) {
    case 'session.created':
      sendSessionUpdate();
      break;

    case 'session.updated':
      realtimeSessionReady = true;
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
      startVoiceMode();
      sendResponse({ ok: true });
      break;
    case 'voice_stop':
      stopVoiceMode();
      sendResponse({ ok: true });
      break;
  }
  return true;
});

// --- Broadcast to side panel ---

function broadcastToSidePanel(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}
