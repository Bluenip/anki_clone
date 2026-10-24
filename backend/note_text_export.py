"""Export one source record per note, rather than one per rendered card."""
import csv
import io
import json
from notes import legacy_guid


def export_notes_text(cards, user_id, separator, include_guid):
    records, seen = [], set()
    for card in cards:
        if card.note_link:
            note = card.note_link.note
            if note.id in seen:
                continue
            seen.add(note.id)
            model = note.note_type
            fields = json.loads(model.fields_json)
            values = json.loads(note.fields_json)
            if len(values) != len(fields):
                raise ValueError('Note field count does not match its note type')
            records.append((model.name, fields, values, json.loads(note.tags_json), note.guid, card.deck.name))
        else:
            records.append(('Basic', ['Front', 'Back'], [card.front, card.back], [], legacy_guid(card, user_id), card.deck.name))
    if not records:
        raise ValueError('No notes to export')
    if any(any(char in name for char in '\r\n') for name, *_ in records):
        raise ValueError('Note type names with newlines require APKG export')
    output = io.StringIO(newline='')
    output.write(f"#separator:{'Comma' if separator == ',' else 'Tab'}\n#html:true\n")
    writer = csv.writer(output, delimiter=separator, lineterminator='\n', quoting=csv.QUOTE_ALL)
    mixed = len({(record[0], tuple(record[1]), record[5]) for record in records}) != 1
    if mixed:
        size = max(len(record[2]) for record in records)
        offset = int(include_guid)
        if include_guid:
            output.write('#guid column:1\n')
        output.write(f'#notetype column:{offset + 1}\n#deck column:{offset + 2}\n#tags column:{offset + 3 + size}\n')
        output.write('#columns:')
        writer.writerow((['GUID'] if include_guid else []) + ['Note Type', 'Deck'] + [f'Field {i+1}' for i in range(size)] + ['Tags'])
        for name, fields, values, tags, guid, deck in records:
            writer.writerow(([guid] if include_guid else []) + [name, deck] + values + [''] * (size - len(values)) + [' '.join(tags)])
    else:
        name, fields, *_ = records[0]
        size = len(fields)
        output.write(f'#notetype:{name}\n#tags column:{size + 1}\n')
        if include_guid:
            output.write(f'#guid column:{size + 2}\n')
        output.write('#columns:')
        # Anki's stock Cloze calls its second field Back Extra.
        labels = ['Text', 'Back Extra'] if name == 'Cloze' and fields == ['Text', 'Extra'] else fields
        writer.writerow(labels + ['Tags'] + (['GUID'] if include_guid else []))
        for _, _, values, tags, guid, _ in records:
            writer.writerow(values + [' '.join(tags)] + ([guid] if include_guid else []))
    return output.getvalue()
