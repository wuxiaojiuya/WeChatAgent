"""Run direct reference-conditioned TTS using the installed isolated runtime."""
import argparse
import json
import os
from pathlib import Path
import sys
from feiyu_emotion_overlay import prepare_overlay

parser=argparse.ArgumentParser()
parser.add_argument('--request',required=True,type=Path)
parser.add_argument('--root',required=True,type=Path)
args=parser.parse_args()
root=args.root.resolve(strict=True)
runtime=root/'state/maintenance/audio-capabilities'
server=runtime/'feiyu-cover/source/astrbot_plugin_feiyu_voice-76774b499f7d306454562d56348dd63399b6d7e8/server'
overlay=prepare_overlay(server,args.request.parent/'adapter')
sys.path[:0]=[str(overlay),str(server)]
os.environ['WECHATAGENT_VOICE_PROFILES']=str(root/'state/voice-profiles')
os.environ['WECHATAGENT_FEIYU_WETEXT']=json.loads((runtime/'feiyu-tts/normalizer.json').read_text(encoding='utf-8'))['directory']
os.environ['PATH']=os.pathsep.join([str(runtime/'feiyu-tts/git/cmd'),os.environ.get('PATH','')])
from feiyu_runtime.tts import main
profile=json.loads((runtime/'feiyu-tts/runtime.cpu.json').read_text(encoding='utf-8'))
main(runtime/'feiyu-tts/models/FeiyuVoice-CosyVoice3',profile,['--request',str(args.request)])
