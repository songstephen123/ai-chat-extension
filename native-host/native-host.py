#!/opt/homebrew/bin/python3
"""Native Messaging Host for AI Chat Extension.

Handles:
- Lark CLI commands (Feishu docs/messages)
- Slide generation
- File operations
- Realtime WebSocket proxy for GLM-Realtime voice mode
"""

import struct
import sys
import json
import subprocess
import os
import asyncio
import hmac
import hashlib
import base64
import time
import re

try:
    import websockets
except ImportError:
    websockets = None

try:
    import sounddevice as sd
except ImportError:
    sd = None

# --- Native Messaging I/O ---

def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None
    message_length = struct.unpack('=I', raw_length)[0]
    message = sys.stdin.buffer.read(message_length).decode('utf-8')
    return json.loads(message)

def send_message(message):
    encoded = json.dumps(message, ensure_ascii=False).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

# --- JWT for Zhipu API ---

def generate_jwt(api_key):
    parts = api_key.split('.', 1) if isinstance(api_key, str) else []
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError('Invalid Zhipu API key format. Expected "<id>.<secret>".')
    id_part, secret = parts
    now = int(time.time())
    header = base64.urlsafe_b64encode(
        json.dumps({"alg": "HS256", "sign_type": "SIGN"}).encode()
    ).rstrip(b'=').decode()
    payload = base64.urlsafe_b64encode(
        json.dumps({"api_key": id_part, "exp": now + 3600, "timestamp": now}).encode()
    ).rstrip(b'=').decode()
    sig = hmac.new(secret.encode(), f"{header}.{payload}".encode(), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).rstrip(b'=').decode()
    return f"{header}.{payload}.{sig_b64}"

# --- CLI command execution ---

LARK_CLI_BIN = 'lark-cli'
LARK_ALLOWED_ROOTS = {
    'api', 'schema', 'help', 'doctor',
    'approval', 'apps', 'attendance', 'base', 'calendar', 'contact',
    'docs', 'drive', 'event', 'im', 'mail', 'markdown', 'minutes',
    'okr', 'sheets', 'slides', 'task', 'vc', 'whiteboard', 'wiki',
}
LARK_BLOCKED_ARGS = {'--yes'}

LARK_CAPABILITY_CATALOG = {
    'docs': {
        'summary': '云文档 Docx：搜索、读取、创建、更新 Markdown 文档。',
        'shortcuts': ['+search', '+fetch', '+create', '+update'],
        'examples': [
            'docs +search --query "项目复盘"',
            'docs +fetch --doc <url-or-token> --doc-format markdown',
        ],
    },
    'drive': {
        'summary': '云空间：文件/文件夹上传下载、权限、评论、删除等。',
        'shortcuts': ['+upload', '+download', '+delete'],
        'examples': ['drive +upload --file ./report.pdf', 'drive +download --file-token <token>'],
    },
    'base': {
        'summary': '多维表格 Base：应用、数据表、字段、记录、视图、仪表盘、表单、自动化。',
        'shortcuts': ['+search', '+records-list', '+records-create', '+records-update'],
        'examples': ['base +search --query "客户"', 'base records list --format json'],
    },
    'sheets': {
        'summary': '电子表格：创建表格、工作表、范围读写、格式和数据处理。',
        'shortcuts': ['+create', '+read', '+write'],
        'examples': ['sheets +create --title "周报"', 'sheets +read --spreadsheet-token <token>'],
    },
    'slides': {
        'summary': '飞书幻灯片：创建演示文稿、读取/编辑页面和元素。',
        'shortcuts': ['+create'],
        'examples': ['slides +create --title "产品方案"'],
    },
    'im': {
        'summary': '即时通讯：发送消息、管理群聊、查询消息。',
        'shortcuts': ['+messages-send'],
        'examples': ['im +messages-send --chat-id <chat_id> --text "hello"'],
    },
    'calendar': {
        'summary': '日历：日程查询、创建、更新、参与人管理。',
        'shortcuts': ['+agenda', '+create'],
        'examples': ['calendar +agenda --as user', 'calendar events create --as user --data {...}'],
    },
    'task': {
        'summary': '任务：创建、查询、更新任务和清单。',
        'shortcuts': ['+create'],
        'examples': ['task +create --title "跟进合同"'],
    },
    'mail': {
        'summary': '邮箱：草稿、发送、回复、转发和邮件查询。',
        'shortcuts': [],
        'examples': ['mail messages list --as user --format json'],
    },
    'wiki': {
        'summary': '知识库：空间、节点、成员、文档树管理。',
        'shortcuts': [],
        'examples': ['wiki spaces list --format json'],
    },
    'approval': {'summary': '审批：审批定义、实例、任务查询与处理。', 'shortcuts': [], 'examples': []},
    'contact': {'summary': '通讯录：搜索用户、部门、邮箱/姓名解析 open_id。', 'shortcuts': ['+search-user'], 'examples': ['contact +search-user --query "张三"']},
    'minutes': {'summary': '妙记：按关键词、所有者、参与者查询妙记内容。', 'shortcuts': [], 'examples': []},
    'vc': {'summary': '视频会议：会议历史、纪要产物、章节、逐字稿。', 'shortcuts': [], 'examples': []},
    'whiteboard': {'summary': '画板：查询、编辑、导出画板。', 'shortcuts': [], 'examples': []},
    'okr': {'summary': 'OKR：周期、目标、关键结果查看和编辑。', 'shortcuts': [], 'examples': []},
    'attendance': {'summary': '考勤：查询自己的打卡和考勤记录。', 'shortcuts': [], 'examples': []},
    'apps': {'summary': '妙搭/应用：部署本地 HTML 应用等。', 'shortcuts': [], 'examples': []},
    'markdown': {'summary': 'Markdown 文档：查看、创建、上传、编辑和比较。', 'shortcuts': [], 'examples': []},
}

