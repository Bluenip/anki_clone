"""Native Anki LaTeX extraction with an isolated, bounded TeX subprocess.

Only TeX runtime directories and a temporary work directory are exposed to the
compiler. Database, media, home directories and network are never mounted.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
from functools import lru_cache

HEADER = r'''\documentclass[12pt]{article}
\usepackage[utf8]{inputenc}
\usepackage{amssymb,amsmath}
\pagestyle{empty}
\setlength{\parindent}{0in}
\begin{document}'''
FOOTER = r'\end{document}'
_slots = threading.BoundedSemaphore(2)


def tectonic_root():
    return Path(os.getenv('ANKI_TECTONIC_DIR', str(Path.home() / '.cache' / 'anki-latex')))


def available():
    runtime = all(shutil.which(name) for name in ('latex', 'dvipng')) or ((tectonic_root() / 'tectonic').is_file() and (tectonic_root() / 'cache').is_dir() and shutil.which('pdftoppm'))
    return bool(runtime and all(shutil.which(name) for name in ('bwrap', 'prlimit')))


def settings(model):
    package = getattr(model, 'package_data', None)
    raw = json.loads(package.payload) if package else {}
    return raw.get('latexPre', HEADER), raw.get('latexPost', FOOTER)


def compile_png(body, header, footer):
    if not available():
        raise ValueError('LaTeX generation requires latex, dvipng, bubblewrap and prlimit on the server. Use the provided Docker image or install these tools.')
    if len(body) + len(header) + len(footer) > 100000:
        raise ValueError('LaTeX source exceeds 100000 characters')
    if not _slots.acquire(blocking=False):
        raise ValueError('LaTeX renderer is busy; try again shortly')
    try:
        with tempfile.TemporaryDirectory(prefix='anki_latex_') as directory:
            work = Path(directory)
            (work / 'input.tex').write_text(header + '\n' + body + '\n' + footer, encoding='utf-8')
            sandbox = [shutil.which('prlimit'), '--cpu=15', '--as=536870912', '--fsize=20971520', '--nofile=64', '--',
                       shutil.which('bwrap'), '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
                       '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/work',
                       '--setenv', 'openin_any', 'p', '--setenv', 'openout_any', 'p',
                       '--setenv', 'shell_escape', 'f', '--ro-bind', '/usr', '/usr']
            for path in ('/lib', '/lib64', '/bin', '/etc/texmf', '/var/lib/texmf', '/etc/fonts', '/var/cache/fontconfig'):
                if Path(path).exists(): sandbox += ['--ro-bind', path, path]
            sandbox += ['--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', directory, '/work', '--chdir', '/work', '--']
            if not shutil.which('latex') or not shutil.which('dvipng'):
                root = tectonic_root()
                sandbox[-1:-1] = ['--ro-bind', str(root / 'tectonic'), '/tectonic', '--ro-bind', str(root / 'cache'), '/cache', '--setenv', 'XDG_CACHE_HOME', '/cache']
                commands = [['/tectonic', '--untrusted', '--only-cached', '--keep-logs', 'input.tex'],
                            ['pdftoppm', '-png', '-singlefile', '-r', '160', '-scale-to', '2048', 'input.pdf', 'output']]
            else:
                commands = [['latex', '-no-shell-escape', '-halt-on-error', '-interaction=batchmode', 'input.tex'],
                        ['dvipng', '-nogs', '-bg', 'Transparent', '-D', '200', '-T', 'tight', '-o', 'output.png', 'input.dvi']]
            for command in commands:
                try:
                    with (work / 'compiler.log').open('wb') as output:
                        result = subprocess.run(sandbox + command, stdout=output, stderr=subprocess.STDOUT, timeout=20)
                except subprocess.TimeoutExpired:
                    raise ValueError('LaTeX compilation exceeded its time limit') from None
                if result.returncode:
                    detail = (work / 'compiler.log').read_text(errors='replace')[-2000:]
                    texlog = work / 'input.log'
                    if texlog.exists(): detail += '\n' + texlog.read_text(errors='replace')[-2000:]
                    raise ValueError('LaTeX compilation failed: ' + detail)
            output = work / 'output.png'
            if not output.is_file() or output.stat().st_size > 20 * 1024 * 1024:
                raise ValueError('LaTeX produced no usable image')
            if not shutil.which('latex') or not shutil.which('dvipng'):
                from PIL import Image, ImageChops
                from io import BytesIO
                with Image.open(output) as image:
                    rgb = image.convert('RGB')
                    bounds = ImageChops.difference(rgb, Image.new('RGB', rgb.size, 'white')).getbbox()
                    if bounds:
                        bounds = (max(0, bounds[0]-4), max(0, bounds[1]-4), min(rgb.width, bounds[2]+4), min(rgb.height, bounds[3]+4))
                        rgb = rgb.crop(bounds)
                    encoded = BytesIO(); rgb.save(encoded, format='PNG'); return encoded.getvalue()
            return output.read_bytes()
    finally:
        _slots.release()


@lru_cache(maxsize=128)
def extract(value, svg=False):
    from anki.collection import Collection
    with tempfile.TemporaryDirectory(prefix='anki_latex_extract_') as directory:
        collection = Collection(str(Path(directory) / 'extraction.anki2'))
        try: return collection._backend.extract_latex(text=value, svg=svg, expand_clozes=False)
        finally: collection.close()


def render(value, uid, model=None):
    if not any(marker in value for marker in ('[latex]', '[$]', '[$$]')): return value
    from media_utils import get_media_dir
    package = getattr(model, 'package_data', None)
    svg = bool(json.loads(package.payload).get('latexsvg')) if package else False
    extracted = extract(value, svg)
    if len(extracted.latex) > 64: raise ValueError('At most 64 LaTeX expressions per card face')
    folder = Path(get_media_dir(uid))
    header, footer = settings(model)
    # Keep browser math working without server TeX; full [latex] blocks require
    # the real compiler. Existing imported native images always take precedence.
    if '[latex]' not in value and not available() and any(not (folder / item.filename).is_file() for item in extracted.latex):
        return value
    for item in extracted.latex:
        target = folder / item.filename
        if target.is_symlink(): raise ValueError('Unsafe LaTeX media destination')
        if target.is_file(): continue
        data = compile_png(item.latex_body, header, footer)
        if svg:
            # Native SVG note types keep their expected filename; the generated
            # PNG is self-contained inside an inert SVG image container.
            import base64
            from io import BytesIO
            from PIL import Image
            with Image.open(BytesIO(data)) as image: width, height = image.size
            encoded = base64.b64encode(data).decode('ascii')
            data = (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{width}" height="{height}" viewBox="0 0 {width} {height}"><image width="{width}" height="{height}" xlink:href="data:image/png;base64,{encoded}"/></svg>').encode()
        folder.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=folder, prefix='.latex-', delete=False) as temporary:
            staged = Path(temporary.name)
            temporary.write(data)
        try: os.replace(staged, target)
        finally: staged.unlink(missing_ok=True)
    return extracted.text
