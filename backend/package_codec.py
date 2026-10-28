"""Modern APKG normalization using Anki 26.9.3's own schema adapter.

Archive paths/ZIP limits are checked by the caller before this function runs.
Nested zstd payloads have a second, shared decompressed-byte budget.
"""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import zstandard
from import_config import MAX_MEDIA_FILES


def _sha1(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha1').digest()


def prepare_collection(directory, max_bytes, max_media=MAX_MEDIA_FILES, progress=None):
    root=Path(directory)
    modern=root/'collection.anki21b'
    if not modern.exists():
        for name in ('collection.anki21','collection.anki2'):
            if (root/name).exists():return str(root/name),None
        raise ValueError('Invalid APKG archive: collection database not found')
    from anki.import_export_pb2 import PackageMetadata, MediaEntries
    meta=root/'meta'
    if not meta.is_file() or meta.stat().st_size>1024:
        raise ValueError('Modern package metadata is missing or invalid')
    metadata=PackageMetadata.FromString(meta.read_bytes())
    if metadata.version!=PackageMetadata.VERSION_LATEST:
        raise ValueError('Unsupported modern Anki package version')
    remaining=max_bytes
    def decode(source,destination):
        nonlocal remaining
        size=0
        try:
            with source.open('rb') as compressed, zstandard.ZstdDecompressor().stream_reader(compressed) as reader, destination.open('wb') as output:
                while chunk:=reader.read(min(65536,remaining+1)):
                    if progress: progress('decompressing', max_bytes - remaining, max_bytes)
                    from import_config import check_space
                    check_space(root, len(chunk))
                    remaining-=len(chunk);size+=len(chunk)
                    if remaining<0:raise ValueError('Nested compressed package exceeds decompressed size limit')
                    output.write(chunk)
        except zstandard.ZstdError:
            raise ValueError('Invalid compressed Anki package data') from None
        return size
    database=root/'normalized.anki2'
    decode(modern,database)
    binary_manifest=root/'media'
    protobuf_manifest=root/'media.pb'
    if not binary_manifest.is_file():raise ValueError('Modern package media manifest is missing')
    decode(binary_manifest,protobuf_manifest)
    entries=MediaEntries.FromString(protobuf_manifest.read_bytes()).entries
    if len(entries)>max_media:raise ValueError('Media count exceeds limit')
    mapping={}
    for index,entry in enumerate(entries):
        filename=entry.name
        if not filename or Path(filename).name!=filename or '\\' in filename or filename.startswith('.'):
            raise ValueError('Unsafe media filename in modern package')
        key=str(index)
        if key in mapping:raise ValueError('Duplicate media member')
        source=root/key
        if not source.is_file():raise ValueError('Modern package media member is missing')
        decoded=root/(key+'.decoded')
        size=decode(source,decoded)
        if size!=entry.size:raise ValueError('Modern package media size does not match manifest')
        if entry.sha1 and _sha1(decoded)!=entry.sha1:
            raise ValueError('Modern package media hash does not match manifest')
        os.replace(decoded,source)
        mapping[key]=filename
    binary_manifest.write_text(json.dumps(mapping),encoding='utf-8')
    # Native model/deck protobufs are decoded by the pinned upstream backend,
    # not guessed from raw SQLite columns. Only this temporary DB is opened.
    from anki.collection import Collection
    collection=Collection(str(database))
    try:
        metadata={'crt':collection.crt,'models':json.dumps({str(m['id']):m for m in collection.models.all()}),
                  'decks':json.dumps({str(d['id']):d for d in collection.decks.all()}),
                  'dconf':json.dumps({str(c['id']):c for c in collection.decks.all_config()}),
                  '_today':collection.sched.today, '_fsrs':collection.get_config('fsrs',False)}
    finally:
        collection.close()
    return str(database),metadata


def modernize_package(legacy_path, output_path, include_scheduling=True, collection_package=False):
    """Convert our validated legacy writer through upstream Anki's exporter."""
    import tempfile
    from anki.collection import Collection
    from anki.import_export_pb2 import ImportAnkiPackageRequest, ImportAnkiPackageOptions, ExportAnkiPackageOptions, ExportLimit
    with tempfile.TemporaryDirectory(prefix='anki_codec_') as directory:
        collection=Collection(str(Path(directory)/'collection.anki2'))
        try:
            collection.import_anki_package(ImportAnkiPackageRequest(package_path=str(legacy_path),
                options=ImportAnkiPackageOptions(with_scheduling=include_scheduling, with_deck_configs=True)))
            if include_scheduling:
                # Upstream intentionally strips FSRS data in legacy APKGs.
                # Restore it in this temporary collection through its public
                # Card API before writing the modern format.
                import zipfile
                from anki.cards_pb2 import FsrsMemoryState
                source_path = Path(directory)/'source.sqlite'
                with zipfile.ZipFile(legacy_path) as archive:
                    source_path.write_bytes(archive.read('collection.anki2'))
                source = sqlite3.connect(source_path)
                try:
                    conf = json.loads(source.execute('SELECT conf FROM col LIMIT 1').fetchone()[0])
                    collection.set_config('fsrs',bool(conf.get('fsrs',False)))
                    if collection_package:
                        model_json, deck_json, config_json = source.execute('SELECT models,decks,dconf FROM col LIMIT 1').fetchone()
                        for model in json.loads(model_json).values():
                            if collection.models.by_name(model['name']) is None:
                                collection.models.add_dict(model)
                        configs = json.loads(config_json)
                        for definition in json.loads(deck_json).values():
                            if collection.decks.by_name(definition['name']) is not None:continue
                            did = collection.decks.id(definition['name'])
                            deck = collection.decks.get(did)
                            deck['desc'] = definition.get('desc','')
                            deck['newLimit'] = definition.get('newLimit')
                            deck['reviewLimit'] = definition.get('reviewLimit')
                            config = configs.get(str(definition.get('conf')))
                            if config:
                                collection.decks.update_config(config)
                                deck['conf'] = config['id']
                            collection.decks.save(deck)
                    for guid, ordinal, payload in source.execute('SELECT notes.guid,cards.ord,cards.data FROM cards JOIN notes ON notes.id=cards.nid'):
                        data=json.loads(payload or '{}')
                        if data.get('s') is None or data.get('d') is None:continue
                        cid=collection.db.scalar('SELECT cards.id FROM cards JOIN notes ON notes.id=cards.nid WHERE notes.guid=? AND cards.ord=?',guid,ordinal)
                        if cid is None:raise ValueError('FSRS card identity was lost during conversion')
                        card=collection.get_card(cid)
                        card.memory_state=FsrsMemoryState(stability=data['s'],difficulty=data['d'])
                        card.desired_retention=data.get('dr',.9)
                        card.last_review_time=data.get('lrt')
                        collection.update_card(card)
                finally:
                    source.close()
            if collection_package:
                collection.export_collection_package(str(output_path), include_media=True, legacy=False)
            else:
                collection.export_anki_package(out_path=str(output_path),
                    options=ExportAnkiPackageOptions(with_scheduling=include_scheduling,with_deck_configs=True,with_media=True,legacy=False),
                    limit=ExportLimit(whole_collection={}))
        finally:
            collection.close()
