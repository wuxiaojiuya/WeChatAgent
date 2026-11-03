"""Read a host-verified attachment in isolation; never executes document content."""
import json
import pathlib
import sys
import zipfile
import xml.etree.ElementTree as ET


def read_text(file):
    file = pathlib.Path(file)
    if file.is_symlink() or not file.is_file() or file.stat().st_size > 50*1024*1024:
        raise ValueError('FILE_INVALID')
    suffix = file.suffix.lower()
    truncated = False
    if suffix in ('.txt','.md','.csv','.json','.log','.srt','.vtt','.xml'):
        raw = file.read_bytes()[:65536]
        truncated = file.stat().st_size > len(raw)
        try:
            text = raw.decode('utf-8-sig')
        except UnicodeDecodeError:
            text = raw.decode('gb18030',errors='replace')
    elif suffix == '.pdf':
        from pypdf import PdfReader
        doc = PdfReader(file)
        text = ''
        truncated = len(doc.pages) > 20
        for index in range(min(20, len(doc.pages))):
            page = doc.pages[index]
            text += (page.extract_text() or '')+'\n'
            if len(text) > 6000:
                truncated = True
                break
    elif suffix == '.docx':
        with zipfile.ZipFile(file) as archive:
            entry = archive.getinfo('word/document.xml')
            if entry.file_size > 2*1024*1024:
                raise ValueError('FILE_DOCUMENT_LIMIT')
            data = archive.read(entry)
            if b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
                raise ValueError('FILE_DOCUMENT_INVALID')
            root = ET.fromstring(data)
            text = '\n'.join(''.join(p.itertext()) for p in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p'))
    else:
        raise ValueError('FILE_FORMAT_UNSUPPORTED')
    if not text.strip():
        text = '[未提取到可读文字；扫描版 PDF 可能需要 OCR，不能猜测内容]'
    return {'text':text[:6000], 'truncated':truncated or len(text)>6000}


if __name__ == '__main__':
    print(json.dumps(read_text(sys.argv[1]),ensure_ascii=False))
