"""Conservative static SVG subset: no CSS, scripts, animation or external URLs."""
import re
import xml.etree.ElementTree as ET

TAGS = set('svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath title desc linearGradient radialGradient stop clipPath mask pattern'.split())
ATTRS = set('id x y x1 y1 x2 y2 cx cy r rx ry d points width height viewBox preserveAspectRatio transform fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-dashoffset stroke-opacity opacity clip-path clip-rule mask offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod fx fy fr patternUnits patternContentUnits patternTransform font-family font-size font-weight font-style text-anchor dominant-baseline dx dy rotate lengthAdjust textLength'.split())


def sanitize_svg(data):
    # DTD/entity processing is unnecessary for graphics and never accepted.
    if re.search(br'<!\s*(?:DOCTYPE|ENTITY)', data, re.I) or b'\x00' in data:
        raise ValueError('SVG DTD/entities and non-UTF8 XML are unsupported')
    try:
        root = ET.fromstring(data)
    except ET.ParseError:
        raise ValueError('Invalid SVG XML') from None
    def local(value):
        return value.rsplit('}', 1)[-1]
    if local(root.tag) != 'svg':
        raise ValueError('SVG root element is missing')
    def clean(node, depth=0):
        if depth > 100:
            raise ValueError('SVG nesting exceeds limit')
        node.tag = '{http://www.w3.org/2000/svg}' + local(node.tag)
        for key, value in list(node.attrib.items()):
            name = local(key)
            internal_url = re.fullmatch(r'url\(\s*["\']?#[A-Za-z_][\w.:-]*["\']?\s*\)', value)
            if name == 'href' and re.fullmatch(r'#[A-Za-z_][\w.:-]*', value):
                continue
            if name not in ATTRS or ('url' in value.lower() and not internal_url) or re.search(r'(?:javascript:|data:|https?:|//|@import|expression\s*\()', value, re.I):
                del node.attrib[key]
        for child in list(node):
            if local(child.tag) not in TAGS:
                node.remove(child)
            else:
                clean(child, depth + 1)
    clean(root)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)
