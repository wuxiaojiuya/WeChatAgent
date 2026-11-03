"""Inspect uploaded inference assets without allowing pickle code execution."""
import argparse
import hashlib
import json
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--kind", choices=("pth", "index"), required=True)
p.add_argument("--input", type=Path, required=True)
a = p.parse_args()
file = a.input.resolve(strict=True)
if a.kind == "index":
    import faiss
    import numpy as np
    index = faiss.deserialize_index(np.frombuffer(file.read_bytes(), dtype="uint8"))
    if index.d not in (256, 768) or index.ntotal < 1:
        raise ValueError("Expected an RVC 256/768-dimensional nonempty index")
    info = dict(dimension=index.d, vectors=index.ntotal)
else:
    import torch
    model = torch.load(file, map_location="cpu", weights_only=True)
    if not isinstance(model, dict) or not isinstance(model.get("weight"), dict):
        raise ValueError("Upload an exported RVC inference model, not a training checkpoint")
    config = model.get("config")
    if not isinstance(config, (list, tuple)) or len(config) < 17:
        raise ValueError("Missing RVC inference configuration")
    if model.get("version", "v1") not in ("v1", "v2") or model.get("f0", 1) not in (0, 1):
        raise ValueError("Unsupported RVC version")
    sr = int(config[-1])
    if sr not in (32000, 40000, 48000) or "emb_g.weight" not in model["weight"]:
        raise ValueError("Unsupported RVC sample rate or missing speaker weights")
    weights = model["weight"]
    if len(weights) < 10 or any(not isinstance(k, str) or not isinstance(v, torch.Tensor) for k, v in weights.items()):
        raise ValueError("Invalid model tensors")
    info = dict(version=model.get("version", "v1"), sampleRate=sr, f0=bool(model.get("f0", 1)),
                dimension=768 if model.get("version", "v1") == "v2" else 256)
info["sha256"] = hashlib.sha256(file.read_bytes()).hexdigest()
print(json.dumps(info))
