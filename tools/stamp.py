"""Bump the ?v= cache-busting stamp on scripts and stylesheets in both web entry points.

GitHub Pages lets browsers cache files for 10 minutes, so after changing any .js or .css file run this
before committing; otherwise people keep running the old code next to the new page.

usage: python tools/stamp.py
"""
import datetime
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
stamp = datetime.datetime.now().strftime('%Y%m%d%H%M%S')
for page in ('index.html', 'experiment-live.html', 'key.html', 'teach.html', 'hologram.html'):
    path = os.path.join(HERE, '..', 'web', page)
    with open(path, encoding='utf-8') as f:
        html = f.read()
    new, n = re.subn(r'(src|href)="([A-Za-z0-9_.-]+\.(?:js|css))(?:\?v=[0-9]+)?"',
                     lambda m: f'{m.group(1)}="{m.group(2)}?v={stamp}"', html)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(new)
    print(f'{page}: stamped {n} assets with v={stamp}')
