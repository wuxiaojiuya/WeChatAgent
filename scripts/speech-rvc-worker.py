"""Convert synthesized speech using the selected, verified RVC model."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def sha(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True, type=Path)
    parser.add_argument('--profile', required=True, type=Path)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    args = parser.parse_args()
    source = args.input.resolve(strict=True)
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    subprocess.run([sys.executable, str(Path(__file__).with_name('music-rvc-worker.py')),
                    '--model', str(args.model.resolve(strict=True)), '--profile', str(args.profile),
                    '--input', str(source), '--output-dir', str(output/'rvc'),
                    '--pitch', '0', '--quality', 'enhanced',
                    '--runtime-root', str(args.profile.resolve(strict=True).parent)], check=True)
    import numpy as np
    import soundfile as sf
    wave, rate = sf.read(output/'rvc/rvc_native.wav', dtype='float32')
    original = sf.info(source)
    seconds = len(wave)/rate
    if (wave.ndim != 1 or not 0 < seconds <= 60 or abs(seconds-original.duration) > 0.5
            or not np.isfinite(wave).all() or np.sqrt(np.mean(wave.astype('float64')**2)) < 1e-7):
        raise ValueError('Invalid converted speech audio')
    peak = float(np.max(np.abs(wave)))
    if peak > 0.92:
        wave *= 0.92/peak
    result = output/'speech.wav'
    sf.write(result, wave, rate, subtype='PCM_16')
    conversion = json.loads((output/'rvc/cover_result.json').read_text(encoding='utf-8'))
    if conversion.get('status') != 'success' or not conversion.get('actual_synth_calls'):
        raise ValueError('Missing RVC inference receipt')
    receipt = dict(status='success', route='TTS -> selected RVC', runtime_rvc=True,
                   source_sha256=sha(source), model_sha256=conversion['model_sha256'],
                   output_sha256=sha(result), seconds=seconds, sample_rate=rate)
    (output/'result.json').write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    print(json.dumps(receipt), flush=True)


if __name__ == '__main__':
    main()