def run_command(cmd, timeout=60):
    try:
        env = os.environ.copy()
        env['PATH'] = '/Users/songstephen/.nvm/versions/node/v24.13.0/bin:/opt/homebrew/bin:/usr/local/bin:' + env.get('PATH', '')
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        return {
            'success': result.returncode == 0,
            'stdout': result.stdout[:10000],
            'stderr': result.stderr[:5000],
            'returncode': result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {'success': False, 'error': 'Command timed out'}
    except Exception as e:
        return {'success': False, 'error': str(e)}

def _parse_json_maybe(value):
    if value is None or value == '':
        return None
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)

def _object_from_json_maybe(value, field_name):
    if value is None or value == '':
        return {}
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            raise ValueError(f'{field_name} must be a JSON object string')
        if isinstance(parsed, dict):
            return parsed
    raise ValueError(f'{field_name} must be an object')

def _flag_name(key):
    name = str(key).strip().replace('_', '-')
    if not name:
        raise ValueError('flag name must not be empty')
    if name.startswith('-'):
        raise ValueError('flag names must be passed without leading dashes')
    return '--' + name

def _append_object_flags(argv, values):
    for key, value in values.items():
        flag = _flag_name(key)
        if flag in LARK_BLOCKED_ARGS:
            raise ValueError('--yes is blocked; high-risk writes must surface confirmation_required to the user')
        if value is None or value is False:
            continue
        if value is True:
            argv.append(flag)
            continue
        argv.append(flag)
        if isinstance(value, (dict, list)):
            argv.append(json.dumps(value, ensure_ascii=False))
        else:
            argv.append(str(value))
    return argv

def _append_common_lark_flags(argv, args):
    output_format = args.get('format')
    if output_format in ('json', 'ndjson', 'table', 'csv', 'pretty'):
        argv.extend(['--format', output_format])
    if args.get('as') in ('user', 'bot'):
        argv.extend(['--as', args.get('as')])
    if args.get('page_all'):
        argv.append('--page-all')
    if args.get('page_size'):
        argv.extend(['--page-size', str(args.get('page_size'))])
    if args.get('page_limit'):
        argv.extend(['--page-limit', str(args.get('page_limit'))])
    if args.get('page_delay'):
        argv.extend(['--page-delay', str(args.get('page_delay'))])
    if args.get('output'):
        argv.extend(['--output', str(args.get('output'))])
    if args.get('jq'):
        argv.extend(['--jq', str(args.get('jq'))])
    if args.get('dry_run'):
        argv.append('--dry-run')
    return argv

def _lark_capabilities(domain=''):
    domain = (domain or '').strip()
    recommended_flow = [
        '复杂或不熟悉的需求先查 lark_cli_capabilities，再查 lark_cli_help 或 lark_cli_schema。',
        '优先使用 shortcut 处理 +命令；service/resource/method API 用 api_command；底层 raw HTTP 才用 api。',
        '写入、删除、权限、批量操作先 dry_run；个人资源通常使用 --as user，应用资源使用 --as bot。',
    ]
    if domain:
        capability = LARK_CAPABILITY_CATALOG.get(domain)
        if not capability:
            return {
                'success': False,
                'error': f'Unknown Lark domain: {domain}',
                'domains': sorted(LARK_CAPABILITY_CATALOG.keys()),
            }
        return {
            'success': True,
            'domain': domain,
            'capability': capability,
            'recommended_flow': recommended_flow,
        }
    return {
        'success': True,
        'domains': sorted(LARK_CAPABILITY_CATALOG.keys()),
        'capabilities': LARK_CAPABILITY_CATALOG,
        'recommended_flow': recommended_flow,
    }

