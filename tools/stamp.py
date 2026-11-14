"""Bump the ?v= cache-busting stamp on every script/stylesheet in web/index.html.

GitHub Pages lets browsers cache files for 10 minutes, so after changing any .js or .css file run this
before committing; otherwise people keep running the old code next to the new page.

usage: python tools/stamp.py
"""
import datetime
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(HERE, '..', 'web', 'index.html')
stamp = datetime.datetime.now().strftime('%Y%m%d%H%M%S')
with open(path, encoding='utf-8') as f:
    html = f.read()
new, n = re.subn(r'(src|href)="([A-Za-z0-9_-]+\.(?:js|css))(?:\?v=[0-9]+)?"', lambda m: f'{m.group(1)}="{m.group(2)}?v={stamp}"', html)
with open(path, 'w', encoding='utf-8', newline='\n') as f:
    f.write(new)
print(f'stamped {n} assets with v={stamp}')
