"""Separate process bounds native optimizer time and releases training memory."""
import json
import sys
from anki._backend import RustBackend
from anki.scheduler_pb2 import FsrsItem, FsrsReview

if __name__ == '__main__':
    histories = json.load(sys.stdin)
    result = RustBackend().compute_fsrs_params_from_items(
        [FsrsItem(reviews=[FsrsReview(**review) for review in history]) for history in histories])
    print(json.dumps({'parameters': list(result.params)}))