def _normalize_lark_argv(argv):
    if argv is None:
        argv = []
    if not isinstance(argv, list):
        return None, 'argv must be an array of strings'
    normalized = []
    for part in argv:
        if not isinstance(part, str):
            return None, 'argv must contain only strings'
        if '\x00' in part:
            return None, 'argv contains an invalid NUL byte'
        if part == LARK_CLI_BIN:
            return None, 'argv must not include lark-cli itself'
        if part in LARK_BLOCKED_ARGS:
            return None, '--yes is blocked; high-risk writes must surface confirmation_required to the user'
        normalized.append(part)
    if len(normalized) > 80:
        return None, 'argv is too long'
    root = normalized[0] if normalized else 'help'
    if root not in LARK_ALLOWED_ROOTS:
        allowed = ', '.join(sorted(LARK_ALLOWED_ROOTS))
        return None, f'Unsupported lark-cli command root: {root}. Allowed roots: {allowed}'
    return normalized, None

def _run_lark_cli(argv, timeout=60):
    normalized, error = _normalize_lark_argv(argv)
    if error:
        return {'success': False, 'error': error}

    result = run_command([LARK_CLI_BIN] + normalized, timeout=timeout)
    if result.get('returncode') == 10:
        try:
            envelope = json.loads(result.get('stderr') or result.get('stdout') or '{}')
            if envelope.get('error', {}).get('type') == 'confirmation_required':
                result['confirmation_required'] = True
                result['confirmation'] = envelope
        except Exception:
            result['confirmation_required'] = True
    return result

def _timeout_from_args(args):
    try:
        value = int(args.get('timeout_seconds', 60))
    except Exception:
        value = 60
    return max(1, min(value, 180))

def _safe_filename(value, fallback='slides'):
    value = (value or fallback).strip()
    safe = ''.join(c if c.isalnum() or c in ' -_' else '_' for c in value)
    safe = re.sub(r'\s+', '-', safe).strip('-_')
    return safe[:80] or fallback

def get_output_dir(*parts):
    base = os.environ.get('AI_CHAT_EXTENSION_OUTPUT_DIR', '~/ai-chat-extension/output')
    return os.path.join(os.path.expanduser(base), *parts)

# --- Command handlers ---

