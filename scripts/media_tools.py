"""Portable FFmpeg from the bundled reader runtime; bounded header inspection."""
import pathlib
import re
import shutil
import subprocess


def ffmpeg_path():
    try:
        import imageio_ffmpeg
        candidate = imageio_ffmpeg.get_ffmpeg_exe()
        if pathlib.Path(candidate).is_file():
            return candidate
    except (ImportError, RuntimeError):
        pass
    tool = shutil.which('ffmpeg')
    if not tool:
        raise RuntimeError('VIDEO_FFMPEG_MISSING')
    return tool


def probe_media(file, timeout=12):
    result = subprocess.run([ffmpeg_path(), '-hide_banner', '-nostdin',
        '-protocol_whitelist', 'file,pipe', '-probesize', '5000000',
        '-analyzeduration', '5000000', '-i', str(file)], stdin=subprocess.DEVNULL,
        capture_output=True, timeout=timeout,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    header = result.stderr[:1048576].decode('utf-8', errors='replace')
    duration = re.search(r'Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)', header)
    streams = [{'codec_type': kind.lower()} for kind in re.findall(r'Stream #[^\r\n]*?: (Audio|Video):', header)]
    if not duration or not streams:
        raise RuntimeError('VIDEO_DECODE_FAILED')
    hours, minutes, seconds = map(float, duration.groups())
    return {'format': {'duration': hours*3600+minutes*60+seconds}, 'streams': streams}
