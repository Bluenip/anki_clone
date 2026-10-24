from pathlib import Path
from media_utils import get_media_dir


def test_media_upload_content_address_and_check(client, auth_headers_a, auth_headers_b, user_a):
    data = b'\x89PNG\r\n\x1a\n' + b'fixture'
    first = client.post('/api/media-tools/upload', headers=auth_headers_a, files={'file': ('../x.png', data, 'image/png')})
    assert first.status_code == 201, first.text
    result = first.json()
    assert '/' not in result['filename']
    assert Path(get_media_dir(user_a.id), result['filename']).read_bytes() == data
    second = client.post('/api/media-tools/upload', headers=auth_headers_a, files={'file': ('other.png', data, 'image/png')})
    assert second.json() == result
    status = client.get('/api/media-tools/check', headers=auth_headers_a).json()
    assert result['filename'] in status['unused']
    assert result['filename'] not in client.get('/api/media-tools/check', headers=auth_headers_b).json()['unused']
    bad = client.post('/api/media-tools/upload', headers=auth_headers_a, files={'file': ('bad.png', b'<script>bad</script>', 'image/png')})
    assert bad.status_code == 415
