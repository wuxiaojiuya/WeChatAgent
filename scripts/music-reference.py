"""Prepare verified reference stems once for analysis and subsequent singing."""
import argparse
import importlib.util
import json
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
    (out/'reference.json').write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'stage': 'reference_ready', 'seconds': args.seconds}), flush=True)


if __name__ == '__main__': main()
