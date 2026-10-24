"""Small, explicit Anki template subset; source fields are never overwritten.

No scripts are executed. Unsupported filters fail rather than flattening notes.
Nested clozes are intentionally rejected until their semantics are implemented.
"""
from html import escape, unescape
from html.parser import HTMLParser
import re


class _Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def text_only(value):
    parser = _Text()
    parser.feed(value)
    return unescape(''.join(parser.parts)).strip()


def meaningful(value):
    return bool(text_only(value) or re.search(r'<(?:img|audio|video)\b|\[sound:', value, re.I))


CLOZE = re.compile(r'\{\{c([1-9]\d*)::(.*?)\}\}', re.S)


def cloze_indexes(value):
    matches = list(CLOZE.finditer(value))
    if any('{{' in match[2] for match in matches):
        raise ValueError('Nested clozes are not supported yet; the note was not changed')
    if '{{c' in CLOZE.sub('', value):
        raise ValueError('Malformed or unsupported cloze syntax')
    indexes = sorted({int(match[1]) - 1 for match in matches})
    if len(indexes) > 100 or any(index > 999 for index in indexes):
        raise ValueError('At most 100 cloze cards with indexes c1 through c1000 are supported')
    return indexes


def render_cloze(value, ordinal, answer):
    cloze_indexes(value)
    def replace(match):
        body, _, hint = match[2].partition('::')
        if int(match[1]) - 1 != ordinal:
            return body
        if answer:
            return f'<span class="cloze">{body}</span>'
        return '<span class="cloze">[' + (escape(hint) if hint else '...') + ']</span>'
    return CLOZE.sub(replace, value)


TOKEN = re.compile(r'\{\{(.*?)\}\}', re.S)


def render_template(template, fields, ordinal=0, answer=False, front='', context=None):
    """Conditional sections use a stack, not a backtracking HTML expression."""
    if len(template) > 200000:
        raise ValueError('Template is too large')
    context = context or {}
    output, stack, position = [], [], 0
    active = True
    for match in TOKEN.finditer(template):
        if active:
            output.append(template[position:match.start()])
        token = match[1].strip()
        position = match.end()
        if token.startswith(('#', '^')):
            name = token[1:]
            if name not in fields:
                raise ValueError(f'Unknown conditional field: {name}')
            condition = meaningful(fields[name])
            stack.append((name, active))
            active = active and (condition if token[0] == '#' else not condition)
        elif token.startswith('/'):
            if not stack or stack[-1][0] != token[1:]:
                raise ValueError('Unbalanced template conditional')
            _, active = stack.pop()
        elif active:
            if token == 'FrontSide':
                output.append(front)
                continue
            parts = token.split(':')
            name, filters = parts[-1], parts[:-1]
            if name in fields:
                value = fields[name]
            elif name in context:
                value = escape(str(context[name]))
            else:
                raise ValueError(f'Unsupported template field: {name}')
            if 'type' in filters:
                if filters[0] != 'type' or any(f not in ('type', 'cloze', 'nc', 'ci') for f in filters) or len(set(filters)) != len(filters):
                    raise ValueError('Unsupported type answer filter combination')
                expected = value
                if 'cloze' in filters:
                    cloze_indexes(value)
                    expected = ', '.join(dict.fromkeys(m[2].partition('::')[0] for m in CLOZE.finditer(value) if int(m[1]) - 1 == ordinal))
                expected = text_only(expected)
                output.append('<span data-type-field="' + escape(name, quote=True) + '"' +
                              (' data-type-answer="' + escape(expected, quote=True) + '" data-type-options="' + ','.join(filters) + '"') + '></span>')
                continue
            for filter_name in reversed(filters):
                if filter_name == 'cloze':
                    value = render_cloze(value, ordinal, answer)
                elif filter_name == 'text':
                    value = escape(text_only(value))
                elif filter_name in ('furigana', 'kana', 'kanji'):
                    def ruby(match):
                        base, reading = match[1], match[2]
                        if filter_name == 'kana':
                            return reading
                        if filter_name == 'kanji':
                            return base
                        return f'<ruby>{base}<rt>{reading}</rt></ruby>'
                    # Process text segments only, preserving HTML attributes.
                    value = ''.join(part if part.startswith('<') else re.sub(r'([^\s\[\]<>]+)\[([^\[\]<>]+)\]', ruby, part)
                                    for part in re.split(r'(<[^>]*>)', value))
                elif filter_name == 'hint':
                    value = f'<details><summary>{escape(name)}</summary>{value}</details>' if meaningful(value) else ''
                else:
                    raise ValueError(f'Unsupported template filter: {filter_name}')
            output.append(value)
    if stack:
        raise ValueError('Unclosed template conditional')
    if active:
        output.append(template[position:])
    return ''.join(output)


