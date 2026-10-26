"""Rewrite media references, not prose, when importing filename collisions."""
import html
import re
from urllib.parse import unquote


def rewrite(value, mapping):
    def name(raw):
        decoded = unquote(html.unescape(raw))
        return mapping.get(decoded)
    value = re.sub(r'\[sound:([^\]]+)\]', lambda m: '[sound:' + (name(m[1]) or m[1]) + ']', value)
    def attr(m):
        replacement = name(m[3])
        return m[1] + m[2] + html.escape(replacement, quote=True) + m[2] if replacement else m[0]
    value = re.sub(r'((?:src|href)\s*=\s*)(["\'])(.*?)\2', attr, value, flags=re.I)
    def css(m):
        replacement = name(m[1].strip().strip('"\''))
        return 'url("' + replacement + '")' if replacement else m[0]
    return re.sub(r'url\(([^)]+)\)', css, value, flags=re.I)


def package(cursor, collection, mapping):
    import json
    result = dict(collection)
    models = json.loads(result['models'])
    for model in models.values():
        model['css'] = rewrite(model.get('css', ''), mapping)
        for template in model.get('tmpls', []):
            for side in ('qfmt', 'afmt'): template[side] = rewrite(template.get(side, ''), mapping)
    result['models'] = json.dumps(models)
    for nid, fields in cursor.execute('SELECT id, flds FROM notes').fetchall():
        cursor.execute('UPDATE notes SET flds=? WHERE id=?', (rewrite(fields, mapping), nid))
    return result
