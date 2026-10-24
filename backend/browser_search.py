"""Bounded Anki-style search subset, compiled to parameterized SQL predicates.

No writes/backfill. Searches linked note source fields (including hidden fields),
with front/back fallback for legacy cards. Unsupported operators fail explicitly.
"""
from dataclasses import dataclass
import operator
import re
from datetime import datetime, timezone
from sqlalchemy import and_, or_, not_, func, select, true
from models import Card, Deck, Note, NoteCard, NoteType, StudyProgress, SchedulerState, FilteredItem, FilteredSession, PackageCard


@dataclass
class Token:
    kind: str
    value: str = ''


def tokenize(source):
    if len(source) > 2048:
        raise ValueError('Search is too long (maximum 2048 characters)')
    tokens = []
    i = 0
    while i < len(source):
        if source[i].isspace():
            i += 1
            continue
        if source[i] in '()-':
            tokens.append(Token(source[i])); i += 1
        else:
            value = ''
            quoted = False
            in_quote = False
            while i < len(source):
                char = source[i]
                if char == '\\':
                    if i + 1 == len(source):
                        raise ValueError('Incomplete search escape')
                    value += source[i:i+2]; i += 2
                    continue
                if char == '"':
                    quoted = True; in_quote = not in_quote; i += 1
                    continue
                if not in_quote and (char.isspace() or char in '()'):
                    break
                value += char; i += 1
            if in_quote:
                raise ValueError('Unclosed search quote')
            if not value:
                raise ValueError('Empty search term')
            kind = value.upper() if not quoted and value.upper() in ('AND', 'OR') else 'term'
            tokens.append(Token(kind, value))
        if len(tokens) > 128:
            raise ValueError('Too many search terms (maximum 128 tokens)')
    return tokens


def pattern(value):
    """Translate Anki * / _ wildcards; literal SQL % and escapes stay literal."""
    out = ''
    i = 0
    while i < len(value):
        char = value[i]
        if char == '\\':
            i += 1
            char = value[i]
            out += '\\' + char if char in '%_\\' else char
        elif char == '*':
            out += '%'
        elif char in '%\\':
            out += '\\' + char
        else:
            out += char
        i += 1
    return out


def matches(column, value, contains=False):
    pat = pattern(value)
    if contains:
        pat = '%' + pat + '%'
    return column.ilike(pat, escape='\\')


def in_note(predicate):
    return Card.note_link.has(NoteCard.note.has(predicate))


def json_match(column, value, contains=False, children=False):
    items = func.json_each(column).table_valued('key', 'value')
    condition = matches(items.c.value, value, contains)
    if children:
        condition = or_(condition, matches(items.c.value, value + '::*'))
    return select(1).select_from(items).where(condition).correlate(Note).exists()


