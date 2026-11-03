"""Build an owned, reproducible overlay; upstream release files stay intact."""
import pathlib
import shutil


def prepare_overlay(server, target):
    server, target = pathlib.Path(server), pathlib.Path(target)
    def replace(source, old, new):
        if source.count(old) != 1:
            raise RuntimeError('FEIYU_EMOTION_ADAPTER_VERSION_MISMATCH')
        return source.replace(old, new)
    patches = {
        'feiyu_voice_service/models.py': [('    style: str = Field(default="cute", min_length=1, max_length=40)',
            '    style: str = Field(default="cute", min_length=1, max_length=40)\n    emotion: Literal["neutral", "happy", "sad", "angry", "comforting", "worried", "surprised"] = "neutral"\n    emotionStrength: Literal["gentle", "natural", "strong"] = "natural"')],
        'feiyu_voice_service/worker.py': [('                style=request["style"],',
            '                style=request["style"],\n                emotion=request.get("emotion", "neutral"),\n                emotionStrength=request.get("emotionStrength", "natural"),'),
            ('script = ROOT / "feiyu_runtime/worker.py"', 'script = Path(__file__).resolve().parent.parent / "feiyu_runtime/worker.py"')],
        'feiyu_voice_service/jobs.py': [('                    cwd=ROOT,', '                    cwd=Path(__file__).resolve().parent.parent,')],
        'feiyu_runtime/tts.py': [('    selected = manifest["styles"][request.get("style", manifest["default_style"])]',
            '    from feiyu_voice_reference import select_voice\n    selected, custom_reference = select_voice(manifest, request)'),
            ('    reference = checked_path(package, selected["reference_audio"])', '    reference = custom_reference or checked_path(package, selected["reference_audio"])'),
            ('runtime_rvc=False))', 'runtime_rvc=False, voice_id=request.get("voiceId"), reference_sha256=sha(reference)))'),
            ('        chunks = [x["tts_speech"].detach().cpu().numpy()[0] for x in voice.inference_zero_shot(\n            request["text"], params["prompt_prefix"] + selected["reference_text"], str(reference),\n            stream=False, speed=params["speed"], text_frontend=True)]',
            '        from feiyu_emotion import synthesize\n        chunks = [x["tts_speech"].detach().cpu().numpy()[0] for x in synthesize(voice, request, reference, params, selected["reference_text"])]')],
        'feiyu_voice_service/registry.py': [('paths = sorted((resolve("feiyu_runtime")).glob("*.py"))',
            'paths = sorted((Path(__file__).resolve().parent.parent / "feiyu_runtime").glob("*.py"))\n    paths += [Path(__file__).resolve().parent.parent / name for name in ("feiyu_emotion.py", "feiyu_voice_reference.py")]')],
    }
    target.mkdir(parents=True, exist_ok=True)
    for package in ('feiyu_voice_service', 'feiyu_runtime'):
        (target/package).mkdir(exist_ok=True)
        for file in (server/package).glob('*.py'):
            source = file.read_text(encoding='utf-8')
            for old, new in patches.get(package+'/'+file.name, []):
                source = replace(source, old, new)
            (target/package/file.name).write_text(source, encoding='utf-8')
    shutil.copyfile(pathlib.Path(__file__).with_name('feiyu_emotion.py'), target/'feiyu_emotion.py')
    shutil.copyfile(pathlib.Path(__file__).with_name('feiyu_voice_reference.py'), target/'feiyu_voice_reference.py')
    return target
