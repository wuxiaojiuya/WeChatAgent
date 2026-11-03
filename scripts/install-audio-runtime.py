"""Install pinned Windows CPU dependencies and official Feiyu model packages."""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
import traceback
import urllib.parse
import urllib.request
import uuid
import zipfile

MANIFEST=json.loads(Path(__file__).with_name('audio-runtime-manifest.json').read_text('utf-8'))
RUNTIME_NAMES={'tts':'feiyu-tts','rvc':'feiyu-cover'}
CURRENT_LOG=None


def long_path(file):
    """Filesystem-only paths; do not pass the Windows namespace to Git/configs."""
    value=str(Path(file).resolve())
    if os.name=='nt' and not value.startswith('\\\\?\\'):
        value='\\\\?\\UNC\\'+value[2:] if value.startswith('\\\\') else '\\\\?\\'+value
    return Path(value)


def remove_tree(folder):
    def retry(function,file,_):
        os.chmod(file,stat.S_IWRITE|stat.S_IREAD);function(file)
    shutil.rmtree(long_path(folder),onerror=retry)


def emit(phase,message,**values):
    print(json.dumps({'phase':phase,'message':message,**values},ensure_ascii=False),flush=True)


def digest(file):
    with long_path(file).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def write_json(file,value):
    file=Path(file);file.parent.mkdir(parents=True,exist_ok=True)
    tmp=file.with_name(file.name+'.tmp')
    tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8');tmp.replace(file)


def run(command,*,env=None,cwd=None,timeout=1800,log=None):
    result=subprocess.run([str(x) for x in command],cwd=cwd,env=env,capture_output=True,timeout=timeout,
        creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    if log:
        with Path(log).open('ab') as stream:stream.write(result.stdout+result.stderr)
    if result.returncode:raise RuntimeError('AUDIO_SUBPROCESS_FAILED')
    return result.stdout.decode('utf-8','replace').strip()


def download(url,target,sha,expected=None):
    target=Path(target);target.parent.mkdir(parents=True,exist_ok=True)
    if target.is_file() and digest(target)==sha:return target
    node=os.environ.get('WECHATAGENT_INSTALL_NODE')
    if node:
        command=[node,str(Path(__file__).with_name('download-audio-asset.mjs')),url,str(target),sha,str(expected or 0)]
        with subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0)) as process:
            code=None
            for line in process.stdout:
                try:
                    event=json.loads(line.decode('utf-8'))
                    if event.get('phase')=='failed':
                        code=event.get('code')
                        values={k:event[k] for k in ('httpStatus','sourceHost') if k in event}
                        emit('diagnostic','安装资源下载未完成',**values)
                        if CURRENT_LOG:
                            with CURRENT_LOG.open('a',encoding='utf-8') as log:log.write(json.dumps(event,ensure_ascii=False)+'\n')
                    else:emit(event['phase'],event['message'],**{k:v for k,v in event.items() if k not in ('phase','message')})
                except (ValueError,KeyError):pass
            if process.wait():raise RuntimeError(code or 'AUDIO_DOWNLOAD_TOOL_FAILED')
        if not target.exists() or digest(target)!=sha:raise RuntimeError('AUDIO_DOWNLOAD_HASH_MISMATCH')
        return target
    part=target.with_name(target.name+'.partial')
    offset=part.stat().st_size if part.is_file() else 0
    if expected and offset>=expected:part.unlink();offset=0
    req=urllib.request.Request(url,headers={'User-Agent':'WeChatAgent-Audio-Installer/1','Range':f'bytes={offset}-'} if offset else {'User-Agent':'WeChatAgent-Audio-Installer/1'})
    with urllib.request.urlopen(req,timeout=45) as response:
        if offset and (response.status!=206 or not response.headers.get('Content-Range','').startswith(f'bytes {offset}-')):
            offset=0
        total=expected or int(response.headers.get('Content-Length','0'))+offset
        received=offset;last=0
        with part.open('ab' if offset else 'wb') as stream:
            while True:
                chunk=response.read(1024*1024)
                if not chunk:break
                received+=len(chunk)
                if received>(expected or 2*1024**3):raise RuntimeError('AUDIO_DOWNLOAD_TOO_LARGE')
                stream.write(chunk)
                if time.monotonic()-last>1:
                    emit('download','正在下载并校验安装资源',downloaded=received,total=total);last=time.monotonic()
    if expected and part.stat().st_size!=expected:raise RuntimeError('AUDIO_DOWNLOAD_INCOMPLETE')
    if digest(part)!=sha:
        part.unlink();raise RuntimeError('AUDIO_DOWNLOAD_HASH_MISMATCH')
    part.replace(target);return target


