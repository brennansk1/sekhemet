import os, sys, json, subprocess
from common import to_dark
OUT = '../boards'  # run from this folder: python3 build_all.py
for g in ['status.py', 'start.py', 'login_projects.py', 'existing.py', 'members_inbox.py']:
    subprocess.run([sys.executable, g, OUT], check=True)
# name, w, h, title
ROWS = [
    [('Projects', 1440, 900, 'Projects'), ('Status', 1440, 1160, 'Status'), ('Main', 1440, 900, 'Board'), ('Issue', 1440, 960, 'Issue'), ('Review', 1440, 960, 'Review')],
    [('Start', 1440, 1000, 'Start a project · conversation'), ('StartPlan', 1440, 780, 'Start a project · plan for approval'), ('Inbox', 1440, 900, 'Inbox'), ('Members', 1440, 900, 'Members'), ('Configuration', 1440, 1040, 'Configuration · Models')],
    [('Login', 1440, 900, 'Sign in (Team)'), ('SoloBoard', 1440, 900, 'Solo · account menu'), ('TipsBoard', 1440, 900, 'Board · Tips on'), ('StatusPhone', 390, 844, 'Status · phone'), ('ReviewPhone', 390, 844, 'Review · phone'), ('Logo', 1440, 900, 'Logo')],
]
boards, order, y = {}, [], 0
def place(rows, suffix, y):
    for row in rows:
        x, hmax = 0, 0
        for name, w, h, title in row:
            f = f'{name}{suffix}.dc.html'
            boards[f] = {'x': x, 'y': y, 'w': w, 'h': h, 'title': title + (' (dark)' if suffix else '')}
            order.append(f); x += w + 80; hmax = max(hmax, h)
        y += hmax + 160
    return y
y = place(ROWS, '', 0)
y += 200
dark_rows = [[b for b in row if b[0] != 'Logo'] for row in ROWS]
for row in dark_rows:
    for name, *_ in row:
        src = open(os.path.join(OUT, name + '.dc.html')).read()
        open(os.path.join(OUT, name + 'Dark.dc.html'), 'w').write(to_dark(src))
place(dark_rows, 'Dark', y)
c = {"v": 3, "createdOnFiles": {"v": 1, "at": "2026-09-24T19:29:32Z"}, "title": "Sekhemet dashboard mockups", "launch": {"view": "canvas"},
     "pages": [], "boards": boards, "order": order, "notes": {}, "designSystems": []}
json.dump(c, open(os.path.join(OUT, 'canvas.json'), 'w'), ensure_ascii=False)
print(len(order), 'boards')
print(json.dumps(sorted(order)))
