"""Start the installed, isolated Feiyu API with project-local CPU dependencies."""
import os
import json
from pathlib import Path
import runpy
import sys

root = Path(__file__).resolve().parent.parent
runtime = root/'state/maintenance/audio-capabilities'
server = runtime/'feiyu-cover/source/astrbot_plugin_feiyu_voice-76774b499f7d306454562d56348dd63399b6d7e8/server'
config = runtime/'feiyu-tts/voice-service.json'
if not config.is_file() or not (server/'feiyu_voice_service/__main__.py').is_file():
    raise RuntimeError('FEIYU_LOCAL_RUNTIME_MISSING')
from feiyu_emotion_overlay import prepare_overlay
overlay = prepare_overlay(server, root/'state/media-runtime/feiyu-overlay')
sys.path[:0] = [str(overlay), str(server)]
os.environ['PYTHONPATH'] = os.pathsep.join([str(root/'scripts/feiyu-site'), str(overlay), str(server)])
normalizer = runtime/'feiyu-tts/normalizer.json'
if normalizer.is_file():
    os.environ['WECHATAGENT_FEIYU_WETEXT'] = json.loads(normalizer.read_text())['directory']
os.environ['PYTHONIOENCODING'] = 'utf-8'
os.environ['PATH'] = os.pathsep.join([str(runtime/'feiyu-cover/tools/mingit/cmd'), 'C:/ffmpeg-tools/bin', os.environ.get('PATH', '')])
sys.argv = ['feiyu_voice_service', '--config', str(config), '--host', '127.0.0.1', '--port', '9880']
runpy.run_module('feiyu_voice_service', run_name='__main__')
