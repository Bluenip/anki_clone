"""Package budgets shared by HTTP uploads, codecs and note validation."""
import os
import shutil


def positive(name, default):
    value = int(os.getenv('ANKI_IMPORT_' + name, str(default)))
    if value <= 0:
        raise ValueError('ANKI_IMPORT_' + name + ' must be positive')
    return value


MAX_UPLOAD_BYTES = positive('MAX_UPLOAD_BYTES', 1024**3)
MAX_UNCOMPRESSED_BYTES = positive('MAX_UNCOMPRESSED_BYTES', 3 * 1024**3)
MAX_MEDIA_BYTES = positive('MAX_MEDIA_BYTES', 2 * 1024**3)
MAX_SINGLE_MEDIA_BYTES = positive('MAX_SINGLE_MEDIA_BYTES', 256 * 1024**2)
MAX_CARDS = positive('MAX_CARDS', 100_000)
MAX_NOTES = positive('MAX_NOTES', 100_000)
MAX_MEDIA_FILES = positive('MAX_MEDIA_FILES', 100_000)
MAX_ZIP_ENTRIES = positive('MAX_ZIP_ENTRIES', MAX_MEDIA_FILES + 10)
MIN_FREE_BYTES = positive('MIN_FREE_BYTES', 256 * 1024**2)


def check_space(directory, required):
    free = shutil.disk_usage(directory).free
    if free < required + MIN_FREE_BYTES:
        raise ValueError(f'Insufficient disk space: need {required + MIN_FREE_BYTES} bytes, available {free} bytes')


def limits():
    return dict(max_upload_bytes=MAX_UPLOAD_BYTES, max_uncompressed_bytes=MAX_UNCOMPRESSED_BYTES,
                max_media_bytes=MAX_MEDIA_BYTES, max_single_media_bytes=MAX_SINGLE_MEDIA_BYTES,
                max_cards=MAX_CARDS, max_notes=MAX_NOTES, max_media_files=MAX_MEDIA_FILES)
