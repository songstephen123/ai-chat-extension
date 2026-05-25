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
    id_part, secret = api_key.split('.')
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

# --- Command handlers ---

def handle_lark(args):
    action = args.get('action', '')

    if action == 'search_docs':
        query = args.get('query', '')
        jq_filter = '{ok, results: [.data.results[:5][] | {title: (.title_highlighted | gsub("<h>";"") | gsub("</h>";"")), url: .result_meta.url, type: .result_meta.doc_types, owner: .result_meta.owner_name}]}'
        cmd = ['npx', '@larksuite/cli', 'docs', '+search', '--query', query, '--jq', jq_filter]
        return run_command(cmd)

    elif action == 'create_doc':
        title = args.get('title', 'Untitled')
        content = args.get('content', '')
        doc_content = f'# {title}\n\n{content}' if content.strip() else f'# {title}'
        cmd = ['npx', '@larksuite/cli', 'docs', '+create',
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
        cmd = ['npx', '@larksuite/cli', 'im', '+messages-send',
               '--chat-id', chat_id, '--text', text]
        return run_command(cmd)

    elif action == 'calendar':
        sub_action = args.get('action_type', args.get('action', 'agenda'))
        if sub_action == 'agenda':
            cmd = ['npx', '@larksuite/cli', 'calendar', '+agenda']
            return run_command(cmd)
        elif sub_action == 'create':
            title = args.get('title', '')
            start_time = args.get('start_time', '')
            end_time = args.get('end_time', '')
            cmd = ['npx', '@larksuite/cli', 'calendar', '+create',
                   '--title', title]
            if start_time:
                cmd.extend(['--start-time', start_time])
            if end_time:
                cmd.extend(['--end-time', end_time])
            return run_command(cmd)
        return {'success': False, 'error': f'Unknown calendar action: {sub_action}'}

    elif action == 'create_task':
        title = args.get('title', '')
        cmd = ['npx', '@larksuite/cli', 'task', '+create', '--title', title]
        return run_command(cmd)

    elif action == 'search_contact':
        query = args.get('query', '')
        cmd = ['npx', '@larksuite/cli', 'contact', '+search-user', '--query', query]
        return run_command(cmd)

    elif action == 'fetch_doc':
        doc_url = args.get('url', args.get('doc_id', ''))
        cmd = ['npx', '@larksuite/cli', 'docs', '+fetch',
               '--api-version', 'v2', '--doc-format', 'markdown', '--doc', doc_url]
        return run_command(cmd)

    elif action == 'update_doc':
        doc_url = args.get('url', args.get('doc_id', ''))
        markdown = args.get('content', '')
        mode = args.get('mode', 'append')
        cmd = ['npx', '@larksuite/cli', 'docs', '+update',
               '--api-version', 'v2', '--command', mode,
               '--doc-format', 'markdown', '--content', markdown,
               '--doc', doc_url]
        return run_command(cmd)

    return {'success': False, 'error': f'Unknown lark action: {action}'}

def handle_slides(args):
    title = args.get('title', 'Presentation')
    content = args.get('content', '')
    style = args.get('style', 'dark')

    output_dir = os.path.expanduser('~/ai-chat-extension/output')
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
