"""Validated rectangle, ellipse and polygon subset of Anki's image-occlusion cloze format.

The source stays portable; the web renderer draws masks without running template
scripts. Unsupported shapes/properties fail before a note is changed.
"""
import math
import re
from urllib.parse import quote
from html import escape, unescape


FIELDS = ['Occlusion', 'Image', 'Header', 'Back Extra', 'Comments']
QUESTION = '''{{#Header}}<div>{{Header}}</div>{{/Header}}
<div style="display:none">{{cloze:Occlusion}}</div>
<div id="image-occlusion-container">{{Image}}<canvas id="image-occlusion-canvas"></canvas></div>
<script>anki.imageOcclusion.setup();</script>'''
TEMPLATES = [{'name': 'Image Occlusion', 'qfmt': QUESTION,
              'afmt': QUESTION + '\n{{#Back Extra}}<div>{{Back Extra}}</div>{{/Back Extra}}'}]
CSS = '''#image-occlusion-container {position:relative;display:inline-block}
#image-occlusion-container img {max-width:100%;display:block}
#image-occlusion-canvas {position:absolute;left:0;top:0;--inactive-shape-color:#8893a5;--active-shape-color:#ffca64;--inactive-shape-border:1px #667085;--active-shape-border:2px #ed9720;--highlight-shape-color:transparent;--highlight-shape-border:2px #ed9720}
'''
PATTERN = re.compile(r'\{\{c(0|[1-9]\d*)::image-occlusion:(rect|ellipse|polygon|text):([^{}]+)\}\}')


def is_occlusion(templates):
    return any(isinstance(t, dict) and isinstance(t.get('qfmt'), str)
               and '{{cloze:Occlusion}}' in t['qfmt'] and 'image-occlusion' in t['qfmt'] for t in templates)


COLOR = re.compile(r'(?:#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|black|white|red|green|blue|yellow|orange|purple|gray|grey|transparent|rgba?\([0-9.,% ]+\))')


def properties(raw):
    parts, part, escaped = [], '', False
    for char in raw:
        if escaped:
            if char not in ('\\', ':'): raise ValueError('Invalid escaped mask property')
            part += char; escaped = False
        elif char == '\\': escaped = True
        elif char == ':': parts.append(part); part = ''
        else: part += char
    if escaped: raise ValueError('Incomplete escaped mask property')
    return parts + [part]


def masks(value):
    result = []
    if re.sub(r'<br\s*/?>|\s', '', PATTERN.sub('', value), flags=re.I):
        raise ValueError('Unsupported Image Occlusion data; source was not changed')
    for match in PATTERN.finditer(value):
        ordinal, kind = int(match[1]) - 1, match[2]
        required = {'left', 'top'} | ({'width', 'height'} if kind == 'rect' else {'rx', 'ry'} if kind == 'ellipse' else {'points'} if kind == 'polygon' else {'text', 'scale'})
        props = {}
        for pair in properties(match[3]):
            key, sep, raw = pair.partition('=')
            if not sep or key in props or key not in required | {'oi', 'angle', 'fill'} | ({'fs'} if kind == 'text' else set()):
                raise ValueError('Unsupported Image Occlusion mask property')
            props[key] = raw
        if set(props) - {'oi', 'angle', 'fill', 'fs'} != required or props.get('oi', '0') not in ('0', '1'):
            raise ValueError('Invalid Image Occlusion geometry')
        if props.get('fill') and not COLOR.fullmatch(props['fill']): raise ValueError('Invalid mask color')
        if ordinal < 0 and kind != 'text': raise ValueError('Only text annotations can use c0')
        try:
            angle = float(props.get('angle', '0'))
            if not math.isfinite(angle) or abs(angle) > 10000: raise ValueError()
            scale, font_size = float(props.get('scale', '1')), float(props.get('fs', '.05'))
            if not math.isfinite(scale) or not .01 <= scale <= 100 or not math.isfinite(font_size) or not .001 <= font_size <= 1: raise ValueError()
            if kind == 'text' and (not props['text'] or len(props['text']) > 2000): raise ValueError()
            coords = {k: float(props[k]) for k in ('left', 'top')}
            points = None
            if kind == 'polygon':
                points = [tuple(float(v) for v in p.split(',')) for p in props['points'].split()]
                if not 3 <= len(points) <= 100 or any(len(p) != 2 or any(not math.isfinite(v) or abs(v) > 10 for v in p) for p in points):
                    raise ValueError()
                if abs(sum(p[0] * points[(i + 1) % len(points)][1] - points[(i + 1) % len(points)][0] * p[1] for i, p in enumerate(points))) < 1e-10:
                    raise ValueError()
                coords.update(width=max(p[0] for p in points) - min(p[0] for p in points), height=max(p[1] for p in points) - min(p[1] for p in points))
            elif kind == 'text':
                coords.update(width=.001, height=.001)
            else:
                coords.update(width=float(props['rx']) * 2 if kind == 'ellipse' else float(props['width']), height=float(props['ry']) * 2 if kind == 'ellipse' else float(props['height']))
        except (ValueError, OverflowError):
            raise ValueError('Invalid Image Occlusion coordinates') from None
        if (any(not math.isfinite(v) or not 0 <= v <= 1 for v in coords.values())
                or coords['width'] <= 0 or coords['height'] <= 0
                or coords['left'] + coords['width'] > 1.000001
                or coords['top'] + coords['height'] > 1.000001 or ordinal > 999):
            raise ValueError('Image Occlusion masks must fit inside the image')
        result.append(dict(coords, ordinal=ordinal, hide_all=props.get('oi') == '1', shape=kind, points=points, angle=angle * .036, fill=props.get('fill'), text=props.get('text'), scale=scale, font_size=font_size))
    if not 1 <= len(result) <= 100:
        raise ValueError('Image Occlusion requires 1 to 100 regions')
    if not any(s['ordinal'] >= 0 for s in result): raise ValueError('Add at least one numbered mask')
    return result


