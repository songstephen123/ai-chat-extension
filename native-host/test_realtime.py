#!/opt/homebrew/bin/python3
"""Test GLM-Realtime API connection — verifies JWT, WebSocket, session, and greeting."""

import sys
import json
import asyncio
import hmac
import hashlib
import base64
import time

try:
    import websockets
except ImportError:
    print("ERROR: pip3 install websockets")
    sys.exit(1)

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

async def test(api_key):
    url = 'wss://open.bigmodel.cn/api/paas/v4/realtime?model=glm-realtime'
    token = generate_jwt(api_key)
    print(f"[1] JWT generated ({len(token)} chars)")

    try:
        async with websockets.connect(url, additional_headers=[('Authorization', f'Bearer {token}')], proxy=None) as ws:
            print("[2] WebSocket connected")

            # Wait for session.created (skip heartbeats)
            event = None
            for attempt in range(20):
                raw = await asyncio.wait_for(ws.recv(), timeout=10)
                event = json.loads(raw)
                etype = event.get('type')
                print(f"[3.{attempt+1}] Received: {etype}")
                if etype == 'session.created':
                    break
                elif etype == 'heartbeat':
                    continue
                else:
                    print(f"    Unexpected: {json.dumps(event, indent=2)[:200]}")
                    continue
            else:
                print("    ERROR: never received session.created")
                return

            # Send session.update with threshold
            session_update = {
                "type": "session.update",
                "session": {
                    "model": "glm-realtime",
                    "voice": "tongtong",
                    "input_audio_format": "pcm24",
                    "output_audio_format": "pcm",
                    "input_audio_noise_reduction": {"type": "far_field"},
                    "turn_detection": {
                        "type": "server_vad",
                        "create_response": True,
                        "interrupt_response": True,
                        "threshold": 0.7,
                        "silence_duration_ms": 600,
                    },
                    "beta_fields": {
                        "chat_mode": "audio",
                        "tts_source": "e2e",
                        "greeting_config": {
                            "enable": True,
                            "content": "你好，测试成功。",
                        },
                    },
                },
            }
            await ws.send(json.dumps(session_update))
            print("[4] Sent session.update (with threshold: 0.7)")

            # Wait for session.updated
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            event = json.loads(raw)
            print(f"[5] Received: {event.get('type')}")
            if event.get('error'):
                print(f"    ERROR: {json.dumps(event, indent=2)}")
                return

            # Wait for greeting events (response.created, audio deltas, etc.)
            print("[6] Waiting for greeting audio...")
            audio_chunks = 0
            text_parts = []
            timeout_count = 0

            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=15)
                except asyncio.TimeoutError:
                    print("    (15s timeout, no more events)")
                    break

                event = json.loads(raw)
                etype = event.get('type', '')

                if etype == 'response.created':
                    print(f"    {etype}")
                elif etype == 'response.audio.delta':
                    audio_chunks += 1
                elif etype in ('response.text.delta', 'response.audio_transcript.delta'):
                    delta = event.get('delta', '')
                    if delta:
                        text_parts.append(delta)
                elif etype == 'response.done':
                    print(f"    {etype}")
                    break
                elif etype in ('rate_limits.updated', 'heartbeat'):
                    pass  # skip
                elif etype == 'error':
                    print(f"    ERROR: {json.dumps(event, indent=2)}")
                    break
                else:
                    print(f"    {etype}")

            text = ''.join(text_parts)
            print(f"\n=== RESULT ===")
            print(f"Audio chunks: {audio_chunks}")
            print(f"Text: {text or '(none)'}")
            if audio_chunks > 0:
                print("STATUS: Realtime API working correctly!")
            else:
                print("STATUS: Connected but no audio received")

    except Exception as e:
        print(f"ERROR: {e}")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 test_realtime.py <API_KEY>")
        sys.exit(1)
    asyncio.run(test(sys.argv[1]))
