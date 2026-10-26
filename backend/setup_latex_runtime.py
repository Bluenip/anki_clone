"""Install a pinned user-local TeX runtime; no sudo and no application DB access.

Run explicitly: python setup_latex_runtime.py. Network is used only here to
fetch the verified release and prime trusted packages, never to render notes.
"""
import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import urllib.request

VERSION = '0.17.0'
SHA256 = '8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7'
URL = f'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40{VERSION}/tectonic-{VERSION}-x86_64-unknown-linux-musl.tar.gz'
TRUSTED_SAMPLE = r'''\documentclass[12pt]{article}
\usepackage[utf8]{inputenc}
\usepackage{amssymb,amsmath,tikz}
\usepackage[version=4]{mhchem}
\pagestyle{empty}
\begin{document}
\begin{tabular}{cc}A&B\\C&D\end{tabular}
\[\int_0^1 x^2 dx = \frac13\]
\ce{H2O}
\begin{tikzpicture}\draw (0,0) circle (1cm);\end{tikzpicture}
\end{document}'''


def main():
    if platform.system() != 'Linux' or platform.machine() not in ('x86_64', 'AMD64'):
        raise SystemExit('This portable installer supports Linux x86_64. Use the Docker TeX runtime on other systems.')
    missing = [name for name in ('bwrap', 'prlimit', 'pdftoppm') if not shutil.which(name)]
    if missing: raise SystemExit('Install these system tools first: ' + ', '.join(missing))
    root = Path(os.getenv('ANKI_TECTONIC_DIR', str(Path.home() / '.cache' / 'anki-latex')))
    root.mkdir(parents=True, exist_ok=True)
    archive = root / 'tectonic.tar.gz'
    if not archive.is_file() or hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
        temporary = archive.with_suffix('.download')
        try:
            with urllib.request.urlopen(URL, timeout=60) as source, temporary.open('wb') as target:
                shutil.copyfileobj(source, target)
            if hashlib.sha256(temporary.read_bytes()).hexdigest() != SHA256:
                raise SystemExit('Release checksum mismatch; runtime was not installed.')
            os.replace(temporary, archive)
        finally: temporary.unlink(missing_ok=True)
    with tarfile.open(archive) as package:
        member = next(m for m in package.getmembers() if m.name == 'tectonic' and m.isfile())
        binary = root / 'tectonic'; binary.write_bytes(package.extractfile(member).read()); binary.chmod(0o755)
    work = root / 'work'; work.mkdir(exist_ok=True)
    cache = root / 'cache'; cache.mkdir(exist_ok=True)
    source = work / 'input.tex'; source.write_text(TRUSTED_SAMPLE, encoding='utf-8')
    print('Caching trusted TeX packages. First setup can take several minutes.', flush=True)
    subprocess.run([str(binary), '--untrusted', '--keep-logs', str(source)], env={**os.environ, 'XDG_CACHE_HOME': str(cache)}, check=True, timeout=1200)
    print(f'Ready: {root}. Notes compile offline inside the sandbox.')


if __name__ == '__main__': main()