def render(fields, user_id):
    from note_rendering import media_for_web
    shapes = masks(fields.get('Occlusion', ''))
    # One image only. Never interpret arbitrary Image-field HTML as the canvas.
    match = re.fullmatch(r'\s*<img\s+src=["\']([^"\']+)["\']\s*/?>\s*', fields.get('Image', ''), re.I)
    if not match:
        raise ValueError('Image Occlusion needs one image; upload an image in the editor')
    source = unescape(match[1])
    from urllib.parse import unquote
    filename = unquote(source.removeprefix(f'/api/media/{user_id}/'))
    if (not filename or filename.startswith('.') or re.search(r'[:/\\?#\x00-\x1f]', filename)
            or not filename.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp'))):
        raise ValueError('Image Occlusion needs a local image owned by this account')
    image = media_for_web('<img src="' + escape(source, quote=True) + '" style="display:block;width:100%;height:auto">', user_id)
    aspect = 1
    if any(s['shape'] == 'text' for s in shapes):
        from PIL import Image
        from media_utils import get_media_dir
        from pathlib import Path
        try:
            with Image.open(Path(get_media_dir(user_id)) / filename) as original: aspect = original.height / original.width
        except (OSError, ValueError): pass
    result = {}
    for ordinal in sorted({s['ordinal'] for s in shapes if s['ordinal'] >= 0}):
        faces = []
        for answer in (False, True):
            regions = []
            for shape in shapes:
                active = shape['ordinal'] == ordinal
                if shape['shape'] == 'text':
                    text_style = f'left:{shape["left"] * 100:.6f}%;top:{shape["top"] * 100:.6f}%;font-size:{shape["font_size"] * aspect * 100:.6f}cqw;transform-origin:0 0;transform:rotate({shape["angle"]:.6f}deg) scale({shape["scale"]:.6f})'
                    regions.append(f'<span data-io-text="{shape["ordinal"] + 1}" style="position:absolute;white-space:pre;line-height:1;font-family:Arial,sans-serif;color:{shape["fill"] or "black"};{text_style}">{escape(shape["text"])}</span>')
                    continue
                if not active and not shape['hide_all']:
                    continue
                background = 'transparent' if active and answer else (shape['fill'] or '#ffca64') if active else (shape['fill'] or '#8893a5')
                style = ';'.join(f'{key}:{shape[key] * 100:.6f}%' for key in ('left', 'top', 'width', 'height'))
                style += f';transform-origin:0 0;transform:rotate({shape["angle"]:.6f}deg)'
                border = '#ed9720' if active else '#667085'
                if shape['shape'] == 'polygon':
                    points = shape['points']
                    min_x, min_y = min(p[0] for p in points), min(p[1] for p in points)
                    vertices = ' '.join(f'{(x - min_x) / shape["width"] * 100:.6f},{(y - min_y) / shape["height"] * 100:.6f}' for x, y in points)
                    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="{vertices}" fill="{background}" stroke="{border}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>'
                    regions.append(f'<img data-io-mask="{shape["ordinal"] + 1}" alt="" src="data:image/svg+xml,{quote(svg, safe="")}" style="position:absolute;{style}">')
                else:
                    radius = ';border-radius:50%' if shape['shape'] == 'ellipse' else ''
                    regions.append(f'<span data-io-mask="{shape["ordinal"] + 1}" style="position:absolute;box-sizing:border-box;{style};background:{background};border:2px solid {border}{radius}"></span>')
            face = (fields.get('Header', '') + '<div class="web-image-occlusion" style="position:relative;overflow:hidden;container-type:inline-size;display:inline-block;width:100%;max-width:900px">'
                    + image + ''.join(regions) + '</div>')
            if answer:
                face += '<div>' + fields.get('Back Extra', '') + '</div>'
            faces.append(media_for_web(face, user_id))
        result[ordinal] = tuple(faces)
    return result
