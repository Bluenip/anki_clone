"""Translate portable Anki TTS filters into inert browser speech descriptors."""
from html import escape
import re
import shlex


def descriptor(spec, value):
    from note_rendering import text_only
    tokens = shlex.split(spec)
    if len(tokens) < 2 or tokens[0] != 'tts' or not re.fullmatch(r'[A-Za-z]{2,8}(?:[_-][A-Za-z0-9]{2,8})*', tokens[1]):
        raise ValueError('TTS requires a language, for example tts en_US')
    options = {}
    for token in tokens[2:]:
        key, sep, val = token.partition('=')
        if not sep or key not in ('voices', 'speed') or key in options:
            raise ValueError('Supported TTS options: voices and speed')
        options[key] = val
    try: speed = float(options.get('speed', 1))
    except ValueError: raise ValueError('Invalid TTS speed') from None
    if not .1 <= speed <= 10:
        raise ValueError('TTS speed must be between 0.1 and 10')
    return ('<span data-tts="' + escape(text_only(value), quote=True) + '" data-tts-lang="' + tokens[1].replace('_', '-')
            + '" data-tts-rate="' + str(speed) + '" data-tts-voices="' + escape(options.get('voices', ''), quote=True) + '"></span>')


def blocks(value):
    """Resolve Anki's multi-field TTS blocks after field replacement."""
    pattern = re.compile(r'\[anki:tts\s+([^\]]+)\](.*?)\[/anki:tts\]', re.S)
    def replace(match):
        options = shlex.split(match[1])
        languages = [token[5:] for token in options if token.startswith('lang=')]
        if len(languages) != 1 or '[anki:tts' in match[2]:
            raise ValueError('TTS blocks require one lang option and cannot be nested')
        spec = shlex.join(['tts', languages[0]] + [token for token in options if not token.startswith('lang=')])
        return descriptor(spec, match[2])
    result = pattern.sub(replace, value)
    if '[anki:tts' in result or '[/anki:tts]' in result:
        raise ValueError('Unclosed or malformed TTS block')
    return result
