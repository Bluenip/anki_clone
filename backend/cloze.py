"""Bounded recursive cloze parser shared by display and typed answers."""
from dataclasses import dataclass
from html import escape
import re


@dataclass
class Deletion:
    ordinal: int
    body: list
    hint: list


def parse(value):
    position = 0
    indexes = set()
    count = 0

    def sequence(depth, nested=False):
        nonlocal position, count
        if depth > 20:
            raise ValueError('Cloze nesting exceeds 20 levels')
        body, hint = [], []
        current = body
        while position < len(value):
            if value.startswith('{{c', position):
                match = re.match(r'\{\{c([1-9]\d{0,3})::', value[position:])
                if not match or int(match[1]) > 1000:
                    raise ValueError('Malformed cloze index (use c1 through c1000)')
                ordinal = int(match[1]) - 1
                indexes.add(ordinal); count += 1
                if len(indexes) > 100 or count > 1000:
                    raise ValueError('At most 100 cloze cards and 1000 deletions are supported')
                position += match.end()
                child, child_hint = sequence(depth + 1, True)
                current.append(Deletion(ordinal, child, child_hint))
            elif nested and value.startswith('}}', position):
                position += 2
                return body, hint
            elif nested and current is body and value.startswith('::', position):
                position += 2; current = hint
            else:
                start = position
                position += 1
                while position < len(value) and not value.startswith('{{c', position) and not (nested and (value.startswith('}}', position) or current is body and value.startswith('::', position))):
                    position += 1
                current.append(value[start:position])
        if nested:
            raise ValueError('Unclosed cloze deletion')
        return body, hint

    nodes, _ = sequence(0)
    return nodes, sorted(indexes)


def plain(nodes):
    return ''.join(n if isinstance(n, str) else plain(n.body) for n in nodes)


def render(value, ordinal, answer):
    nodes, _ = parse(value)
    def walk(items):
        result = []
        for node in items:
            if isinstance(node, str): result.append(node); continue
            if node.ordinal == ordinal:
                content = walk(node.body) if answer else '[' + (escape(plain(node.hint)) if node.hint else '...') + ']'
                result.append('<span class="cloze">' + content + '</span>')
            else:
                result.append(walk(node.body))
        return ''.join(result)
    return walk(nodes)


def typed(value, ordinal):
    nodes, _ = parse(value)
    results = []
    def walk(items):
        for node in items:
            if isinstance(node, str): continue
            if node.ordinal == ordinal:
                results.append(plain(node.body))
            else:
                walk(node.body)
    walk(nodes)
    return ', '.join(dict.fromkeys(results))
