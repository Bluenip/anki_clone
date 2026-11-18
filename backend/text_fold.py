"""Case- and Unicode-insensitive text matching for SQLite.

SQLite's LIKE ignores case only for ASCII letters, so "ăn" never matched "Ăn", and text typed with
combining accents never matched the same text stored precomposed. Every SQLite connection gets a
``unifold(text)`` function (NFC + casefold); searches compare ``unifold(column)`` with a folded pattern.
"""
import unicodedata

from sqlalchemy import event, func
from sqlalchemy.engine import Engine


def fold(value):
    return unicodedata.normalize('NFC', value).casefold() if isinstance(value, str) else value


@event.listens_for(Engine, 'connect')
def _register(dbapi_connection, _record):
    create = getattr(dbapi_connection, 'create_function', None)
    if create is not None:  # SQLite only
        create('unifold', 1, fold, deterministic=True)


def folded_like(column, pattern, escape=None):
    """``column LIKE pattern`` ignoring case (any script) and Unicode composition."""
    return func.unifold(column).like(fold(pattern), escape=escape)