def handle_lark(args):
    action = args.get('action', '')

    if action == 'capabilities':
        return _lark_capabilities(args.get('domain', ''))

    if action == 'search_docs':
        query = args.get('query', '')
        jq_filter = '{ok, results: [.data.results[:5][] | {title: (.title_highlighted | gsub("<h>";"") | gsub("</h>";"")), url: .result_meta.url, type: .result_meta.doc_types, owner: .result_meta.owner_name}]}'
        cmd = [LARK_CLI_BIN, 'docs', '+search', '--query', query, '--jq', jq_filter]
        return run_command(cmd)

    elif action == 'create_doc':
        title = args.get('title', 'Untitled')
        content = args.get('content', '')
        doc_content = f'# {title}\n\n{content}' if content.strip() else f'# {title}'
        cmd = [LARK_CLI_BIN, 'docs', '+create',
               '--api-version', 'v2', '--doc-format', 'markdown',
               '--content', doc_content]
        jq_filter = '{ok, doc_url: .data.document.url, doc_id: .data.document.document_id}'
        cmd.extend(['--jq', jq_filter])
        result = run_command(cmd)
        if result['success']:
            try:
                resp = json.loads(result['stdout'])
                if resp.get('doc_url'):
                    result['doc_url'] = resp['doc_url']
                elif resp.get('doc_id'):
                    result['doc_url'] = f'https://zcnp0rxdinjy.feishu.cn/docx/{resp["doc_id"]}'
            except Exception:
                pass
        return result

    elif action == 'send_message':
        text = args.get('text', '')
        chat_id = args.get('chat_id', '')
        cmd = [LARK_CLI_BIN, 'im', '+messages-send',
               '--chat-id', chat_id, '--text', text]
        return run_command(cmd)

    elif action == 'calendar':
        sub_action = args.get('action_type', args.get('action', 'agenda'))
        if sub_action == 'agenda':
            cmd = [LARK_CLI_BIN, 'calendar', '+agenda']
            return run_command(cmd)
        elif sub_action == 'create':
            title = args.get('title', '')
            start_time = args.get('start_time', '')
            end_time = args.get('end_time', '')
            cmd = [LARK_CLI_BIN, 'calendar', '+create',
                   '--title', title]
            if start_time:
                cmd.extend(['--start-time', start_time])
            if end_time:
                cmd.extend(['--end-time', end_time])
            return run_command(cmd)
        return {'success': False, 'error': f'Unknown calendar action: {sub_action}'}

    elif action == 'create_task':
        title = args.get('title', '')
        cmd = [LARK_CLI_BIN, 'task', '+create', '--title', title]
        return run_command(cmd)

    elif action == 'search_contact':
        query = args.get('query', '')
        cmd = [LARK_CLI_BIN, 'contact', '+search-user', '--query', query]
        return run_command(cmd)

    elif action == 'fetch_doc':
        doc_url = args.get('url', args.get('doc_id', ''))
        cmd = [LARK_CLI_BIN, 'docs', '+fetch',
               '--api-version', 'v2', '--doc-format', 'markdown', '--doc', doc_url]
        return run_command(cmd)

    elif action == 'cli_help':
        argv = args.get('argv') or []
        if not argv:
            argv = ['help']
        elif '--help' not in argv and '-h' not in argv:
            argv = argv + ['--help']
        return _run_lark_cli(argv, timeout=30)

    elif action == 'schema':
        method = args.get('method', '')
        if not method or not isinstance(method, str):
            return {'success': False, 'error': 'schema method is required'}
        output_format = args.get('format', 'json')
        if output_format not in ('json', 'pretty'):
            output_format = 'json'
        return _run_lark_cli(['schema', method, '--format', output_format], timeout=30)

    elif action == 'api':
        method = str(args.get('method', '')).upper()
        path = args.get('path', '')
        if method not in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'):
            return {'success': False, 'error': 'method must be GET, POST, PUT, PATCH, or DELETE'}
        if not isinstance(path, str) or not path.startswith('/open-apis/'):
            return {'success': False, 'error': 'path must start with /open-apis/'}

        argv = ['api', method, path, '--format', 'json']
        params = _parse_json_maybe(args.get('params'))
        data = _parse_json_maybe(args.get('data'))
        if params:
            argv.extend(['--params', params])
        if data:
            argv.extend(['--data', data])
        if args.get('as') in ('user', 'bot'):
            argv.extend(['--as', args.get('as')])
        if args.get('page_all'):
            argv.append('--page-all')
        if args.get('jq'):
            argv.extend(['--jq', str(args.get('jq'))])
        if args.get('dry_run'):
            argv.append('--dry-run')
        return _run_lark_cli(argv, timeout=_timeout_from_args(args))

    elif action == 'shortcut':
        service = str(args.get('service', '')).strip()
        shortcut = str(args.get('shortcut', '')).strip()
        if service not in LARK_ALLOWED_ROOTS or service in ('api', 'schema', 'help', 'doctor'):
            return {'success': False, 'error': f'Unsupported Lark service for shortcut: {service}'}
        if not shortcut.startswith('+') or ' ' in shortcut:
            return {'success': False, 'error': 'shortcut must be a single +command token, for example +search'}
        try:
            shortcut_args = _object_from_json_maybe(args.get('args'), 'args')
            argv = [service, shortcut]
            _append_object_flags(argv, shortcut_args)
            _append_common_lark_flags(argv, args)
        except ValueError as e:
            return {'success': False, 'error': str(e)}
        return _run_lark_cli(argv, timeout=_timeout_from_args(args))

    elif action == 'api_command':
        service = str(args.get('service', '')).strip()
        resource = str(args.get('resource', '')).strip()
        method = str(args.get('method', '')).strip()
        if service not in LARK_ALLOWED_ROOTS or service in ('api', 'schema', 'help', 'doctor'):
            return {'success': False, 'error': f'Unsupported Lark service for API command: {service}'}
        if not resource or resource.startswith('-') or ' ' in resource:
            return {'success': False, 'error': 'resource must be a single lark-cli resource token'}
        if not method or method.startswith('-') or ' ' in method:
            return {'success': False, 'error': 'method must be a single lark-cli method token'}

        output_format = args.get('format') if args.get('format') in ('json', 'ndjson', 'table', 'csv', 'pretty') else 'json'
        argv = [service, resource, method, '--format', output_format]
        params = _parse_json_maybe(args.get('params'))
        data = _parse_json_maybe(args.get('data'))
        if params:
            argv.extend(['--params', params])
        if data:
            argv.extend(['--data', data])
        _append_common_lark_flags(argv, {**args, 'format': None})
        return _run_lark_cli(argv, timeout=_timeout_from_args(args))

    elif action == 'run':
        argv = args.get('argv') or []
        if args.get('dry_run') and '--dry-run' not in argv:
            argv = argv + ['--dry-run']
        return _run_lark_cli(argv, timeout=_timeout_from_args(args))

    elif action == 'update_doc':
        doc_url = args.get('url', args.get('doc_id', ''))
        markdown = args.get('content', '')
        mode = args.get('mode', 'append')
        cmd = [LARK_CLI_BIN, 'docs', '+update',
               '--api-version', 'v2', '--command', mode,
               '--doc-format', 'markdown', '--content', markdown,
               '--doc', doc_url]
        return run_command(cmd)

    return {'success': False, 'error': f'Unknown lark action: {action}'}