def extract(archive,destination):
    """Reject Windows path escapes, aliases and links before extracting any member."""
    destination=Path(destination);seen=set();total=0
    with zipfile.ZipFile(archive) as bundle:
        for entry in bundle.infolist():
            name=entry.filename.replace('\\','/');parts=name.rstrip('/').split('/')
            if name.startswith('/') or any(p in ('','.','..') or ':' in p or p.endswith(('.', ' ')) or re.fullmatch(r'(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?',p) for p in parts) or stat.S_ISLNK(entry.external_attr>>16):
                raise RuntimeError('AUDIO_ARCHIVE_PATH_INVALID')
            key=name.casefold().rstrip('/')
            if key in seen:raise RuntimeError('AUDIO_ARCHIVE_DUPLICATE')
            seen.add(key);total+=entry.file_size
            if total>20*1024**3 or len(seen)>100000:raise RuntimeError('AUDIO_ARCHIVE_TOO_LARGE')
            if not (destination/name).resolve().is_relative_to(destination.resolve()):raise RuntimeError('AUDIO_ARCHIVE_PATH_INVALID')
        bundle.extractall(long_path(destination))


def clone(git,source,destination,log,recursive=False):
    destination=Path(destination)
    run([git,'-c','core.longpaths=true','init',destination],log=log)
    run([git,'-C',destination,'config','core.longpaths','true'],log=log)
    run([git,'-C',destination,'remote','add','origin',source['url']],log=log)
    run([git,'-C',destination,'fetch','--depth','1','origin',source['commit']],log=log)
    run([git,'-C',destination,'-c','core.autocrlf=false','checkout','--detach',source['commit']],log=log)
    if recursive:run([git,'-C',destination,'-c','core.autocrlf=false','submodule','update','--init','--recursive','--depth','1'],log=log)


def adapter(root,git,log):
    source=MANIFEST['adapter'];folder=root/'state/maintenance/audio-capabilities/feiyu-cover/source'/('astrbot_plugin_feiyu_voice-'+source['commit'])
    if folder.exists():
        if run([git,'-C',folder,'rev-parse','HEAD'],log=log)!=source['commit']:raise RuntimeError('AUDIO_ADAPTER_VERSION_MISMATCH')
        run([git,'-C',folder,'diff','--exit-code','HEAD'],log=log)
        return folder/'server'
    stage=folder.with_name('adapter-'+uuid.uuid4().hex[:12])
    folder.parent.mkdir(parents=True,exist_ok=True)
    clone(git,source,stage,log);stage.replace(folder)
    return folder/'server'


def package_valid(server,package):
    sys.path.insert(0,str(server))
    try:
        from feiyu_runtime.common import verify_package
        verify_package(package);return True
    except (OSError,ValueError,KeyError,RuntimeError):return False


def model(root,kind,server,python,env,staging,log):
    config=MANIFEST['models'][kind];target=root/'state/maintenance/audio-capabilities'/RUNTIME_NAMES[kind]/'models'/config['folder']
    if target.is_dir() and package_valid(server,target):
        emit('models','已验证并保留现有音色模型');return target,None
    emit('models','正在从原作者下载音色模型，首次下载可能需要较长时间')
    # Keep resumable official downloads outside disposable staging. A later
    # resource failure must not discard several GB of already verified models.
    cache=root/'state/audio-install/model-cache'/kind/config['revision']
    if cache.is_symlink():raise RuntimeError('AUDIO_TARGET_INVALID')
    cache.parent.mkdir(parents=True,exist_ok=True)
    if not cache.is_dir() or not package_valid(server,cache):
        script='from huggingface_hub import snapshot_download; import sys; snapshot_download(repo_id=sys.argv[1],revision=sys.argv[2],local_dir=sys.argv[3],max_workers=3)'
        run([python,'-c',script,config['repo'],config['revision'],cache],env=env,timeout=10800,log=log)
    else:emit('models','复用已校验的官方音色模型缓存，无需重新下载')
    if not package_valid(server,cache):raise RuntimeError('AUDIO_MODEL_HASH_MISMATCH')
    staged=staging/'model'
    shutil.copytree(cache,staged,ignore=shutil.ignore_patterns('.cache','.git'))
    if not package_valid(server,staged):raise RuntimeError('AUDIO_MODEL_HASH_MISMATCH')
    return target,staged


