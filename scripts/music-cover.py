"""Original recording -> CPU Demucs -> pinned Feiyu RVC -> FFmpeg remix.

This is a local experiment, not an endpoint provided by the upstream plugin.
No TTS or cloud API is used. Every run needs a new output directory.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import importlib.util

quality_module = importlib.util.spec_from_file_location("music_quality", Path(__file__).with_name("music-quality.py"))
quality = importlib.util.module_from_spec(quality_module)
quality_module.loader.exec_module(quality)

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
    a = p.parse_args()
    if a.start < 0 or not 0 < a.seconds <= 30:
        p.error("Use a nonnegative start and 0 < seconds <= 30")
    source = a.input.resolve(strict=True)
    out = a.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    clip = out / "source-clip.wav"
    run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", a.start, "-i", source,
         "-t", a.seconds, "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_f32le", clip])
    import numpy as np
    import soundfile as sf
    info = sf.info(clip)
    if abs(info.duration - a.seconds) > 0.05:
        raise ValueError("Source is too short for the requested excerpt")
    print("Separating vocals and accompaniment on CPU", flush=True)
    enhanced = a.quality == "enhanced"
    separation = separate(clip, out, enhanced)
    (out / "separation.json").write_text(json.dumps(separation, indent=2), encoding="utf-8")
    if a.separate_only:
        print(out / "original-vocals.wav", flush=True)
        return
    os.environ["PATH"] = os.pathsep.join([str(ROOT / "git/cmd"), str(ROOT / "tools/mingit/cmd"), str(FFMPEG.parent), os.environ.get("PATH", "")])
    os.environ["PYTHONIOENCODING"] = "utf-8"
    rvc_input = out / "original-vocals.wav"
    reference, reference_rate = sf.read(rvc_input, always_2d=True)
    if enhanced:
        rvc_input = out / "conditioned-vocals.wav"
        sf.write(rvc_input, quality.prepare_vocals(reference, reference_rate), reference_rate, subtype="FLOAT")
    print(f"Converting with selected RVC model, quality={a.quality}, pitch={a.pitch}", flush=True)
    run([sys.executable, Path(__file__).with_name("music-rvc-worker.py"),
         "--model", a.model.resolve(), "--pitch", a.pitch, "--profile", ROOT / "runtime.cpu.json",
         "--input", rvc_input, "--output-dir", out / "rvc", "--quality", a.quality])
    converted, rate = sf.read(out / "rvc/rvc_native.wav")
    vocal_report = None
    mix_vocal = out / "rvc/rvc_native.wav"
    if enhanced:
        converted, vocal_report = quality.finish_vocals(converted, rate, reference, reference_rate)
        mix_vocal = out / "cleaned-vocals.wav"
        sf.write(mix_vocal, converted, rate, subtype="FLOAT")
    rms = float(np.sqrt(np.mean(converted.astype("float64") ** 2)))
    if rms < 1e-7:
        raise ValueError("Converted vocal is silent")
    gain = float(np.clip(separation["vocal_rms"] / rms, 0.25, 2.0 if enhanced else 4.0))
    result = out / f"feiyu-cover-{a.seconds:g}s.wav"
    graph = (f"[0:a]aresample=44100,volume={gain}[voice];"
             "[voice][1:a]amix=inputs=2:duration=longest:normalize=0,"
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
        mix = "[voice]anull" if a.vocals_only else "[voice][1:a]amix=inputs=2:duration=longest:normalize=0"
        graph = (voice + mix + f",apad=whole_dur={a.seconds},atrim=duration={a.seconds},"
                 "afade=t=in:d=0.03," + f"afade=t=out:st={max(0, a.seconds - 0.2)}:d=0.2[out]")
        premaster = out / "premaster.wav"
        run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", mix_vocal,
             "-i", out / "accompaniment.wav", "-filter_complex", graph,
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
         "-i", out / "accompaniment.wav", "-filter_complex", graph,
         "-map", "[out]", "-ac", "2", "-c:a", "pcm_s16le", result])
    audio, rate = sf.read(result)
    peak = float(np.max(np.abs(audio)))
    duration = len(audio) / rate
    if abs(duration - a.seconds) > 0.05 or not np.isfinite(audio).all() or peak < 1e-7 or peak >= 1:
        raise ValueError("Final audio validation failed")
    receipt = dict(status="success", route="separation -> Feiyu RVC -> remix",
                   source=str(source), source_sha256=sha(source), start=a.start,
                   seconds=duration, separation=separation, rvc_receipt="rvc/cover_result.json",
                   vocal_gain=gain, output_sha256=sha(result), peak=peak,
                   sample_rate=rate, channels=audio.shape[1],
                   wall_seconds=time.monotonic() - started, listening_approved=False)
    receipt["quality"] = dict(profile=a.quality, vocal_conditioning=vocal_report,
                           output=quality.audio_stats(audio),
                           mastering="two-pass -16 LUFS / -2.5 dBTP" if enhanced else "legacy single-pass")
    (out / "result.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    print(result, flush=True)


if __name__ == "__main__":
    main()
