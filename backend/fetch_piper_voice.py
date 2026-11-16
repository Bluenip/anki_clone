"""Download the Piper voice used by the TTS fallback and verify it (run at image build time)."""
import hashlib
import os
import sys
import urllib.request

BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/'
FILES = {
    'en_US-lessac-medium.onnx': '5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f',
    'en_US-lessac-medium.onnx.json': 'efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0',
}


def main(target):
    os.makedirs(target, exist_ok=True)
    for name, digest in FILES.items():
        path = os.path.join(target, name)
        urllib.request.urlretrieve(BASE + name, path)
        with open(path, 'rb') as handle:
            actual = hashlib.sha256(handle.read()).hexdigest()
        if actual != digest:
            sys.exit(f'{name}: checksum mismatch ({actual})')
    print('Piper voice verified in', target)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '/opt/voices')