def profile(server,kind,python,repo,env):
    sys.path.insert(0,str(server/'scripts'))
    from setup_runtime import source_manifest
    version=json.loads(run([python,'-c','import torch,torchaudio,json; print(json.dumps([str(torch.__version__),str(torchaudio.__version__)]))'],env=env,timeout=120))
    result={'schema':'feiyu-runtime-v1','engine':kind,'backend':'cpu','host':'windows','precision':'float32',
        'python':str(python),'repo':str(repo),'commit':MANIFEST['sources'][kind]['commit'],
        'torch_version':version[0],'torchaudio_version':version[1],'onnx_provider':'CPUExecutionProvider','source_sha256':source_manifest(repo)}
    if kind=='rvc':
        result['f0_device']='cpu';result['settings']=json.loads((server/'configs/applio_settings.json').read_text('utf-8'));result['settings']['precision']='fp32'
    return result


def local_env(git,root):
    env={**os.environ,'PYTHONUTF8':'1','PYTHONIOENCODING':'utf-8','PYTHONDONTWRITEBYTECODE':'1','HF_HUB_DISABLE_SYMLINKS_WARNING':'1'}
    env['PATH']=str(git.parent)+os.pathsep+env.get('PATH','')
    env.pop('PYTHONHOME',None);env.pop('PYTHONPATH',None);env.pop('FEIYU_API_KEY',None)
    return env


def verify(root,kind,log,smoke=False):
    folder=root/'state/maintenance/audio-capabilities'/RUNTIME_NAMES[kind]
    if not (folder/'venv/Scripts/python.exe').is_file() or not (folder/'runtime.cpu.json').is_file():
        raise RuntimeError('AUDIO_ENVIRONMENT_NOT_INSTALLED')
    python=folder/'venv/Scripts/python.exe';git=folder/'git/cmd/git.exe';env=local_env(git,root)
    server=root/'state/maintenance/audio-capabilities/feiyu-cover/source'/('astrbot_plugin_feiyu_voice-'+MANIFEST['adapter']['commit'])/'server'
    script='import sys,json;sys.path.insert(0,sys.argv[1]);from feiyu_runtime.common import load,verify_repo,verify_package,prepare,verify_audio_library;import torch; p=load(sys.argv[2]);verify_repo(p);verify_package(sys.argv[3]);prepare(torch,p);verify_audio_library(p)'
    package=folder/'models'/MANIFEST['models'][kind]['folder']
    run([python,'-c',script,server,folder/'runtime.cpu.json',package],env=env,timeout=300,log=log)
    if kind=='tts':
        normalizer=json.loads((folder/'normalizer.json').read_text('utf-8'))['directory'];env['WECHATAGENT_FEIYU_WETEXT']=normalizer
        env['PYTHONPATH']=str(root/'scripts/feiyu-site')
        for name,sha in MANIFEST['wetext'].items():
            if digest(Path(normalizer)/name)!=sha:raise RuntimeError('AUDIO_NORMALIZER_INVALID')
    else:
        run([python,'-c','import faiss,demucs,librosa,soundfile,imageio_ffmpeg'],env=env,timeout=120,log=log)
        checkpoint=folder/'models/demucs/955717e8-8726e21a.th'
        if digest(checkpoint)!=MANIFEST['demucs']['sha256']:raise RuntimeError('AUDIO_MODEL_HASH_MISMATCH')
    if not smoke:return
    output=root/'state/audio-install/previews'/(kind+'-'+uuid.uuid4().hex)
    output.parent.mkdir(parents=True,exist_ok=True)
    if kind=='tts':
        request=output.with_suffix('.json');write_json(request,{'text':'你好，语音环境安装完成。','style':'cute','output_dir':str(output)})
        run([python,server/'feiyu_runtime/worker.py','--kind','tts','--package',package,'--profile',folder/'runtime.cpu.json','--request',request],env=env,timeout=1800,log=log)
        receipt=json.loads((output/'result.json').read_text('utf-8'))
        if receipt.get('actual_text_frontend')!='wetext' or receipt.get('seconds',0)<=0:raise RuntimeError('AUDIO_SMOKE_FAILED')
        emit('validation','已生成本地语音试听',preview=str(output/'speech.wav'),seconds=receipt['seconds'])
    else:
        # A short synthetic tone validates the pipeline, not singing quality.
        source=output.with_suffix('.wav')
        run([python,'-c','import numpy as n,soundfile as s,sys;t=n.arange(44100*3)/44100;s.write(sys.argv[1],n.stack([.1*n.sin(2*n.pi*220*t)]*2,axis=1),44100)',source],env=env,log=log)
        run([python,root/'scripts/music-cover.py','--input',source,'--seconds','3','--model',package,'--output',output,'--quality','standard'],env=env,timeout=1800,log=log)
        emit('validation','RVC 分离、换声和混音测试通过；实际歌声音质请用歌曲试听',preview=str(output/'feiyu-cover-3s.wav'))


