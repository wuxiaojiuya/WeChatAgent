"""One verified CosyVoice model per isolated, serial speech worker."""
import json
import os

_entry = None


def cpu_threads(settings_file=None):
    value = os.environ.get('WECHATAGENT_TTS_CPU_THREADS')
    if value is None and settings_file is not None and settings_file.is_file():
        settings = json.loads(settings_file.read_text(encoding='utf-8'))
        selected = settings.get('cpuThreads')
        if settings.get('schema') != 'wechatagent-tts-performance-v1' or type(selected) is not int:
            raise ValueError('Invalid local TTS performance settings')
        value = str(selected)
    if value is None:
        value = '4'
    if value not in tuple(str(i) for i in range(1, 9)):
        raise ValueError('TTS CPU threads must be between 1 and 8')
    return min(int(value), os.cpu_count() or 1)


def clear():
    global _entry
    _entry = None


def cached_voice(identity, factory):
    global _entry
    key = json.dumps(identity, sort_keys=True, ensure_ascii=True)
    if _entry is not None and _entry[0] == key:
        return _entry[1], True, _entry[2]
    # Drop the previous checkpoint before allocating another complete model.
    clear()
    voice, sessions = factory()
    _entry = (key, voice, sessions)
    return voice, False, sessions
