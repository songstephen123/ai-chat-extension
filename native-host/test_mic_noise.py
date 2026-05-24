#!/opt/homebrew/bin/python3
"""Quick mic noise level test — shows RMS of 3 seconds of audio."""
import numpy as np
import sounddevice as sd

print("Recording 3 seconds of ambient noise at 24kHz 16bit mono...")
stream = sd.RawInputStream(samplerate=24000, channels=1, dtype='int16', blocksize=2400)
stream.start()

rms_values = []
for i in range(30):  # 30 x 100ms = 3 seconds
    pcm_bytes, _ = stream.read(2400)
    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32)
    rms = np.sqrt(np.mean(samples ** 2))
    rms_values.append(rms)
    bar = '█' * int(rms / 50)
    print(f"  {i*100:4d}ms  RMS={rms:7.1f}  {bar}")

stream.stop()
stream.close()

avg = sum(rms_values) / len(rms_values)
mx = max(rms_values)
print(f"\nAverage RMS: {avg:.1f}")
print(f"Max RMS: {mx:.1f}")
print(f"Current threshold (3.5x): {max(avg * 3.5, 500.0):.1f}")
print(f"Recommended threshold (5x): {max(avg * 5.0, 800.0):.1f}")
