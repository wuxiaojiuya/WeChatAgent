"""Original vocals -> AI arrangement -> selected RVC voice -> accompaniment mix."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import importlib.util
import shutil

quality_module = importlib.util.spec_from_file_location("music_quality", Path(__file__).with_name("music-quality.py"))
quality = importlib.util.module_from_spec(quality_module)
quality_module.loader.exec_module(quality)
performance_module = importlib.util.spec_from_file_location('music_performance', Path(__file__).with_name('music-performance.py'))
performance_tools = importlib.util.module_from_spec(performance_module)
performance_module.loader.exec_module(performance_tools)

ROOT = Path(__file__).resolve().parents[1] / "state/maintenance/audio-capabilities/feiyu-cover"
SERVER = ROOT / "source/astrbot_plugin_feiyu_voice-76774b499f7d306454562d56348dd63399b6d7e8/server"
try:
    import imageio_ffmpeg
    FFMPEG = Path(imageio_ffmpeg.get_ffmpeg_exe())
except ImportError:
    FFMPEG = Path("C:/ffmpeg-tools/bin/ffmpeg.exe")


def sha(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(8 * 1024**2), b""):
            value.update(block)
    return value.hexdigest()


def run(args):
    subprocess.run([str(a) for a in args], check=True)


def selected_model_hash(directory):
    directory = Path(directory)
    if (directory / 'model.json').is_file():
        record = json.loads((directory / 'model.json').read_text('utf-8'))
        file, expected = directory / 'model.pth', record['modelSha256']
    else:
        record = json.loads((directory / 'manifest.json').read_text('utf-8'))['model']
        file, expected = directory / record['pth'], record['pth_sha256']
        if not file.resolve().is_relative_to(directory.resolve()):
            raise ValueError('Invalid selected model path')
    if sha(file) != expected:
        raise ValueError('Selected voice model checksum mismatch')
    return expected


def separate(source, out, enhanced=True):
    import numpy as np
    import soundfile as sf
    import torch
    from demucs.apply import apply_model
    from demucs.states import load_model

    checkpoint = ROOT / "models/demucs/955717e8-8726e21a.th"
    record = json.loads((checkpoint.parent / "download.json").read_text())
    if sha(checkpoint) != record["sha256"] or not record["sha256"].startswith("8726e21a"):
        raise ValueError("Demucs official checkpoint checksum mismatch")
    torch.set_num_threads(4)
    torch.manual_seed(42)
    # This official Demucs checkpoint serializes its architecture class as well
    # as tensors. Only load after verifying its published checksum.
    model = load_model(torch.load(checkpoint, map_location="cpu", weights_only=False))
    model.eval()
    audio, rate = sf.read(source, always_2d=True, dtype="float32")
    if rate != model.samplerate or audio.shape[1] != model.audio_channels:
        raise ValueError("Unexpected Demucs input format")
    wav = torch.from_numpy(audio.T.copy())
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std()
    if std < 1e-7:
        raise ValueError("Source is silent")
    with torch.inference_mode():
        stems = apply_model(model, ((wav - mean) / std)[None], device="cpu",
                            shifts=2 if enhanced else 0, split=True,
                            overlap=0.5 if enhanced else 0.25, progress=True)[0]
    stems = stems * std + mean
    vocal_index = model.sources.index("vocals")
    vocal = stems[vocal_index].numpy().T
    instrumental = sum(stems[i] for i in range(len(model.sources)) if i != vocal_index).numpy().T
    if not np.isfinite(vocal).all() or not np.isfinite(instrumental).all():
        raise ValueError("Non-finite separation output")
    sf.write(out / "original-vocals.wav", vocal, rate, subtype="FLOAT")
    sf.write(out / "accompaniment.wav", instrumental, rate, subtype="FLOAT")
    return {"engine": "Demucs 4.0.1 htdemucs", "checkpoint_sha256": record["sha256"],
            "device": "cpu", "seconds": len(audio) / rate,
            "shifts": 2 if enhanced else 0, "overlap": 0.5 if enhanced else 0.25,
            "vocal_rms": float(np.sqrt(np.mean(vocal.astype("float64") ** 2)))}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input", required=True, type=Path)
    p.add_argument("--start", default=0.0, type=float)
    p.add_argument("--seconds", default=30.0, type=float)
    p.add_argument("--output", required=True, type=Path)
    p.add_argument("--separate-only", action="store_true")
    p.add_argument("--model", required=True, type=Path)
    p.add_argument("--pitch", default=0, type=int)
    p.add_argument("--vocals-only", action="store_true")
    p.add_argument("--quality", choices=["standard", "enhanced"], default="enhanced")
    p.add_argument('--performance', type=Path)
    p.add_argument('--reference', type=Path)
    a = p.parse_args()
    if a.start < 0 or not 0 < a.seconds <= 30:
        p.error("Use a nonnegative start and 0 < seconds <= 30")
    source = a.input.resolve(strict=True)
    a.model = a.model.resolve(strict=True)
    expected_hash = selected_model_hash(a.model)
    out = a.output.resolve()
    # Video requests put their verified input in the job folder before launch.
    out.mkdir(parents=True, exist_ok=True)
    if any((out / name).exists() for name in ["source-clip.wav", "result.json", "soulx", "rvc"]):
        raise ValueError("Output directory contains a previous audio job")
    started = time.monotonic()
    clip = out / "source-clip.wav"
    plan = performance_tools.validate_arrangement(json.loads(a.performance.read_text('utf-8')), a.seconds) if a.performance else None
    if not a.separate_only and not plan:
        raise ValueError('AI source-vocal arrangement is required')
    total_pitch = a.pitch + (plan['pitchShift'] if plan else 0)
    if not -12 <= total_pitch <= 12:
        raise ValueError('Combined voice and arrangement pitch must be between -12 and 12')
    reference = None
    if a.reference:
        if not plan or a.start != 0: raise ValueError('Reference requires a performance plan and zero start')
        ref = a.reference.resolve(strict=True)
        reference = json.loads((ref/'reference.json').read_text('utf-8'))
        if reference.get('schema') != 'singing-reference-v1' or reference.get('source_sha256') != sha(source) or abs(reference['seconds']-a.seconds) > .05:
            raise ValueError('Reference source or timing mismatch')
        for name in ['source-clip.wav', 'original-vocals.wav', 'accompaniment.wav']:
            file = ref/name
            if not file.resolve().is_relative_to(ref) or sha(file) != reference['files'].get(name):
                raise ValueError('Reference stem checksum mismatch')
            shutil.copyfile(file, out/name)
    else:
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", a.start, "-i", source,
             "-t", a.seconds, "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_f32le", clip])
    import numpy as np
    import soundfile as sf
    info = sf.info(clip)
    if abs(info.duration - a.seconds) > 0.05:
        raise ValueError("Source is too short for the requested excerpt")
    print("Separating vocals and accompaniment on CPU", flush=True)
    enhanced = a.quality == "enhanced"
    separation = reference['separation'] if reference else separate(clip, out, enhanced)
    (out / "separation.json").write_text(json.dumps(separation, indent=2), encoding="utf-8")
    if a.separate_only:
        print(out / "original-vocals.wav", flush=True)
        return
    os.environ["PATH"] = os.pathsep.join([str(ROOT / "git/cmd"), str(ROOT / "tools/mingit/cmd"), str(FFMPEG.parent), os.environ.get("PATH", "")])
    os.environ["PYTHONIOENCODING"] = "utf-8"
    print(json.dumps({'stage': 'source_vocal_arranged', 'pitch_shift': total_pitch}), flush=True)
    rvc_input = out / 'original-vocals.wav'
    reference, reference_rate = sf.read(rvc_input, always_2d=True)
    if enhanced:
        rvc_input = out / "conditioned-vocals.wav"
        sf.write(rvc_input, quality.prepare_vocals(reference, reference_rate), reference_rate, subtype="FLOAT")
    print(f"Converting with selected RVC model, quality={a.quality}, pitch={total_pitch}", flush=True)
    run([sys.executable, Path(__file__).with_name("music-rvc-worker.py"),
         "--model", a.model.resolve(), "--pitch", total_pitch, "--profile", ROOT / "runtime.cpu.json",
         "--input", rvc_input, "--output-dir", out / "rvc", "--quality", a.quality])
    rvc_receipt = json.loads((out / "rvc/cover_result.json").read_text("utf-8"))
    if rvc_receipt.get("status") != "success" or rvc_receipt.get("model_sha256") != expected_hash or not rvc_receipt.get("actual_synth_calls") or rvc_receipt.get('input_sha256') != sha(rvc_input):
        raise ValueError("Selected RVC model inference was not verified")
    finish_cover(a, out, source, expected_hash, separation, started)


def finish_cover(a, out, source, expected_hash, separation, started):
    """Finish verified inference separately so tail/mix repairs need no resynthesis."""
    import numpy as np
    import soundfile as sf
    if (out/'result.json').exists():
        raise ValueError('Output directory contains a previous audio job')
    rvc_receipt = json.loads((out/'rvc/cover_result.json').read_text('utf-8'))
    if rvc_receipt.get('status') != 'success' or rvc_receipt.get('model_sha256') != expected_hash or not rvc_receipt.get('actual_synth_calls'):
        raise ValueError('Selected RVC model inference was not verified')
    reference, reference_rate = sf.read(out/'original-vocals.wav', always_2d=True)
    plan = performance_tools.validate_arrangement(json.loads(a.performance.read_text('utf-8')), a.seconds)
    enhanced = a.quality == 'enhanced'
    rvc_input = out/('conditioned-vocals.wav' if enhanced else 'original-vocals.wav')
    total_pitch = a.pitch + plan['pitchShift']
    if rvc_receipt.get('input_sha256') != sha(rvc_input) or rvc_receipt.get('inference', {}).get('pitch_shift') != total_pitch:
        raise ValueError('RVC source-vocal or pitch receipt mismatch')
    converted, rate = sf.read(out / "rvc/rvc_native.wav")
    vocal_report = None
    mix_vocal = out / "rvc/rvc_native.wav"
    if enhanced:
        converted, vocal_report = quality.finish_vocals(converted, rate, reference, reference_rate)
        mix_vocal = out / "cleaned-vocals.wav"
        sf.write(mix_vocal, converted, rate, subtype="FLOAT")
    # Balance against the source before applying AI dynamics, so a single
    # phrase's gain is not immediately cancelled by RMS normalization.
    rms = float(np.sqrt(np.mean(converted.astype("float64") ** 2)))
    if rms < 1e-7:
        raise ValueError("Converted vocal is silent")
    gain = float(np.clip(separation["vocal_rms"] / rms, 0.25, 2.0 if enhanced else 4.0))
    dynamics = None
    if plan:
        converted, dynamics = performance_tools.apply_dynamics(converted, rate, plan, a.seconds)
        mix_vocal = out/'arranged-vocals.wav'
        sf.write(mix_vocal, converted, rate, subtype='FLOAT')
    accompaniment = out/'accompaniment.wav'
    accompaniment_gain = float(10**(plan['accompanimentGainDb']/20))
    if total_pitch:
        import librosa
        backing, backing_rate = sf.read(accompaniment, always_2d=True, dtype='float32')
        backing = librosa.effects.pitch_shift(backing.T, sr=backing_rate, n_steps=total_pitch).T
        if not np.isfinite(backing).all(): raise ValueError('Invalid transposed accompaniment')
        accompaniment = out/'transposed-accompaniment.wav'
        sf.write(accompaniment, backing, backing_rate, subtype='FLOAT')
    result = out / f"feiyu-cover-{a.seconds:g}s.wav"
    print(json.dumps({"stage": "mixing"}), flush=True)
    graph = (f"[0:a]aresample=44100,volume={gain}[voice];"
             f"[1:a]volume={accompaniment_gain}[backing];[voice][backing]amix=inputs=2:duration=longest:normalize=0,"
             f"atrim=duration={a.seconds},afade=t=in:d=0.03,"
             f"afade=t=out:st={max(0, a.seconds - 0.2)}:d=0.2,"
             "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100,"
             "alimiter=limit=0.97:level=false[out]")
    if a.vocals_only:
        graph = (f"[0:a]aresample=44100,atrim=duration={a.seconds},"
                 f"apad=whole_dur={a.seconds},afade=t=in:d=0.03,"
                 f"afade=t=out:st={max(0, a.seconds - 0.2)}:d=0.2,"
                 "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100[out]")
    if enhanced:
        # Float mixing preserves headroom before mastering. A soft compressor
        # controls converted vocal bursts without flattening the accompaniment.
        voice = (f"[0:a]aresample=44100,volume={gain},"
                 "acompressor=threshold=0.35:ratio=2:attack=8:release=100:makeup=1[voice];")
        mix = "[voice]anull" if a.vocals_only else f"[1:a]volume={accompaniment_gain}[backing];[voice][backing]amix=inputs=2:duration=longest:normalize=0"
        graph = (voice + mix + f",apad=whole_dur={a.seconds},atrim=duration={a.seconds},"
                 "afade=t=in:d=0.03," + f"afade=t=out:st={max(0, a.seconds - 0.2)}:d=0.2[out]")
        premaster = out / "premaster.wav"
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", mix_vocal,
             "-i", accompaniment, "-filter_complex", graph,
             "-map", "[out]", "-ac", "2", "-c:a", "pcm_f32le", premaster])
        loudness = subprocess.run([str(FFMPEG), "-hide_banner", "-i", str(premaster),
            "-af", "loudnorm=I=-16:TP=-2.5:LRA=11:print_format=json", "-f", "null", "-"],
            capture_output=True, text=True, check=True).stderr
        measured = json.loads(loudness[loudness.rfind("{"):loudness.rfind("}") + 1])
        values = [float(measured[key]) for key in ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]]
        if not np.isfinite(values).all():
            raise ValueError("Invalid loudness measurement")
        master = (f"loudnorm=I=-16:TP=-2.5:LRA=11:measured_I={values[0]}:"
                  f"measured_TP={values[1]}:measured_LRA={values[2]}:"
                  f"measured_thresh={values[3]}:offset={values[4]}:linear=true,"
                  "aresample=44100,alimiter=limit=0.84:level=false:latency=true")
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", premaster,
             "-af", master, "-ac", "2", "-c:a", "pcm_s24le", result])
    else:
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", mix_vocal,
         "-i", accompaniment, "-filter_complex", graph,
         "-map", "[out]", "-ac", "2", "-c:a", "pcm_s16le", result])
    audio, rate = sf.read(result)
    peak = float(np.max(np.abs(audio)))
    duration = len(audio) / rate
    if abs(duration - a.seconds) > 0.05 or not np.isfinite(audio).all() or peak < 1e-7 or peak >= 1:
        raise ValueError("Final audio validation failed")
    receipt = dict(status="success", route="source vocal -> AI arrangement -> selected RVC -> accompaniment remix",
                   source=str(source), source_sha256=sha(source), start=a.start,
                   seconds=duration, separation=separation, rvc_receipt="rvc/cover_result.json",
                   model_sha256=expected_hash, source_vocals_used=True,
                   rvc_input_sha256=sha(rvc_input), original_vocals_mixed=False,
                   accompaniment_source="Demucs source separation", accompaniment_pitch_shift=total_pitch,
                   accompaniment_gain_db=plan['accompanimentGainDb'],
                   vocal_gain=gain, output_sha256=sha(result), peak=peak,
                   sample_rate=rate, channels=audio.shape[1],
                   wall_seconds=time.monotonic() - started, listening_approved=False)
    receipt["quality"] = dict(profile=a.quality, vocal_conditioning=vocal_report,
                           output=quality.audio_stats(audio),
                           mastering="two-pass -16 LUFS / -2.5 dBTP" if enhanced else "legacy single-pass")
    if plan:
        receipt['performance_sha256'] = sha(a.performance)
        receipt['performance'] = {'control': 'source-vocal', 'source_f0_used': True,
                                  'pitch_shift': total_pitch, 'accompaniment_gain_db': plan['accompanimentGainDb'],
                                  'timing_preserved': True, 'dynamics': dynamics}
    (out / "result.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    print(result, flush=True)


if __name__ == "__main__":
    main()
