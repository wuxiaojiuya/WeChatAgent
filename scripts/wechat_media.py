"""Pure message identity and MIME helpers; no client media discovery.

MIME detection retained from weflow-cli 3d56da9 (MIT).
Original license: docs/licenses/weflow-cli-MIT.txt.
"""

def clean_account_wxid(value):
    """Preserve the exact wxid returned by the Hook, without folder suffix rules."""
    return str(value or '').strip()

def detect_mime_from_bytes(header_bytes):
    """Detect MIME type from byte header."""
    if header_bytes[:2] == b'\xff\xd8':
        return 'image/jpeg'
    if header_bytes[:4] == b'\x89PNG':
        return 'image/png'
    if header_bytes[:3] == b'GIF':
        return 'image/gif'
    if header_bytes[:4] == b'RIFF' and len(header_bytes) >= 12 and header_bytes[8:12] == b'WEBP':
        return 'image/webp'
    return None