def activate(root,changes,validate,log):
    identifier=uuid.uuid4().hex;backup=root/'state/audio-install/backups'/identifier;backup.mkdir(parents=True)
    journal=root/'state/audio-install/activation.json';operations=[]
    for staged,target in changes:
        target=Path(target)
        if not target.resolve().is_relative_to(root.resolve()) or target.is_symlink():raise RuntimeError('AUDIO_TARGET_INVALID')
        operations.append({'staged':str(staged),'target':str(target),'backup':str(backup/str(len(operations))),'hadOriginal':target.exists()})
    write_json(journal,{'state':'activating','operations':operations})
    try:
        for item in operations:
            staged,target,old=map(Path,(item['staged'],item['target'],item['backup']));target.parent.mkdir(parents=True,exist_ok=True)
            if item['hadOriginal']:target.replace(old)
            staged.replace(target)
        validate()
        write_json(journal,{'state':'complete','operations':operations})
    except BaseException:
        recover(root);raise


def recover(root):
    journal=root/'state/audio-install/activation.json'
    if not journal.exists():return
    saved=json.loads(journal.read_text('utf-8'))
    if saved.get('state')!='activating':return
    for item in reversed(saved['operations']):
        target,staged,old=map(Path,(item['target'],item['staged'],item['backup']))
        if not all(p.resolve().is_relative_to(root.resolve()) and not p.is_symlink() for p in (target,staged,old)):raise RuntimeError('AUDIO_TARGET_INVALID')
        if not target.resolve().is_relative_to((root/'state/maintenance/audio-capabilities').resolve()) or not old.resolve().is_relative_to((root/'state/audio-install/backups').resolve()) or not staged.resolve().is_relative_to((root/'state/audio-install/staging').resolve()):raise RuntimeError('AUDIO_TARGET_INVALID')
        if old.exists() or not item['hadOriginal'] and not staged.exists():
            if target.is_dir():remove_tree(target)
            elif target.exists():target.unlink()
            if old.exists():old.replace(target)
    write_json(journal,{'state':'rolled-back','operations':saved['operations']})


def install(root,kind,action,log):
    staging=root/'state/audio-install/staging'/uuid.uuid4().hex
    try:install_environment(root,kind,action,log,staging)
    finally:
        journal=root/'state/audio-install/activation.json'
        pending=journal.exists() and json.loads(journal.read_text('utf-8')).get('state')=='activating'
        if staging.exists() and not pending:
            try:remove_tree(staging)
            except OSError:
                with Path(log).open('a',encoding='utf-8') as stream:stream.write('\nStaging cleanup incomplete; retry after stopping audio processes.\n')


