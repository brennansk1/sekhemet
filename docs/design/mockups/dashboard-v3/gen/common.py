"""Shared pieces for the Sekhemet mockup boards: head, logo, sidebar, account menu, dark theme."""
import re

MARK_PATH = 'M2.2 21L4.4 6.5H9.3V21zM21.8 21L19.6 6.5h-4.9V21z'


def mark(size=22, ink='#1D1B17', gold='#8E6512'):
    return (f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" aria-hidden="true">'
            f'<path d="{MARK_PATH}" fill="{ink}"/><circle cx="12" cy="6.5" r="2.4" fill="{gold}"/></svg>')


def icon(d, size=16, sw='1.7', color='currentColor', extra=''):
    return (f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="{color}" '
            f'stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"{extra}>{d}</svg>')


I = {
    'status': '<path d="M3 13h4l2-6 4 12 2-6h6"/>',
    'pm': '<path d="M4 5h16v11H9l-5 4z"/>',
    'review': '<path d="M5 12l4 4 10-10"/>',
    'board': '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/>',
    'insights': '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    'projects': '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    'inbox': '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 2h6l1-2h5"/>',
    'mine': '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    'search': '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/>',
    'config': '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
    'updown': '<path d="M8 9l4-4 4 4M8 15l4 4 4-4"/>',
    'chev': '<path d="M9 6l6 6-6 6"/>',
    'chevdown': '<path d="M6 9l6 6 6-6"/>',
    'plus': '<path d="M12 5v14M5 12h14"/>',
    'check': '<path d="M5 12.5l4 4L19 7"/>',
    'warn': '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
    'block': '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
    'clock': '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
    'people': '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5"/><circle cx="17" cy="9" r="2.8"/><path d="M16 14.5c2.8 0 4.8 1.4 5.5 4.5"/>',
    'signout': '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
    'sun': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
    'moon': '<path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/>',
    'keyboard': '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.5M10 10h.5M14 10h.5M18 10h.5M7 14h10"/>',
    'user': '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
    'bell': '<path d="M6 16V11a6 6 0 0112 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 004 0"/>',
    'lock': '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    'key': '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
    'link': '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
    'doc': '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    'globe': '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z"/>',
    'cpu': '<rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    'at': '<circle cx="12" cy="12" r="3.5"/><path d="M15.5 12v1.5a2.5 2.5 0 005 0V12a8.5 8.5 0 10-3.3 6.7"/>',
    'more': '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    'send': '<path d="M4 12l16-8-6 16-2.5-6.5z"/>',
    'edit': '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    'x': '<path d="M6 6l12 12M18 6L6 18"/>',
    'arrowup': '<path d="M12 19V5M6 11l6-6 6 6"/>',
    'spark': '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
}

AVATAR = {  # initials -> (bg, fg)
    'BK': ('#E3DCCB', '#1D1B17'), 'DR': ('#DCE6F2', '#1F4F85'), 'PN': ('#E4EFE6', '#2E5E3E'),
    'SO': ('#F1E4D8', '#7A4A22'), 'ML': ('#E9E2F2', '#4E3A7A'), 'JT': ('#F2E1E1', '#7A2E2E'),
}


def avatar(ini, size=22):
    bg, fg = AVATAR.get(ini, ('#E3DCCB', '#1D1B17'))
    fs = round(size * 0.42, 1)
    return (f'<span aria-hidden="true" style="width: {size}px; height: {size}px; border-radius: {size // 2}px; background: {bg}; color: {fg}; '
            f'font-size: {fs}px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;">{ini}</span>')


def agent_avatar(size=22):
    return (f'<span aria-hidden="true" style="width: {size}px; height: {size}px; border-radius: 6px; background: #1D1B17; '
            f'display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;">'
            f'{icon(I["cpu"], round(size * 0.62), "2", "#E2C07A")}</span>')


def seshat_avatar(size=22):
    return (f'<span aria-hidden="true" style="width: {size}px; height: {size}px; border-radius: {size // 2}px; background: #1D1B17; color: #E2C07A; '
            f'font-size: {round(size * 0.42, 1)}px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;">S</span>')