def handle_slides(args):
    title = args.get('title', 'Presentation')
    content = args.get('content', '')
    style = args.get('style', 'dark')

    output_dir = get_output_dir()
    os.makedirs(output_dir, exist_ok=True)

    safe_title = ''.join(c if c.isalnum() or c in ' -_' else '_' for c in title)
    output_path = os.path.join(output_dir, f'{safe_title}.html')

    styles = {
        'dark': {'bg': '#1e1e2e', 'text': '#cdd6f4', 'accent': '#89b4fa', 'heading': '#b4befe'},
        'light': {'bg': '#eff1f5', 'text': '#4c4f69', 'accent': '#1e66f5', 'heading': '#1e66f5'},
        'terminal': {'bg': '#0d1117', 'text': '#39d353', 'accent': '#58a6ff', 'heading': '#79c0ff'},
        'neon': {'bg': '#0a0a0a', 'text': '#e0e0e0', 'accent': '#ff00ff', 'heading': '#00ffff'},
    }
    s = styles.get(style, styles['dark'])

    sections = []
    for part in content.split('\n---\n'):
        if part.strip():
            sections.append(part.strip())
    if not sections:
        sections = [content]

    slides_html = ''
    for i, section in enumerate(sections):
        lines = section.strip().split('\n')
        heading = lines[0].replace('#', '').strip() if lines else f'Slide {i+1}'
        body = '\n'.join(lines[1:]) if len(lines) > 1 else ''
        body = body.replace('\n', '<br>')

        slides_html += f'''
        <div class="slide" id="slide-{i}">
            <h2>{heading}</h2>
            <div class="slide-body">{body}</div>
        </div>'''

    html = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>{title}</title>
<style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ background: {s['bg']}; color: {s['text']}; font-family: system-ui, sans-serif; overflow: hidden; }}
.slide {{ height: 100vh; display: flex; flex-direction: column; justify-content: center; padding: 8vh 10vw; scroll-snap-align: start; }}
h2 {{ color: {s['heading']}; font-size: 2.5em; margin-bottom: 1em; }}
.slide-body {{ font-size: 1.3em; line-height: 1.8; }}
.slide-container {{ height: 100vh; overflow-y: auto; scroll-snap-type: y mandatory; }}
.nav {{ position: fixed; bottom: 20px; right: 20px; display: flex; gap: 8px; }}
.nav button {{ background: {s['accent']}30; border: 1px solid {s['accent']}50; color: {s['accent']}; padding: 8px 16px; border-radius: 6px; cursor: pointer; }}
</style>
</head>
<body>
<div class="slide-container">{slides_html}
</div>
<div class="nav">
<button onclick="prev()">&#9664; Prev</button>
<button onclick="next()">Next &#9654;</button>
</div>
<script>
let current = 0;
const slides = document.querySelectorAll('.slide');
function showSlide(n) {{
    current = Math.max(0, Math.min(n, slides.length - 1));
    slides[current].scrollIntoView({{ behavior: 'smooth' }});
}}
function prev() {{ showSlide(current - 1); }}
function next() {{ showSlide(current + 1); }}
document.addEventListener('keydown', e => {{
    if (e.key === 'ArrowRight' || e.key === ' ') next();
    if (e.key === 'ArrowLeft') prev();
}});
</script>
</body>
</html>'''

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(html)

    return {
        'success': True,
        'path': output_path,
        'url': f'file://{output_path}',
    }

def _extract_doc_title(markdown, fallback):
    for line in markdown.splitlines():
        stripped = line.strip()
        if stripped.startswith('#'):
            return stripped.lstrip('#').strip() or fallback
    return fallback

def _build_frontend_slides_prompt(title, source_path, output_path, style, slide_count):
    style_text = style or '自动选择一个与内容气质匹配、非模板化的 distinctive style'
    count_text = str(slide_count or '10-14')
    return f'''/frontend-slides