def install_environment(root,kind,action,log,staging):
    name=RUNTIME_NAMES[kind];target=root/'state/maintenance/audio-capabilities'/name
    if action=='install' and (target/'installed.json').is_file():
        try:verify(root,kind,log);emit('complete','已安装且检查通过',kind=kind);return
        except Exception:raise RuntimeError('AUDIO_REPAIR_REQUIRED')
    if shutil.disk_usage(root).free<20*1024**3:raise RuntimeError('AUDIO_DISK_SPACE_LOW')
    staging.mkdir(parents=True)
    bundle=MANIFEST['bundles'][kind]
    emit('download','正在下载 Windows CPU 推理环境',kind=kind)
    archive=download(MANIFEST['baseUrl']+bundle['file'],root/'state/audio-install/downloads'/bundle['file'],bundle['sha256'],bundle['bytes'])
    emit('extract','正在解压并建立独立 Python 环境',kind=kind)
    extract(archive,staging)
    # Portable CPython is fixed; regenerate venv launchers for the final location.
    python=staging/'python/python.exe';venv=staging/'venv'
    run([python,'-m','venv','--without-pip',venv],log=log)
    site=venv/'Lib/site-packages';site.mkdir(parents=True,exist_ok=True)
    site.rmdir();(staging/'site-packages').replace(site)
    # Keep imports usable when Windows' global LongPathsEnabled is disabled.
    # The environments are isolated; no system registry change is necessary.
    (site/'wechatagent-long-paths.pth').write_text('import os,sys; sys.path[:]=[(chr(92)*2+"?"+chr(92)+os.path.abspath(p)) if os.name=="nt" and p and not p.startswith(chr(92)*2) else p for p in sys.path]\n',encoding='utf-8')
    python=venv/'Scripts/python.exe';git=staging/'git/cmd/git.exe';env=local_env(git,root)
    emit('sources','正在通过官方工具准备固定版本的推理源码',kind=kind)
    server=adapter(root,git,log)
    repo=staging/('source' if kind=='tts' else 'applio')
    clone(git,MANIFEST['sources'][kind],repo,log,recursive=kind=='tts')
    if kind=='rvc':
        overlay=server/'runtime_compat/Applio'
        for name,sha in json.loads((server/'runtime_compat/source_sha256.json').read_text('utf-8')).items():
            if digest(overlay/name)!=sha:raise RuntimeError('AUDIO_ADAPTER_HASH_MISMATCH')
        shutil.copytree(overlay,repo,dirs_exist_ok=True)
        for asset in json.loads((server/'runtime_compat/upstream_assets.json').read_text('utf-8')):
            existing=target/'applio'/asset['destination'];cached=root/'state/audio-install/official-assets'/asset['sha256']
            if existing.is_file() and digest(existing)==asset['sha256']:
                cached.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(existing,cached)
            download(asset['url'],cached,asset['sha256'])
            destination=repo/asset['destination'];destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(cached,destination)
    staged_profile=profile(server,kind,python,repo,env)
    final_python=target/'venv/Scripts/python.exe';final_repo=target/repo.name
    staged_profile.update(python=str(final_python),repo=str(final_repo));write_json(staging/'runtime.cpu.json',staged_profile)
    # venv's base path must point at the final portable Python, not staging.
    venv_config=venv/'pyvenv.cfg'
    venv_config.write_text(venv_config.read_text('utf-8').replace(str(staging/'python'),str(target/'python')),encoding='utf-8')
    changes=[(staging/name,target/name) for name in ['python','venv','git',repo.name,'runtime.cpu.json']]
    model_target=target/'models'/MANIFEST['models'][kind]['folder']
    if kind=='tts':
        wetext=staging/'wetext'
        emit('resources','正在准备并校验官方文本规范化资源',kind=kind)
        normalizer=target/'normalizer.json'
        try:existing=Path(json.loads(normalizer.read_text('utf-8'))['directory'])
        except (OSError,ValueError,KeyError,TypeError):existing=target/'wetext'
        cache=root/'state/audio-install/official-assets/wetext'
        for name,sha in MANIFEST['wetext'].items():
            url='https://www.modelscope.cn/models/pengzhendong/wetext/resolve/master/'+urllib.parse.quote(name)
            cached=cache/name;cached.parent.mkdir(parents=True,exist_ok=True)
            if existing and (existing/name).is_file() and digest(existing/name)==sha:shutil.copyfile(existing/name,cached)
            download(url,cached,sha)
            (wetext/name).parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(cached,wetext/name)
        write_json(wetext/'verified-files.json',MANIFEST['wetext'])
        changes.append((wetext,target/'wetext'))
        write_json(staging/'normalizer.json',{'directory':str(target/'wetext')});changes.append((staging/'normalizer.json',target/'normalizer.json'))
        config_file=target/'voice-service.json'
        try:
            saved=json.loads(config_file.read_text('utf-8-sig'))
            if not isinstance(saved,dict) or saved.get('schema')!='feiyu-voice-service-v1' or not isinstance(saved.get('tts'),dict):raise ValueError('invalid service config')
        except (OSError,ValueError):
            if config_file.exists():emit('repair','服务配置损坏，将保留备份并重建；本机服务数据不变')
            saved={'schema':'feiyu-voice-service-v1','data_dir':str(target/'service-data'),'max_queue':16,'max_upload_mb':128,'tts':{},'rvc':{},'singing':None}
        saved.setdefault('tts',{})['feiyu']={'engine':'cosyvoice3_release','package':str(model_target),'runtime_profile':str(target/'runtime.cpu.json')}
        write_json(staging/'voice-service.json',saved);changes.append((staging/'voice-service.json',config_file))
    else:
        demucs_model=MANIFEST['demucs'];file=staging/'demucs/955717e8-8726e21a.th'
        cached=root/'state/audio-install/official-assets/demucs.th'
        existing=target/'models/demucs/955717e8-8726e21a.th'
        if existing.is_file() and digest(existing)==demucs_model['sha256']:
            cached.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(existing,cached)
        download(demucs_model['url'],cached,demucs_model['sha256'],demucs_model['bytes'])
        file.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(cached,file)
        write_json(file.parent/'download.json',{'url':demucs_model['url'],'sha256':demucs_model['sha256'],'size':demucs_model['bytes']});changes.append((file.parent,target/'models/demucs'))
        (staging/'cover_demo.py').write_text('from pathlib import Path\nimport runpy\nrunpy.run_path(str(Path(__file__).resolve().parents[4]/"scripts/music-cover.py"),run_name="__main__")\n',encoding='utf-8')
        changes.append((staging/'cover_demo.py',target/'cover_demo.py'))
    model_target,model_stage=model(root,kind,server,python,env,staging,log)
    if model_stage:changes.append((model_stage,model_target))
    emit('activate','正在启用新环境并验证；失败时恢复原环境',kind=kind)
    activate(root,changes,lambda:verify(root,kind,log,smoke=True),log)
    write_json(target/'installed.json',{'schema':1,'version':MANIFEST['version'],'verifiedAt':time.time(),'kind':kind,'modelSource':'official','localAudioVerified':True})
    emit('complete','环境、模型与本地音频验证通过',kind=kind)


