import importlib.util
import pathlib
_spec=importlib.util.spec_from_file_location('read_media_text',pathlib.Path(__file__).with_name('read-media-text.py'))
_module=importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
read_document=_module.read_text
