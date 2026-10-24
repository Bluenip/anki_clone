"""Loss-aware two-field CSV/TXT transfer. No scheduling data in text exports."""
import csv
from dataclasses import dataclass
import html
import io
import re


SEPARATORS = {"Tab": "\t", "Comma": ",", "Semicolon": ";", "Pipe": "|", "Colon": ":", "Space": " "}


@dataclass(frozen=True)
class TextRow:
    line: int
    front: str
    back: str
    guid: str | None = None


def parse_text(text, separator="\t", front_column=0, back_column=1,
               guid_column=None, has_header=False, allow_html=True):
    """Indexes are zero-based in the API; Anki directives are one-based."""
    text = text.removeprefix('\ufeff')
    stream = io.StringIO(text, newline='')
    columns = None
    # Directives only before the first data record, never inside quoted fields.
    while True:
        position = stream.tell()
        line = stream.readline()
        if not line.startswith('#'):
            stream.seek(position)
            break
        header = line.rstrip('\r\n')[1:]
        if ':' not in header:
            continue
        key, value = header.split(':', 1)
        key, value = key.strip().lower(), value.strip()
        if key == 'separator':
            separator = next((delimiter for name, delimiter in SEPARATORS.items() if name.lower() == value.lower()), value)
        elif key == 'html':
            if value.lower() not in ('true', 'false'):
                raise ValueError('Invalid #html directive')
            allow_html = value.lower() == 'true'
        elif key == 'guid column':
            try:
                guid_column = int(value) - 1
            except ValueError:
                raise ValueError('Invalid #guid column directive') from None
        elif key == 'columns':
            columns = value
        else:
            raise ValueError(f'Unsupported text directive #{key}; only Basic two-field notes are supported in this release')
    if len(separator) != 1 or separator in '\r\n\0"':
        raise ValueError('Separator must be one non-newline character')
    selected = [front_column, back_column] + ([guid_column] if guid_column is not None else [])
    if any(type(c) is not int or c < 0 or c > 99 for c in selected) or len(set(selected)) != len(selected):
        raise ValueError('Field columns must be distinct indexes between 0 and 99')
    if columns is not None:
        names = next(csv.reader([columns], delimiter=separator, strict=True))
        if len(names) != len(selected):
            raise ValueError('This release supports only Front, Back and optional GUID columns; other note fields must not be discarded')
    rows = []
    reader = csv.reader(stream, delimiter=separator, strict=True)
    try:
        if has_header:
            next(reader, None)
        for fields in reader:
            if not fields or all(not f for f in fields):
                continue
            if len(fields) != len(selected) or max(selected) >= len(fields):
                raise ValueError(f'Record ending at line {reader.line_num}: expected {len(selected)} columns, got {len(fields)}; no data imported')
            front, back = fields[front_column], fields[back_column]
            if not front.strip() or not back.strip():
                raise ValueError(f'Record ending at line {reader.line_num}: Front and Back must not be empty')
            if len(front) > 50000 or len(back) > 50000:
                raise ValueError(f'Record ending at line {reader.line_num}: field exceeds 50,000 characters')
            guid = fields[guid_column] if guid_column is not None else None
            if guid is not None and not re.fullmatch(r'[!-~]{1,100}', guid):
                raise ValueError(f'Record ending at line {reader.line_num}: invalid GUID')
            if not allow_html:
                front = html.escape(front).replace('\r\n', '\n').replace('\n', '<br>')
                back = html.escape(back).replace('\r\n', '\n').replace('\n', '<br>')
                if len(front) > 50000 or len(back) > 50000:
                    raise ValueError('HTML-escaped field exceeds 50,000 characters')
            rows.append(TextRow(reader.line_num, front, back, guid))
            if len(rows) > 10000:
                raise ValueError('At most 10,000 notes may be imported at once')
    except csv.Error as exc:
        raise ValueError(f'Invalid CSV near record line {reader.line_num}: {exc}') from None
    if not rows:
        raise ValueError('No notes found')
    return rows


def export_text(rows, separator='\t', include_guid=True):
    """HTML is preserved verbatim; caller applies access controls and identity."""
    output = io.StringIO(newline='')
    if separator not in SEPARATORS.values():
        raise ValueError('Unsupported export separator')
    name = next(key for key, value in SEPARATORS.items() if value == separator)
    output.write(f'#separator:{name}\n#html:true\n')
    if include_guid:
        output.write('#guid column:3\n')
    writer = csv.writer(output, delimiter=separator, lineterminator='\n')
    # The columns directive is a delimited record prefixed by #columns:.
    output.write('#columns:')
    writer.writerow(['Front', 'Back'] + (['GUID'] if include_guid else []))
    for front, back, guid in rows:
        row_writer = csv.writer(output, delimiter=separator, lineterminator='\n', quoting=csv.QUOTE_ALL) if front.startswith('#') else writer
        row_writer.writerow([front, back] + ([guid] if include_guid else []))
    return output.getvalue()
