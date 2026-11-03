"""Build credential-free Windows CPU dependency bundles; no models or user state."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import zipfile


def build(root, kind):
    runtime = root/'state/maintenance/audio-capabilities'
    source = runtime/kind
    python = runtime/'feiyu-cover/python/cpython-3.11-windows-x86_64-none'
    output = root/'state/maintenance/audio-distribution/bundles'
    output.mkdir(parents=True, exist_ok=True)
    archive = output/(kind+'-windows-cpu-20261103.zip')
    addons = root/'state/maintenance/audio-distribution/addons'
    mappings = [(python, 'python'), (source/'venv/Lib/site-packages', 'site-packages'),
                (runtime/'feiyu-cover/tools/mingit', 'git')]
    if kind == 'feiyu-cover':
        mappings.append((addons, 'site-packages'))
    seen = set()
    dependencies = []
    for distribution in importlib.metadata.distributions(path=[str(source/'venv/Lib/site-packages')]):
        dependencies.append({'name': distribution.metadata['Name'], 'version': distribution.version})
    with zipfile.ZipFile(str(archive)+'.partial', 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=3, allowZip64=True) as bundle:
        for directory, prefix in mappings:
            if not directory.is_dir():
                raise RuntimeError('BUNDLE_INPUT_MISSING: '+str(directory))
            for file in sorted(directory.rglob('*')):
                relative = file.relative_to(directory)
                if not file.is_file() or file.is_symlink() or any(p in ('__pycache__', '.git', '.cache') for p in relative.parts) or file.suffix in ('.pyc', '.pyo'):
                    continue
                name = prefix+'/'+relative.as_posix()
                if name in seen:
                    continue
                seen.add(name)
                bundle.write(file, name)
        bundle.writestr('DEPENDENCIES.json', json.dumps({'schema':1,'kind':kind,'python':'3.11.18','platform':'win32-x64','packages':sorted(dependencies,key=lambda d:d['name'].lower()),'modelsIncluded':False},indent=2))
    Path(str(archive)+'.partial').replace(archive)
    digest = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
    record={'kind':kind,'filename':archive.name,'bytes':archive.stat().st_size,'sha256':digest,'files':len(seen)}
    (output/(kind+'.json')).write_text(json.dumps(record,indent=2),encoding='utf-8')
    print(json.dumps(record),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--kind',required=True,choices=['feiyu-tts','feiyu-cover'])
    args=parser.parse_args()
    build(Path(__file__).resolve().parents[1],args.kind)
