"""Runs user regex outside the API process with hard resource/time bounds."""
import json
import re
import resource
import sys
resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
from note_rendering import text_only
payload = json.load(sys.stdin)
pattern = re.compile(payload['pattern'], re.I)
print(json.dumps([cid for cid, texts in payload['items'] if any(pattern.search(text_only(text)) for text in texts)]))
