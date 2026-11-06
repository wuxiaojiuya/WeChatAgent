"""Prepare verified reference stems once for analysis and subsequent singing."""
import argparse
import importlib.util
import json
import subprocess
from pathlib import Path


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name+'.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input', required=True, type=Path)
    p.add_argument('--output', required=True, type=Path)
    p.add_argument('--seconds', required=True, type=float)
    p.add_argument('--start', default=0., type=float)
    p.add_argument('--soulx-runtime', type=Path)
    args = p.parse_args()
    if not 0 < args.seconds <= 30: p.error('Reference must be at most 30 seconds')
    if not 0 <= args.start <= 14400: p.error('Invalid reference start')
    import soundfile as sf
    cover, performance = load('music-cover'), load('music-performance')
    out = args.output.resolve(); out.mkdir(parents=True, exist_ok=True)
    if any((out/name).exists() for name in ['source-clip.wav', 'reference.json']):
        raise ValueError('Reference already prepared')
    clip = out/'source-clip.wav'
    cover.run([cover.FFMPEG, '-hide_banner', '-loglevel', 'error', '-nostdin', '-ss', args.start, '-i', args.input.resolve(strict=True),
               '-t', args.seconds, '-ac', 2, '-ar', 44100, '-c:a', 'pcm_f32le', clip])
    if abs(sf.info(clip).duration-args.seconds) > .05: raise ValueError('Reference duration mismatch')
    separation = cover.separate(clip, out, True)
    vocal, rate = sf.read(out/'original-vocals.wav', always_2d=True)
    accompaniment, _ = sf.read(out/'accompaniment.wav', always_2d=True)
    analysis = performance.analyze_stems(vocal, accompaniment, rate)
    if not analysis['phrases']: raise ValueError('No vocal phrases available for performance planning')
    record = {'schema': 'singing-reference-v1', 'seconds': args.seconds, 'separation': separation,
              'source_sha256': cover.sha(args.input), 'analysis': analysis,
              'files': {name: cover.sha(out/name) for name in ['source-clip.wav', 'original-vocals.wav', 'accompaniment.wav']}}
    if args.soulx_runtime:
        runtime = args.soulx_runtime.resolve(strict=True)
        subprocess.run([str(runtime/'venv/Scripts/python.exe'), str(Path(__file__).with_name('music-soulx-worker.py')),
                        '--runtime', str(runtime), '--input', str(out/'original-vocals.wav'), '--output', str(out/'soulx'),
                        '--seconds', str(args.seconds), '--phase', 'prepare'], check=True)
        metadata_file = out/'soulx/preprocess/metadata.json'
        metadata = json.loads(metadata_file.read_text('utf-8'))
        analysis['lyrics'] = score_lyrics(metadata, args.seconds)
        record['score'] = {'metadata_sha256': cover.sha(metadata_file), 'vocal_sha256': cover.sha(out/'original-vocals.wav')}
    (out/'reference.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'stage': 'reference_ready', 'seconds': args.seconds}), flush=True)


def score_lyrics(metadata, seconds):
    """Keep recognized lyric phrases, not source F0, in the model planning evidence."""
    rows = []
    for item in metadata:
        start, end = [float(t)/1000 for t in item['time']]
        text = str(item['text']).replace('<SP>', '').replace('<AP>', '').strip()
        if not 0 <= start < end <= seconds+.1 or len(text) > 1000:
            raise ValueError('Invalid recognized lyric phrase')
        if text: rows.append({'start': round(start, 3), 'end': round(min(end, seconds), 3), 'text': text})
    if not rows or len(rows) > 32: raise ValueError('No usable recognized lyrics for planning')
    return rows


if __name__ == '__main__': main()