def head(title, extra_css=''):
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap" rel="stylesheet">
<style>
body{{margin:0;font-family:'Inter',-apple-system,'Segoe UI',sans-serif;color:#1D1B17;background:#F7F6F3;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}}
a{{color:inherit;text-decoration:none}}
button,input,textarea,select{{font-family:inherit}}
.mono{{font-family:'JetBrains Mono',monospace}}
{extra_css}
</style>
</helmet>
'''


def foot(w, h, script='class Component extends DCLogic { renderVals() { return {}; } }'):
    return f'''</x-dc>
<script type="text/x-dc" data-dc-script data-props='{{"$preview":{{"width":{w},"height":{h}}}}}'>
{script}
</script>
</body>
</html>
'''


NAV_ITEM = 'display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 6px; color: #5F584B;'
NAV_ACTIVE = 'display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 6px; background: #EFECE6; color: #1D1B17; font-weight: 500; box-shadow: inset 2px 0 0 #8E6512;'
COUNT = '<span style="margin-left: auto; font-size: 11px; font-weight: 600; background: #EFECE6; color: #1D1B17; border-radius: 10px; padding: 1px 7px;">{n}</span>'


def _item(key, label, href, active, count=None, trail=''):
    style = NAV_ACTIVE if key == active else NAV_ITEM
    cur = ' aria-current="page"' if key == active else ''
    c = COUNT.format(n=count) if count else ''
    return f'<a href="{href}"{cur} style="{style}">{icon(I[key])}<span>{label}</span>{trail}{c}</a>\n'


def sidebar(active, account_open=False, solo=False, project='Chronicle', proj_ini='CH', proj_bg='#2F6FB5'):
    """The one sidebar. active in: projects, inbox, mine, status, board, review, pm, insights, config, none."""
    s = '<nav aria-label="Main" style="width: 232px; flex-shrink: 0; background: #FBFAF8; border-right: 1px solid #E6E3DC; display: flex; flex-direction: column; padding: 14px 10px 10px; box-sizing: border-box; gap: 16px; position: relative; font-size: 13px;">\n'
    s += (f'<div style="display: flex; align-items: center; gap: 9px; padding: 2px 8px;">{mark(22)}'
          f'<span style="font-weight: 600; font-size: 15px; letter-spacing: -0.01em; color: #1D1B17;">Sekhemet</span>'
          f'<div style="flex-grow: 1;"></div>'
          f'<button aria-label="Search (Ctrl K)" style="width: 28px; height: 28px; border: 0; background: transparent; color: #5F584B; border-radius: 6px; display: flex; align-items: center; justify-content: center;">{icon(I["search"], 15)}</button></div>\n')
    s += '<div style="display: flex; flex-direction: column; gap: 1px;">\n'
    s += _item('projects', 'Projects', 'Projects.dc.html', active)
    s += _item('inbox', 'Inbox', '#', active, 3)
    if not solo:
        s += _item('mine', 'My issues', '#', active)
    s += '</div>\n'
    s += ('<div style="display: flex; flex-direction: column; gap: 1px;">\n'
          f'<button aria-label="Switch project" style="display: flex; align-items: center; gap: 8px; padding: 5px 10px; margin-bottom: 3px; border: 0; background: transparent; border-radius: 6px; font-size: 12px; font-weight: 600; color: #1D1B17; text-align: left;">'
          f'<span aria-hidden="true" style="width: 16px; height: 16px; border-radius: 4px; background: {proj_bg}; color: #FFFFFF; font-size: 8.5px; font-weight: 600; display: flex; align-items: center; justify-content: center;">{proj_ini}</span>'
          f'<span style="flex-grow: 1;">{project}</span>{icon(I["updown"], 13, "1.8", "#8C8577")}</button>\n')
    s += _item('status', 'Status', 'Status.dc.html', active)
    s += _item('board', 'Board', 'Main.dc.html', active)
    s += _item('review', 'Review', 'Review.dc.html', active, 2)
    s += _item('pm', 'Project manager', 'Start.dc.html', active, None, '<span style="margin-left: auto; font-size: 11.5px; color: #8C8577;">Seshat</span>')
    s += _item('insights', 'Insights', '#', active)
    s += ('<details style="margin-top: 2px;"><summary style="list-style: none; padding: 5px 10px 5px 36px; color: #8C8577; font-size: 12px; cursor: pointer;">More</summary></details>\n')
    s += '</div>\n<div style="flex-grow: 1;"></div>\n'
    s += ('<div style="display: flex; flex-direction: column; gap: 1px;">\n'
          '<div style="display: flex; align-items: center; gap: 8px; padding: 6px 10px; color: #5F584B; font-size: 12px;"><span style="width: 7px; height: 7px; border-radius: 4px; background: #2F6FB5;" aria-hidden="true"></span>Agent working on CHR-7</div>\n')
    s += _item('config', 'Configuration', 'Configuration.dc.html', active)
    s += '</div>\n'
    name, sub = ('Brennan Kelley', 'This computer') if solo else ('Brennan Kelley', 'Admin · Northwind')
    bg = '#EFECE6' if account_open else 'transparent'
    s += (f'<button aria-haspopup="menu" aria-expanded="{"true" if account_open else "false"}" style="display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 0; border-top: 1px solid #E6E3DC; background: {bg}; border-radius: 0 0 6px 6px; text-align: left; margin: 0 -2px;">'
          f'{avatar("BK", 28)}<span style="display: flex; flex-direction: column; line-height: 1.3; flex-grow: 1; min-width: 0;"><span style="font-size: 13px; font-weight: 500; color: #1D1B17;">{name}</span>'
          f'<span style="font-size: 11.5px; color: #6B6456;">{sub}</span></span>{icon(I["updown"], 14, "1.8", "#8C8577")}</button>\n')
    if account_open:
        s += account_menu(solo)
    s += '</nav>\n'
    return s


def _mi(ic, label, trail=''):
    return (f'<a href="#" role="menuitem" style="display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 6px; color: #1D1B17;">'
            f'{icon(I[ic], 15, "1.7", "#5F584B")}<span style="flex-grow: 1;">{label}</span>{trail}</a>\n')


def account_menu(solo=False):
    kbd = '<span class="mono" style="font-size: 11px; color: #8C8577;">{k}</span>'
    s = ('<div role="menu" aria-label="Account" style="position: absolute; left: 10px; bottom: 60px; width: 252px; background: #FFFFFF; border: 1px solid #DAD5CB; border-radius: 10px; '
         'box-shadow: 0 10px 28px rgba(29,27,23,0.14), 0 1px 3px rgba(29,27,23,0.08); padding: 6px; z-index: 10; font-size: 13px;">\n')
    s += ('<div style="padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 2px; border-bottom: 1px solid #ECE9E3; margin-bottom: 4px;">'
          '<span style="font-weight: 500;">Brennan Kelley</span><span style="font-size: 12px; color: #6B6456;">'
          + ('Local account on this computer' if solo else 'brennan@northwind.dev') + '</span></div>\n')
    s += _mi('user', 'Profile')
    s += _mi('bell', 'Notifications')
    s += _mi('keyboard', 'Keyboard shortcuts', kbd.format(k='?'))
    s += ('<div style="display: flex; align-items: center; gap: 10px; padding: 7px 10px;">' + icon(I['sun'], 15, '1.7', '#5F584B') +
          '<span style="flex-grow: 1;">Theme</span><div role="radiogroup" aria-label="Theme" style="display: flex; background: #F2F0EB; border-radius: 6px; padding: 2px;">'
          '<button role="radio" aria-checked="false" style="border: 0; background: transparent; font-size: 11.5px; padding: 3px 7px; border-radius: 4px; color: #5F584B;">System</button>'
          '<button role="radio" aria-checked="true" style="border: 0; background: #FFFFFF; font-size: 11.5px; padding: 3px 7px; border-radius: 4px; color: #1D1B17; box-shadow: 0 1px 2px rgba(29,27,23,0.08);">Light</button>'
          '<button role="radio" aria-checked="false" style="border: 0; background: transparent; font-size: 11.5px; padding: 3px 7px; border-radius: 4px; color: #5F584B;">Dark</button></div></div>\n')
    if not solo:
        s += '<div style="height: 1px; background: #ECE9E3; margin: 4px 0;"></div>\n'
        s += _mi('people', 'Members', '<span style="font-size: 12px; color: #8C8577;">6</span>')
        s += _mi('projects', 'Switch workspace')
        s += '<div style="height: 1px; background: #ECE9E3; margin: 4px 0;"></div>\n'
        s += _mi('signout', 'Sign out')
    return s + '</div>\n'


def replace_sidebar(html, active, **kw):
    """Swap the old <nav aria-label="Main">…</nav> in an existing board for the shared sidebar."""
    new, n = re.subn(r'<nav aria-label="Main".*?</nav>\n?', lambda m: sidebar(active, **kw), html, count=1, flags=re.S)
    assert n == 1, 'no Main nav found'
    return new


# ---------- dark theme ----------
DARK = {'#FFFFFF': '#1C1A16', '#F7F6F3': '#14120F', '#FBFAF8': '#181612', '#FCFBF9': '#181612', '#EFECE6': '#2C2822', '#F2F0EB': '#24211C',
        '#F3F1EC': '#24211C', '#E6E3DC': '#2E2A24', '#ECE9E3': '#2E2A24', '#E2DDD3': '#3D382F', '#DAD5CB': '#3D382F', '#D4CFC4': '#3D382F',
        '#8C8577': '#7D7667', '#1D1B17': '#EDE7DA', '#2B2822': '#D9D2C3', '#3A362E': '#D9D2C3', '#5F584B': '#A79E8C', '#6B6456': '#A79E8C',
        '#A9A293': '#857E70', '#B7B0A2': '#5C564B', '#E3DCCB': '#3D382F', '#DCD7CC': '#3D382F', '#2E7D4A': '#4FA36B', '#2F6FB5': '#4C8ED9',
        '#A63A2B': '#D2614F', '#B3402F': '#D2614F', '#9A4F1C': '#C8743A', '#8E6512': '#C8952A', '#6B4FA0': '#9A7FD1', '#EEF6F0': '#1E2B21',
        '#FBEDEA': '#2E1D1A', '#F8E9E6': '#3A231F', '#E6EEF8': '#1D2A3A', '#E6E2DA': '#2C2822', '#E2C07A': '#8E6512', '#D9B45A': '#8E6512',
        '#1F4F85': '#7FB0E8', '#F3EEE3': '#24211C', '#FDF6E8': '#2A2418', '#F5EBD7': '#3A301C',
        # avatars
        '#DCE6F2': '#1D2A3A', '#E4EFE6': '#1E2B21', '#2E5E3E': '#7FC495', '#F1E4D8': '#33261B', '#7A4A22': '#E0A874',
        '#E9E2F2': '#2A2336', '#4E3A7A': '#B9A5E3', '#F2E1E1': '#352020', '#7A2E2E': '#E89A9A'}
# Things that must stay as they are on the dark surface (the Agent/Seshat tiles are ink with gold on both themes).
KEEP = ['background: #1D1B17; color: #E2C07A', 'background: #1D1B17; display: inline-flex', 'stroke="#E2C07A"']


def to_dark(html, title_suffix=' (dark)', link_map=True):
    keep = {}
    for i, k in enumerate(KEEP):
        tok = f'@@KEEP{i}@@'
        keep[tok] = k.replace('#1D1B17', '#2C2822')
        html = html.replace(k, tok)
    html = re.sub(r'#[0-9A-Fa-f]{6}\b|#000\b', lambda m: DARK.get(m.group(0).upper(), m.group(0)), html)
    for tok, k in keep.items():
        html = html.replace(tok, k)
    html = html.replace('rgba(29,27,23,', 'rgba(0,0,0,')
    html = html.replace('<style>\n', '<style>\n:root{color-scheme:dark}\n', 1)
    html = re.sub(r'<title>(.*?)</title>', lambda m: f'<title>{m.group(1)}{title_suffix}</title>', html, count=1)
    if link_map:
        html = re.sub(r'href="([A-Za-z]+)\.dc\.html"', lambda m: f'href="{m.group(1)}Dark.dc.html"', html)
    # the primary button: ink on light becomes cream on dark; its text must flip to ink
    html = html.replace('background: #EDE7DA; color: #1C1A16', 'background: #EDE7DA; color: #14120F')
    return html


def light_leftovers(html):
    light = [k for k in DARK if k not in ('#1D1B17',)]
    return sorted({h for h in re.findall(r'#[0-9A-Fa-f]{6}\b', html) if h.upper() in light})
