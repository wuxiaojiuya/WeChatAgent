"""Normalize a bounded reference recording for direct CosyVoice synthesis."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import numpy as np
import soundfile as sf


def prepare(source, output, ffmpeg):
    with tempfile.TemporaryDirectory() as temp:
        decoded = Path(temp)/'reference.wav'
        subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin',
                        '-protocol_whitelist', 'file,pipe', '-i', str(source), '-t', '31', '-vn', '-ac', '1',
                        '-ar', '24000', str(decoded)], check=True, timeout=20, capture_output=True)
        audio, rate = sf.read(decoded, dtype='float32')
        seconds = len(audio)/rate
        if not 3 <= seconds <= 30 or not np.isfinite(audio).all() or np.sqrt(np.mean(audio**2)) < 0.001:
            raise ValueError('Reference must contain 3 to 30 seconds of audible speech')
        sf.write(output, audio*min(1., .98/max(float(abs(audio).max()), .001)), rate, subtype='PCM_16')
    return dict(seconds=seconds, sha256=hashlib.sha256(Path(output).read_bytes()).hexdigest())


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--ffmpeg', required=True)
    args=parser.parse_args()
    print(json.dumps(prepare(args.input, args.output, args.ffmpeg)))