请把飞书文档转换成一份精美、可演示的 HTML presentation。

输入文档：
{source_path}

输出文件：
{output_path}

要求：
- 标题：{title}
- 页数：约 {count_text} 页，内容多时请拆页，不要拥挤
- 风格：{style_text}
- 使用 frontend-slides skill 的规则生成单文件 HTML
- 每一页都必须 100vh/100dvh 内完整显示，不能滚动
- 使用独特字体、强视觉层次、CSS 动效和精心排版，避免普通模板感
- 不要向用户提问，直接根据文档内容做合理设计决策
- 保留文档中的核心观点、结构、数据和行动项
- 生成完成后只简要说明输出路径
'''

def handle_frontend_slides(args):
    doc_url = args.get('url', '')
    if not doc_url:
        return {'success': False, 'error': 'url is required'}

    mode = args.get('mode', 'prepare')
    if mode not in ('prepare', 'generate'):
        mode = 'prepare'

    fetch_result = handle_lark({'action': 'fetch_doc', 'url': doc_url})
    if not fetch_result.get('success'):
        return {
            'success': False,
            'error': 'Failed to fetch Lark doc',
            'fetch_result': fetch_result,
        }

    markdown = fetch_result.get('stdout', '').strip()
    if not markdown:
        return {'success': False, 'error': 'Fetched Lark doc is empty', 'fetch_result': fetch_result}

    title = args.get('title') or _extract_doc_title(markdown, 'lark-doc-slides')
    slug = _safe_filename(title, 'lark-doc-slides')
    base_dir = get_output_dir('frontend-slides', f'{slug}-{int(time.time())}')
    os.makedirs(base_dir, exist_ok=True)

    source_path = os.path.join(base_dir, 'source.md')
    prompt_path = os.path.join(base_dir, 'frontend-slides-prompt.md')
    output_path = os.path.join(base_dir, 'slides.html')

    with open(source_path, 'w', encoding='utf-8') as f:
        f.write(markdown)

    prompt = _build_frontend_slides_prompt(
        title=title,
        source_path=source_path,
        output_path=output_path,
        style=args.get('style', ''),
        slide_count=args.get('slide_count'),
    )
    with open(prompt_path, 'w', encoding='utf-8') as f:
        f.write(prompt)

    result = {
        'success': True,
        'mode': mode,
        'title': title,
        'work_dir': base_dir,
        'source_path': source_path,
        'prompt_path': prompt_path,
        'output_path': output_path,
        'message': 'Frontend-slides work package prepared',
    }

    if mode == 'generate':
        claude = run_command([
            'claude',
            '--print',
            '--add-dir', base_dir,
            '--permission-mode', 'acceptEdits',
            '--max-budget-usd', '3',
            prompt,
        ], timeout=600)
        result['generation'] = claude
        result['success'] = bool(claude.get('success') and os.path.exists(output_path))
        if result['success']:
            result['url'] = f'file://{output_path}'
            result['message'] = 'Frontend-slides presentation generated'
        else:
            result['message'] = 'Prepared work package, but automatic generation did not produce slides.html'

    return result

def handle_open(args):
    path = args.get('path', '')
    if not path:
        return {'success': False, 'error': 'No path provided'}
    return run_command(['open', path])

# --- Realtime WebSocket proxy ---

async def _ws_to_stdout(ws, mic_muted):
    """Forward WebSocket events to extension via stdout.
    Auto-mute mic during AI playback to prevent echo feedback."""
    unmute_task = [None]  # Track pending unmute timer

    try:
        async for raw in ws:
            event = json.loads(raw)
            event_type = event.get('type', '')

            # Skip heartbeats — they're keep-alive, not data
            if event_type == 'heartbeat':
                continue

            # Mute mic when AI is speaking to prevent echo
            if event_type == 'response.audio.delta':
                mic_muted[0] = True
                # Cancel any pending unmute from a previous response
                if unmute_task[0] and not unmute_task[0].done():
                    unmute_task[0].cancel()
                    unmute_task[0] = None
            elif event_type == 'response.done':
                # Cancel any existing unmute timer first
                if unmute_task[0] and not unmute_task[0].done():
                    unmute_task[0].cancel()
                # Delay unmute to let speaker audio physically finish
                async def _delayed_unmute():
                    await asyncio.sleep(4.0)
                    try:
                        await ws.send(json.dumps({'type': 'input_audio_buffer.clear'}))
                    except Exception:
                        pass
                    mic_muted[0] = False
                unmute_task[0] = asyncio.create_task(_delayed_unmute())

            # Debug: log key server events to understand response.create behavior
            if event_type in ('response.created', 'response.done', 'error'):
                detail = json.dumps(event, ensure_ascii=False)[:300]
                send_message({'type': 'realtime_event', 'event': {
                    'type': 'mic_debug', 'msg': f'ws: {event_type} {detail}'}})

            send_message({'type': 'realtime_event', 'event': event})
    except websockets.exceptions.ConnectionClosedOK:
        send_message({'type': 'realtime_disconnected'})
    except websockets.exceptions.ConnectionClosed as e:
        send_message({'type': 'realtime_disconnected', 'code': e.code, 'reason': e.reason or ''})
    except Exception as e:
        send_message({'type': 'realtime_error', 'error': str(e)})

async def _stdin_to_ws(ws, loop, mic_start):
    """Read from stdin (blocking executor) and forward to WebSocket."""
    while True:
        msg = await loop.run_in_executor(None, read_message)
        if msg is None:
            break
        msg_type = msg.get('type')
        if msg_type == 'start_mic':
            mic_start.set()
            continue
        if msg_type == 'realtime_disconnect':
            break
        await ws.send(json.dumps(msg))

async def _mic_to_ws(ws, loop, mic_start, mic_muted):
    """Capture mic audio and send to WebSocket with client-side VAD.
    Skips sending when mic_muted[0] is True (AI is speaking).
    After unmute, has a cooldown period to prevent echo feedback.
    Client-side silence detection triggers response.create."""
    import numpy as np

    send_message({'type': 'realtime_event', 'event': {
        'type': 'mic_debug', 'msg': 'waiting for start_mic signal'}})

    await mic_start.wait()

    send_message({'type': 'realtime_event', 'event': {
        'type': 'mic_debug', 'msg': 'start_mic received, clearing buffer'}})

    try:
        await ws.send(json.dumps({'type': 'input_audio_buffer.clear'}))
    except Exception:
        pass

    try:
        stream = sd.RawInputStream(
            samplerate=24000,
            channels=1,
            dtype='int16',
            blocksize=2400,  # 100ms at 24kHz
        )
        stream.start()
    except Exception as e:
        send_message({'type': 'realtime_error', 'error': f'Mic start failed: {e}'})
        return

    # Warm up: discard 40 frames (4 seconds) to ensure greeting echo is gone
    for i in range(40):
        await loop.run_in_executor(None, stream.read, 2400)

    try:
        await ws.send(json.dumps({'type': 'input_audio_buffer.clear'}))
    except Exception:
        pass

    send_message({'type': 'realtime_event', 'event': {
        'type': 'mic_debug', 'msg': 'warmup done, client-side VAD active'}})

    # Client-side VAD parameters
    SPEECH_THRESHOLD = 2500.0  # Above echo/noise (~1000-2200), below speech (~3000+)
    SPEECH_MIN_FRAMES = 3     # 300ms to confirm speech start
    SILENCE_MIN_FRAMES = 15   # 1.5s to confirm speech end

    speech_state = 'idle'
    speech_frames = 0
    silence_frames = 0
    frames_sent = 0
    frames_muted = 0
    was_muted = False
    cooldown_remaining = 0
    COOLDOWN_FRAMES = 30  # 3 seconds at 100ms/frame

    try:
        while True:
            pcm_bytes, overflowed = await loop.run_in_executor(
                None, stream.read, 2400
            )

            if mic_muted[0]:
                was_muted = True
                frames_muted += 1
                if speech_state != 'idle':
                    speech_state = 'idle'
                    speech_frames = 0
                    silence_frames = 0
                continue

            # Detect unmute transition -> start cooldown
            if was_muted:
                was_muted = False
                cooldown_remaining = COOLDOWN_FRAMES
                frames_muted = 0
                send_message({'type': 'realtime_event', 'event': {
                    'type': 'mic_debug', 'msg': f'unmuted, {COOLDOWN_FRAMES}-frame cooldown'}})

            # During cooldown: don't send audio or run VAD
            if cooldown_remaining > 0:
                cooldown_remaining -= 1
                if cooldown_remaining == 0:
                    try:
                        await ws.send(json.dumps({'type': 'input_audio_buffer.clear'}))
                    except Exception:
                        pass
                    send_message({'type': 'realtime_event', 'event': {
                        'type': 'mic_debug', 'msg': 'cooldown done, buffer cleared'}})
                continue

            # Send audio to server
            audio_b64 = base64.b64encode(pcm_bytes).decode()
            await ws.send(json.dumps({
                'type': 'input_audio_buffer.append',
                'audio': audio_b64,
            }))
            frames_sent += 1

            # Client-side VAD
            samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32)
            rms = np.sqrt(np.mean(samples ** 2))

            if speech_state == 'idle':
                if rms > SPEECH_THRESHOLD:
                    speech_frames += 1
                    if speech_frames >= SPEECH_MIN_FRAMES:
                        speech_state = 'speaking'
                        silence_frames = 0
                        send_message({'type': 'realtime_event', 'event': {
                            'type': 'input_audio_buffer.speech_started'}})
                        send_message({'type': 'realtime_event', 'event': {
                            'type': 'mic_debug', 'msg': f'speech started rms={rms:.0f}'}})
                else:
                    speech_frames = 0

            elif speech_state == 'speaking':
                if rms < SPEECH_THRESHOLD:
                    silence_frames += 1
                    if silence_frames >= SILENCE_MIN_FRAMES:
                        speech_state = 'idle'
                        speech_frames = 0
                        silence_frames = 0
                        try:
                            await ws.send(json.dumps({'type': 'response.create'}))
                            send_message({'type': 'realtime_event', 'event': {
                                'type': 'mic_debug', 'msg': 'response.create sent'}})
                        except Exception as e:
                            send_message({'type': 'realtime_event', 'event': {
                                'type': 'mic_debug', 'msg': f'response.create error: {e}'}})
                        send_message({'type': 'realtime_event', 'event': {
                            'type': 'input_audio_buffer.speech_stopped'}})
                        send_message({'type': 'realtime_event', 'event': {
                            'type': 'mic_debug', 'msg': 'speech ended, response requested'}})
                else:
                    silence_frames = 0

            # Log every 30 frames
            if frames_sent % 30 == 1:
                send_message({'type': 'realtime_event', 'event': {
                    'type': 'mic_debug', 'msg': f'frame #{frames_sent} rms={rms:.0f} state={speech_state}'}})
    except asyncio.CancelledError:
        pass
    finally:
        stream.stop()
        stream.close()

async def _realtime_proxy(api_key):
    """Connect to GLM-Realtime WebSocket and bidirectionally forward messages."""
    url = 'wss://open.bigmodel.cn/api/paas/v4/realtime?model=glm-realtime'

    # Generate JWT token from API key
    try:
        token = generate_jwt(api_key)
    except Exception as e:
        send_message({'type': 'realtime_error', 'error': f'JWT generation failed: {e}'})
        return

    headers = [('Authorization', f'Bearer {token}')]

    try:
        async with websockets.connect(url, additional_headers=headers, proxy=None) as ws:
            send_message({'type': 'realtime_connected'})

            loop = asyncio.get_event_loop()
            mic_start = asyncio.Event()
            mic_muted = [False]  # Mutable list for shared mute flag

            ws_task = asyncio.create_task(_ws_to_stdout(ws, mic_muted))
            stdin_task = asyncio.create_task(_stdin_to_ws(ws, loop, mic_start))
            mic_task = asyncio.create_task(_mic_to_ws(ws, loop, mic_start, mic_muted))

            done, pending = await asyncio.wait(
                [ws_task, stdin_task, mic_task],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
    except Exception as e:
        send_message({'type': 'realtime_error', 'error': str(e)})

def handle_realtime(msg):
    if websockets is None:
        send_message({'type': 'realtime_error', 'error': 'websockets library not installed. Run: pip3 install websockets'})
        return
    if sd is None:
        send_message({'type': 'realtime_error', 'error': 'sounddevice library not installed. Run: /opt/homebrew/bin/pip3 install sounddevice'})
        return
    api_key = msg.get('api_key', '')
    if not api_key:
        send_message({'type': 'realtime_error', 'error': 'No API key provided'})
        return
    try:
        asyncio.run(_realtime_proxy(api_key))
    except Exception as e:
        try:
            send_message({'type': 'realtime_error', 'error': str(e)})
        except:
            pass

# --- Main loop ---

def main():
    while True:
        try:
            msg = read_message()
        except Exception:
            break
        if msg is None:
            break

        command = msg.get('command', '')
        args = msg.get('args', {})

        if command == 'lark':
            send_message(handle_lark(args))
        elif command == 'slides':
            send_message(handle_slides(args))
        elif command == 'frontend_slides':
            send_message(handle_frontend_slides(args))
        elif command == 'open':
            send_message(handle_open(args))
        elif command == 'ping':
            send_message({'success': True, 'message': 'pong'})
        elif command == 'realtime':
            handle_realtime(msg)
            break  # realtime proxy runs until disconnected, then exit
        else:
            send_message({'success': False, 'error': f'Unknown command: {command}'})

if __name__ == '__main__':
    main()
