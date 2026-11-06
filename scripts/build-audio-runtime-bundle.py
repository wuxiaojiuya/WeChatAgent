"""Build credential-free Windows CPU dependency bundles; no models or user state."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import zipfile


def build(root, kind, source=None, shared_site=None):
    runtime = root/'state/maintenance/audio-capabilities'
    source = source or (runtime/kind if kind != 'soulx-singer' else root/'state/maintenance/soulx-singer')
    python = runtime/'feiyu-cover/python/cpython-3.11-windows-x86_64-none'
    output = root/'state/maintenance/audio-distribution/bundles'
    output.mkdir(parents=True, exist_ok=True)
    archive = output/(kind+'-windows-cpu-'+('20261106' if kind=='soulx-singer' else '20261103')+'.zip')
    addons = root/'state/maintenance/audio-distribution/addons'
    mappings = [(python, 'python'), (source/'venv/Lib/site-packages', 'site-packages'),
                (runtime/'feiyu-cover/tools/mingit', 'git')]
    if kind == 'feiyu-cover':
        mappings.append((addons, 'site-packages'))
    if kind == 'soulx-singer':
        # The validated trial inherited common libraries through shared_runtime.pth.
        # Flatten them into this independent environment; never ship that local path.
        if shared_site:
            mappings.append((shared_site, 'site-packages'))
        elif (source/'venv/Lib/site-packages/shared_runtime.pth').exists():
            raise RuntimeError('BUNDLE_SHARED_SITE_REQUIRED')
    seen = set()
    dependencies = []
    packages={}
    for directory,prefix in mappings:
        if prefix!='site-packages':continue
        for distribution in importlib.metadata.distributions(path=[str(directory)]):
            packages.setdefault(distribution.metadata['Name'].lower(),{'name':distribution.metadata['Name'],'version':distribution.version})
    dependencies=list(packages.values())
    with zipfile.ZipFile(str(archive)+'.partial', 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=3, allowZip64=True) as bundle:
        for directory, prefix in mappings:
            if not directory.is_dir():
                raise RuntimeError('BUNDLE_INPUT_MISSING: '+str(directory))
            for file in sorted(directory.rglob('*')):
                relative = file.relative_to(directory)
                if not file.is_file() or file.is_symlink() or any(p in ('__pycache__', '.git', '.cache') for p in relative.parts) or file.suffix in ('.pyc', '.pyo'):
                    continue
                if kind=='soulx-singer' and (file.name in ('shared_runtime.pth','direct_url.json','wechatagent-long-paths.pth') or file.suffix in ('.pth','.pt','.onnx','.ckpt','.index') and file.name!='distutils-precedence.pth'):
                    continue
                # An overlay distribution replaces the entire older distribution,
                # including its metadata, rather than mixing two versions.
                if prefix=='site-packages' and relative.parts[0].endswith('.dist-info'):
                    dist=relative.parts[0].rsplit('-',1)[0].replace('_','-').lower()
                    chosen=next((p for n,p in packages.items() if n.replace('_','-')==dist),None)
                    if chosen and not relative.parts[0].endswith('-'+chosen['version']+'.dist-info'):continue
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
    parser.add_argument('--kind',required=True,choices=['feiyu-tts','feiyu-cover','soulx-singer'])
    parser.add_argument('--runtime',type=Path)
    parser.add_argument('--shared-site',type=Path)
    args=parser.parse_args()
    build(Path(__file__).resolve().parents[1],args.kind,args.runtime,args.shared_site)