def media_for_web(value, user_id):
    from urllib.parse import quote
    def sound(match):
        filename = match[1]
        if '/' in filename or '\\' in filename or filename in ('.', '..'):
            raise ValueError('Invalid media filename')
        return f'<audio src="/api/media/{user_id}/{quote(filename, safe="")}" controls></audio>'
    value = re.sub(r'\[sound:([^\]]+)\]', sound, value)
    def source(match):
        prefix, filename, quote_char = match[1], match[2], match[3]
        filename = unescape(filename)
        if re.match(r'^(?:[a-z][a-z0-9+.-]*:|/|#)', filename, re.I):
            return match[0]
        if '/' in filename or '\\' in filename or filename in ('.', '..'):
            raise ValueError('Unsupported relative media path')
        return prefix + f'/api/media/{user_id}/{quote(filename, safe="")}' + quote_char
    return re.sub(r'((?:src|href)=["\'])([^"\']+)(["\'])', source, value, flags=re.I)


def css_for_web(value, user_id):
    """Resolve portable CSS assets without changing the stored note type."""
    from urllib.parse import quote
    def source(match):
        filename = match[1].strip().strip('"\'')
        if re.match(r'^(?:[a-z][a-z0-9+.-]*:|/|#)', filename, re.I):
            return match[0]
        if not filename or '/' in filename or '\\' in filename or filename in ('.', '..'):
            raise ValueError('Unsupported relative CSS media path')
        return 'url("/api/media/' + str(user_id) + '/' + quote(filename, safe='') + '")'
    return re.sub(r'url\(\s*([^)]*?)\s*\)', source, value or '', flags=re.I)


def render_cards(model, field_values, user_id, tags=(), deck_name=''):
    import json
    names = json.loads(model.fields_json)
    templates = json.loads(model.templates_json)
    if len(names) != len(field_values) or len(set(names)) != len(names):
        raise ValueError('Note fields do not match the note type')
    fields = dict(zip(names, field_values))
    is_cloze = any('{{cloze:' in t['qfmt'] for t in templates)
    ordinals = sorted({i for name, value in fields.items() for i in cloze_indexes(value)}) if is_cloze else list(range(len(templates)))
    if is_cloze and (not ordinals or len(templates) != 1):
        raise ValueError('Cloze notes need at least one {{c1::text}} deletion and one template')
    result = {}
    for ordinal in ordinals:
        template = templates[0 if is_cloze else ordinal]
        context = {'Tags': ' '.join(tags), 'Deck': deck_name, 'Subdeck': deck_name.split('::')[-1],
                   'Type': model.name, 'Card': template.get('name', '')}
        front = render_template(template['qfmt'], fields, ordinal=ordinal, context=context)
        if not meaningful(front) and 'data-type-field=' not in front:
            continue
        back = render_template(template['afmt'], fields, ordinal=ordinal, answer=True, front=front, context=context)
        result[ordinal] = (media_for_web(front, user_id), media_for_web(back, user_id))
    if not result:
        raise ValueError('This note would create no cards')
    return result
