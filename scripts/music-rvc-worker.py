"""Feiyu's pinned RVC runtime, with support for user-selected RVC models."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import runpy
import sys

p = argparse.ArgumentParser()
p.add_argument("--model", required=True, type=Path)
p.add_argument("--profile", required=True, type=Path)
p.add_argument("--input", required=True, type=Path)
p.add_argument("--output-dir", required=True, type=Path)
p.add_argument("--pitch", type=int, default=0)
p.add_argument("--quality", choices=["standard", "enhanced"], default="enhanced")
a = p.parse_args()
if not -12 <= a.pitch <= 12:
    p.error("Pitch must be between -12 and 12")
model_dir = a.model.resolve(strict=True)
profile = json.loads(a.profile.read_text(encoding="utf-8"))
source, output = a.input.resolve(strict=True), a.output_dir.resolve()
ROOT = Path(__file__).resolve().parents[1] / "state/maintenance/audio-capabilities/feiyu-cover"
SERVER = ROOT / "source/astrbot_plugin_feiyu_voice-76774b499f7d306454562d56348dd63399b6d7e8/server"
sys.path.insert(0, str(SERVER))

import faiss
import numpy as np
import soundfile as sf

reads = []
original_read_index = faiss.read_index


def sha(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def read_index(file, *args):
    if not isinstance(file, (str, Path)):
        return original_read_index(file, *args)
    if args:
        raise ValueError("Unexpected FAISS flags")
    data = Path(file).read_bytes()
    index = faiss.deserialize_index(np.frombuffer(data, dtype="uint8"))
    reads.append(dict(sha256=hashlib.sha256(data).hexdigest(), vectors=index.ntotal, dimension=index.d))
    print(f"FAISS index loaded: {index.ntotal} vectors", flush=True)
    return index


faiss.read_index = read_index
if (model_dir / "manifest.json").is_file() and a.pitch == 0 and a.quality == "standard":
    from feiyu_runtime.rvc import main
    main(model_dir, profile, ["--input", str(source), "--output-dir", str(output)])
else:
    from feiyu_runtime.common import prepare, verify_audio_library, verify_repo, seed_all
    repo = verify_repo(profile)
    if (model_dir / "model.json").is_file():
        info = json.loads((model_dir / "model.json").read_text(encoding="utf-8"))
        weight, index = model_dir / "model.pth", model_dir / "model.index"
        model_hash, index_hash = info["modelSha256"], info.get("indexSha256")
    else:
        from feiyu_runtime.common import verify_package
        manifest = verify_package(model_dir)
        info = dict(id=manifest["id"])
        weight, index = model_dir / manifest["model"]["pth"], model_dir / manifest["model"]["index"]
        model_hash, index_hash = manifest["model"]["pth_sha256"], manifest["model"]["index_sha256"]
    if sha(weight) != model_hash or index_hash and sha(index) != index_hash:
        raise ValueError("Selected model asset checksum mismatch")
    output.mkdir(parents=True, exist_ok=False)
    settings = output / "applio_settings.json"
    settings.write_text(json.dumps({**profile["settings"], "precision": "fp32"}), encoding="utf-8")
    os.environ.update(APPLIO_CONFIG_FILE=str(settings), APPLIO_LOGS_DIR=str(output / "runtime_logs"),
                      HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", OMP_NUM_THREADS="4")
    os.chdir(repo)
    sys.path.insert(0, str(repo))
    import torch
    runtime = prepare(torch, profile)
    verify_audio_library(profile)
    from rvc.configs.config import Config
    Config().device = runtime["device"]
    from rvc.lib.algorithm.synthesizers import Synthesizer
    import rvc.infer.pipeline as pipeline
    original_rmvpe = pipeline.RMVPE

    def rmvpe(*args, **kwargs):
        kwargs["device"] = "cpu"
        return original_rmvpe(*args, **kwargs)

    pipeline.RMVPE = rmvpe
    calls = []
    original_infer = Synthesizer.infer

    def infer(self, *args, **kwargs):
        seed_all(torch, runtime["backend"], 42)
        calls.append(dict(device=str(next(self.parameters()).device)))
        return original_infer(self, *args, **kwargs)

    Synthesizer.infer = infer
    native = output / "rvc_native.wav"
    sys.argv = [str(repo / "core.py"), "infer", "--input-path", str(source), "--output-path", str(native),
                "--pth-path", str(weight), "--index-path", str(index) if index_hash else "",
                "--pitch", str(a.pitch), "--index-rate", ("0.15" if a.quality == "enhanced" else "0.3") if index_hash else "0",
                "--protect", "0.15" if a.quality == "enhanced" else "0.33",
                "--volume-envelope", "0.25" if a.quality == "enhanced" else "1", "--f0-method", "rmvpe",
                "--embedder-model", "contentvec", "--export-format", "WAV"]
    try:
        runpy.run_path(str(repo / "core.py"), run_name="__main__")
    except SystemExit as exc:
        if exc.code not in (0, None):
            raise
    wave, rate = sf.read(native)
    if not calls or not len(wave) or not np.isfinite(wave).all() or np.sqrt(np.mean(wave ** 2)) < 1e-7:
        raise ValueError("No valid model inference output")
    if index_hash and (not reads or reads[0]["sha256"] != index_hash):
        raise ValueError("Selected FAISS index was not loaded")
    receipt = dict(status="success", package=info["id"], model_sha256=model_hash,
                   index_sha256=index_hash, inference=dict(pitch_shift=a.pitch,
                     index_rate=(0.15 if a.quality == "enhanced" else 0.3) if index_hash else 0,
                     protect=0.15 if a.quality == "enhanced" else 0.33,
                     volume_envelope=0.25 if a.quality == "enhanced" else 1, f0_method="rmvpe"),
                   actual_synth_calls=calls, sample_rate=rate, seconds=len(wave) / rate, runtime=runtime)
    (output / "cover_result.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")

if (model_dir / "manifest.json").is_file():
    expected_index = json.loads((model_dir / "manifest.json").read_text(encoding="utf-8"))["model"]["index_sha256"]
    if not reads or reads[0]["sha256"] != expected_index:
        raise ValueError("Built-in FAISS index was not actually loaded")
(output / "faiss_reads.json").write_text(json.dumps(reads, indent=2), encoding="utf-8")