def main():
    global CURRENT_LOG
    p=argparse.ArgumentParser();p.add_argument('--root',required=True,type=Path);p.add_argument('--kind',required=True,choices=['all','tts','rvc']);p.add_argument('--action',required=True,choices=['install','repair','check']);a=p.parse_args()
    if sys.platform!='win32':raise RuntimeError('AUDIO_WINDOWS_REQUIRED')
    root=a.root.resolve();work=root/'state/audio-install';work.mkdir(parents=True,exist_ok=True)
    log=work/('install-'+uuid.uuid4().hex+'.log')
    CURRENT_LOG=log
    recover(root)
    for kind in ['tts','rvc'] if a.kind=='all' else [a.kind]:
        emit('check','正在检查 '+kind.upper()+' 环境',kind=kind)
        if a.action=='check':verify(root,kind,log);emit('complete','环境检查通过',kind=kind)
        else:install(root,kind,a.action,log)


if __name__=='__main__':
    try:main()
    except Exception as error:
        if CURRENT_LOG:
            with CURRENT_LOG.open('a',encoding='utf-8') as stream:traceback.print_exc(file=stream)
        code=str(error) if re.fullmatch(r'AUDIO_[A-Z_]{3,80}',str(error)) else 'AUDIO_INSTALL_FAILED'
        emit('failed','安装或验证未完成，原环境已保留；请查看本机安装日志',code=code)
        raise SystemExit(1)
