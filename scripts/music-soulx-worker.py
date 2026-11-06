"""Official SoulX score performance synthesis (melody mode retained for runtime checks). Preprocessing and singing use separate processes.

The source vocal supplies lyrics/timing/melody only; it is never mixed into output.
The official temporary singer is subsequently replaced by the selected RVC model.
"""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('soulx_runtime', Path(__file__).with_name('soulx-runtime.py'))
runtime_tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime_tools)
performance_spec = importlib.util.spec_from_file_location('music_performance', Path(__file__).with_name('music-performance.py'))
performance_tools = importlib.util.module_from_spec(performance_spec)
performance_spec.loader.exec_module(performance_tools)


def emit(stage, **values):
    print(json.dumps({'stage': stage, **values}, ensure_ascii=False), flush=True)


def render_segments(metadata, infer, seconds, np):
    """Place synthesized phrases at source times, retaining leading/trailing silence."""
    merged = np.zeros(round(seconds*24000), dtype=np.float32)
    for index, meta in enumerate(metadata):
        start, end = [round(float(t)*24) for t in meta['time']]
        if not 0 <= start < end <= len(merged)+2400:
            raise ValueError('SoulX phrase timing is invalid')
        generated = np.asarray(infer(index, meta), dtype=np.float32).reshape(-1)
        expected = end-start
        if not np.isfinite(generated).all() or len(generated) < expected-2400 or np.max(np.abs(generated), initial=0) < 1e-5:
            raise ValueError('SoulX phrase synthesis is invalid')
        length = min(len(generated), expected, len(merged)-start)
        if length <= 0:
            raise ValueError('SoulX phrase is outside the clip')
        clip = generated[:length].copy()
        fade = min(240, length//4)
        if fade:
            clip[:fade] *= np.linspace(0, 1, fade)
            clip[-fade:] *= np.linspace(1, 0, fade)
        merged[start:start+length] += clip
    if not metadata or np.sqrt(np.mean(merged**2)) < 1e-7:
        raise ValueError('No singing phrases were synthesized')
    return merged


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime', required=True, type=Path)
    parser.add_argument('--input', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--seconds', type=float, default=30)
    parser.add_argument('--phase', choices=['all', 'prepare', 'sing', 'check'], default='all')
    parser.add_argument('--performance', type=Path)
    args = parser.parse_args()
    runtime = args.runtime.resolve(strict=True)
    if args.performance: args.performance = args.performance.resolve(strict=True)
    runtime_tools.verify_runtime(runtime)
    source = runtime/'source'
    os.chdir(source)
    sys.path.insert(0, str(source))
    os.environ.update(OMP_NUM_THREADS='6', NLTK_DATA=str(runtime/'nltk_data'),
                      HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', PYTHONUTF8='1')
    if args.phase == 'all':
        for phase in ['prepare', 'sing']:
            subprocess.run([sys.executable, __file__, '--runtime', str(runtime), '--input', str(args.input),
                            '--output', str(args.output), '--seconds', str(args.seconds), '--phase', phase,
                            *(['--performance', str(args.performance)] if args.performance else [])], check=True)
        return
    import torch
    import numpy as np
    import soundfile as sf
    import librosa
    torch.set_num_threads(6)
    torch.set_num_interop_threads(2)
    torch.manual_seed(20261106)
    # Import every required entry before claiming the environment is usable.
    from preprocess.pipeline import PreprocessPipeline
    from preprocess.tools.vocal_detection import VocalDetector, VocalDetectionConfig
    from cli.inference import build_model
    from soulxsinger.utils.file_utils import load_config
    from soulxsinger.utils.data_processor import DataProcessor
    if args.phase == 'check':
        import nltk
        for resource in ['corpora/cmudict', 'taggers/averaged_perceptron_tagger_eng']:
            nltk.data.find(resource)
        emit('checked', engine='SoulX-Singer', device='cpu')
        return
    if not args.input or not args.output or not 0 < args.seconds <= 30:
        parser.error('Provide input/output and 0 < seconds <= 30')
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    if args.phase == 'prepare':
        emit('soulx_preprocess')
        song, _ = librosa.load(args.input.resolve(strict=True), sr=24000, mono=True, duration=args.seconds)
        if abs(len(song)/24000-args.seconds) > .05:
            raise ValueError('Source vocal duration mismatch')
        vocal = out/'target.wav'
        sf.write(vocal, song, 24000, subtype='FLOAT')
        pipeline = PreprocessPipeline(device='cpu', language='Mandarin', save_dir=str(out/'preprocess'),
                                      vocal_sep=False, max_merge_duration=10000, midi_transcribe=True)
        pipeline.vocal_detector = VocalDetector(cut_wavs_output_dir=str(out/'preprocess/cut_wavs'),
                                                config=VocalDetectionConfig(max_len_ms=10000))
        pipeline.run(str(vocal))
        metadata = json.loads((out/'preprocess/metadata.json').read_text('utf-8'))
        if not metadata:
            raise ValueError('No lyrics or melody found; choose a clip containing Mandarin singing')
        emit('soulx_metadata_ready', segments=len(metadata), elapsed=round(time.monotonic()-started, 1))
        return
    metadata = json.loads((out/'preprocess/metadata.json').read_text('utf-8'))
    performance_report = None
    if args.performance:
        plan = json.loads(args.performance.read_text('utf-8'))
        metadata, performance_report = performance_tools.arrange_score(metadata, plan, args.seconds)
        (out/'arranged-metadata.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding='utf-8')
        emit('performance_arranged', edited_notes=performance_report['edited_note_durations'])
    prompt_path = source/'example/audio/zh_prompt.mp3'
    prompt_meta = json.loads((source/'example/audio/zh_prompt.json').read_text('utf-8'))[0]
    prompt, _ = librosa.load(prompt_path, sr=24000, mono=True)
    sf.write(out/'reference.wav', prompt, 24000, subtype='FLOAT')
    config = load_config(str(source/'soulxsinger/config/soulxsinger.yaml'))
    processor = DataProcessor(hop_size=config.audio.hop_size, sample_rate=config.audio.sample_rate, device='cpu')
    prompt_data = processor.process(copy.deepcopy(prompt_meta), str(out/'reference.wav'))
    original_metadata = json.loads((out/'preprocess/metadata.json').read_text('utf-8'))
    target_f0 = np.concatenate([np.fromstring(meta['f0'], sep=' ') for meta in original_metadata])
    prompt_f0 = np.fromstring(prompt_meta['f0'], sep=' ')
    if not np.any(target_f0 > 0) or not np.any(prompt_f0 > 0):
        raise ValueError('No usable vocal melody found')
    # A whole octave preserves the key of the original accompaniment.
    shift = int(np.clip(round(np.log2(np.median(prompt_f0[prompt_f0 > 0])/np.median(target_f0[target_f0 > 0]))), -1, 1)*12)
    emit('soulx_loading')
    model = build_model(str(source/'pretrained_models/SoulX-Singer/model.pt'), config, device='cpu', use_fp16=False)
    progress = {'calls': 0, 'segment': 0}
    def report_step(_module, _inputs, _output):
        progress['calls'] += 1
        if progress['calls'] % 8 == 0:
            emit('soulx_singing', segment=progress['segment'], total=len(metadata), step=progress['calls']//2, steps=int(config.infer.n_steps))
    model.cfm_decoder.model.diff_estimator.register_forward_hook(report_step)
    def infer(index, meta):
        progress.update(calls=0, segment=index+1)
        emit('soulx_singing', segment=index+1, total=len(metadata))
        target = processor.process(copy.deepcopy(meta), None)
        with torch.inference_mode():
            value = model.infer({'prompt': prompt_data, 'target': target}, auto_shift=False, pitch_shift=shift,
                                n_steps=int(config.infer.n_steps), cfg=float(config.infer.cfg), control='score' if args.performance else 'melody', use_fp16=False)
        if not progress['calls']:
            raise ValueError('SoulX inference did not execute')
        value = value.squeeze().cpu().numpy()
        sf.write(out/f'segment-{index+1:02}.wav', value, 24000, subtype='FLOAT')
        return value
    merged = render_segments(metadata, infer, args.seconds, np)
    destination = out/'soulx-vocals.wav'
    sf.write(destination, merged, 24000, subtype='FLOAT')
    report = {'status': 'success', 'engine': 'SoulX-Singer', 'control': 'score' if args.performance else 'melody', 'device': 'cpu',
              'steps': int(config.infer.n_steps), 'cfg': float(config.infer.cfg), 'pitch_shift': shift,
              'segments': len(metadata), 'seconds': len(merged)/24000, 'actual_inference': True,
              'input_sha256': runtime_tools.digest(args.input), 'output_sha256': runtime_tools.digest(destination),
              'model_sha256': runtime_tools.digest(source/'pretrained_models/SoulX-Singer/model.pt'),
              'elapsed_seconds': round(time.monotonic()-started, 1)}
    if args.performance:
        report.update(performance=performance_report, performance_sha256=runtime_tools.digest(args.performance))
    (out/'result.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    emit('soulx_ready', seconds=report['seconds'])


if __name__ == '__main__':
    main()