def term_predicate(value, now, due=None, fields=None):
    if ':' not in value:
        source = in_note(json_match(Note.fields_json, value, contains=True))
        legacy = and_(~Card.note_link.has(), or_(matches(Card.front,value,True),matches(Card.back,value,True)))
        return or_(source,legacy)
    key, argument = value.split(':', 1)
    key = key.lower()
    if key not in ('deck', 'tag', 'note', 'cid', 'nid', 'prop', 'is', 'flag') and fields is not None:
        predicate = fields(key, argument)
        if predicate is not None:
            return predicate
    if not argument:
        raise ValueError(f'Empty value for {key}:')
    if key == 'deck':
        if argument.lower() == 'filtered':
            return Card.filtered_item.has()
        home = or_(matches(Deck.name,argument), matches(Deck.name,argument+'::*'))
        filtered = Card.filtered_item.has(FilteredItem.session.has(
            or_(matches(FilteredSession.name,argument), matches(FilteredSession.name,argument+'::*'))))
        return or_(home, filtered)
    if key == 'tag':
        if argument.lower() == 'none':
            return ~in_note(func.json_array_length(Note.tags_json) > 0)
        return in_note(json_match(Note.tags_json, argument, children=True))
    if key == 'note':
        return in_note(Note.note_type.has(matches(NoteType.name,argument)))
    if key in ('cid','nid'):
        parts = argument.split(',')
        if not all(p.isascii() and p.isdigit() and 0 < int(p) <= 9223372036854775807 for p in parts):
            raise ValueError(f'{key}: expects positive integer IDs separated by commas')
        ids = [int(p) for p in parts]
        return Card.id.in_(ids) if key == 'cid' else Card.note_link.has(NoteCard.note_id.in_(ids))
    if key == 'flag':
        if argument not in tuple(str(i) for i in range(8)):
            raise ValueError('flag: expects a color number from 0 through 7')
        value = select(func.json_extract(PackageCard.payload, '$.flags')).where(PackageCard.card_id == Card.id).scalar_subquery()
        return func.coalesce(value, 0).op('&')(7) == int(argument)
    if key == 'prop':
        match = re.fullmatch(r'(ivl|reps|lapses)(<=|>=|!=|=|<|>)([0-9]+)', argument.lower())
        if not match:
            raise ValueError('Supported properties: prop:ivl, prop:reps, prop:lapses with a non-negative integer comparison')
        name, comparison, number = match.groups()
        number = int(number)
        if not 0 <= number < 2**63:
            raise ValueError('Property comparison is outside the supported integer range')
        column = {'ivl': StudyProgress.interval_days, 'reps': StudyProgress.repetitions,
                  'lapses': StudyProgress.lapse_count}[name]
        operation = {'<': operator.lt, '>': operator.gt, '<=': operator.le, '>=': operator.ge,
                     '=': operator.eq, '!=': operator.ne}[comparison]
        return operation(func.coalesce(column, 0), number)
    if key == 'is':
        if argument.lower() == 'due':
            if due is None:
                raise ValueError('Due search requires a collection clock')
            return due()
        state = func.coalesce(StudyProgress.card_state,'new')
        predicates = {
            'new': state == 'new',
            'learn': state.in_(['learning','relearning']),
            'review': state.in_(['review','relearning']),
            'suspended': func.coalesce(StudyProgress.is_suspended,False).is_(True),
            'buried': func.coalesce(SchedulerState.buried_until > now,False).is_(True),
        }
        if argument.lower() in predicates:
            return predicates[argument.lower()]
        raise ValueError(f'Unsupported state: is:{argument}')
    raise ValueError(f'Unsupported search operator: {key}:')


def compile_search(source, now=None, due=None, fields=None):
    tokens = tokenize(source)
    now = now or datetime.now(timezone.utc)
    index = 0

    def unary(depth):
        nonlocal index
        if depth > 16:
            raise ValueError('Search nesting is too deep (maximum 16)')
        if index >= len(tokens):
            raise ValueError('Missing search term')
        token = tokens[index]; index += 1
        if token.kind == '-':
            return not_(unary(depth + 1))
        if token.kind == '(':
            expression = disjunction(depth + 1)
            if index >= len(tokens) or tokens[index].kind != ')':
                raise ValueError('Unclosed search group')
            index += 1
            return expression
        if token.kind != 'term':
            raise ValueError('Expected a search term')
        return term_predicate(token.value, now, due, fields)

    def conjunction(depth):
        nonlocal index
        parts = [unary(depth)]
        while index < len(tokens) and tokens[index].kind not in (')','OR'):
            if tokens[index].kind == 'AND':
                index += 1
            parts.append(unary(depth))
        return and_(*parts)

    def disjunction(depth):
        nonlocal index
        parts = [conjunction(depth)]
        while index < len(tokens) and tokens[index].kind == 'OR':
            index += 1
            parts.append(conjunction(depth))
        return or_(*parts)

    if not tokens:
        return true()
    expression = disjunction(0)
    if index != len(tokens):
        raise ValueError('Unexpected closing parenthesis')
    return expression
