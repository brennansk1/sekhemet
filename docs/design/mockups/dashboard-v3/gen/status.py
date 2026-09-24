from common import *

W, H = 1440, 1160
PANEL = 'background: #FFFFFF; border: 1px solid #E6E3DC; border-radius: 10px;'
H3 = 'margin: 0; font-size: 12.5px; font-weight: 600;'
SUB = 'font-size: 12px; color: #6B6456;'
TOP = ' style="flex-shrink: 0; margin-top: 2px;"'


def burnup():
    x0, x1, y0, y1 = 36, 700, 206, 14
    days, top = 32, 28          # Sep 8 .. Oct 10, 0..28 issues
    X = lambda d: round(x0 + (x1 - x0) * d / days, 1)
    Y = lambda v: round(y0 - (y0 - y1) * v / top, 1)
    done = [(0, 0), (2, 2), (4, 3), (7, 5), (9, 7), (11, 9), (14, 11), (16, 13), (17, 14)]
    scope = [(0, 20), (10, 20), (10, 24), (17, 24), (32, 24)]
    g = []
    for v in (0, 8, 16, 24):
        g.append(f'<line x1="{x0}" x2="{x1}" y1="{Y(v)}" y2="{Y(v)}" stroke="#ECE9E3"/>'
                 f'<text x="{x0 - 8}" y="{Y(v) + 4}" text-anchor="end" font-size="11" fill="#8C8577">{v}</text>')
    for d, lab in ((0, 'Sep 8'), (7, 'Sep 15'), (14, 'Sep 22'), (21, 'Sep 29'), (28, 'Oct 6')):
        g.append(f'<text x="{X(d)}" y="{y0 + 18}" text-anchor="middle" font-size="11" fill="#8C8577">{lab}</text>')
    # forecast range: from today (d17, 14) to 24 between Oct 3 (d25) and Oct 7 (d29)
    cone = f'M{X(17)} {Y(14)} L{X(25)} {Y(24)} L{X(29)} {Y(24)} Z'
    g.append(f'<path d="{cone}" fill="#2F6FB5" fill-opacity="0.10"/>')
    g.append(f'<path d="M{X(17)} {Y(14)} L{X(25)} {Y(24)}" stroke="#2F6FB5" stroke-width="1.5" stroke-dasharray="4 3" fill="none"/>')
    # target
    g.append(f'<line x1="{X(27)}" x2="{X(27)}" y1="{y1}" y2="{y0}" stroke="#1D1B17" stroke-dasharray="2 3"/>'
             f'<text x="{X(27) + 5}" y="{y1 + 10}" font-size="11" fill="#1D1B17">Target Oct 5</text>')
    # today
    g.append(f'<line x1="{X(17)}" x2="{X(17)}" y1="{y1 + 18}" y2="{y0}" stroke="#D4CFC4"/>'
             f'<text x="{X(17)}" y="{y1 + 12}" text-anchor="middle" font-size="11" fill="#6B6456">Today</text>')
    sp = ' '.join(f'{X(d)},{Y(v)}' for d, v in scope)
    g.append(f'<polyline points="{sp}" fill="none" stroke="#8C8577" stroke-width="1.5"/>')
    g.append(f'<text x="{X(10) + 5}" y="{Y(24) - 6}" font-size="11" fill="#6B6456">+4 issues, Sep 18</text>')
    dp = ' '.join(f'{X(d)},{Y(v)}' for d, v in done)
    g.append(f'<polyline points="{dp}" fill="none" stroke="#2E7D4A" stroke-width="2.2" stroke-linejoin="round"/>')
    g.append(f'<circle cx="{X(17)}" cy="{Y(14)}" r="3.5" fill="#2E7D4A"/>')
    return (f'<svg width="100%" height="256" viewBox="0 0 712 232" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Release 1 burn-up: 14 of 24 issues done; '
            f'likely complete Oct 3, 85% by Oct 7; target Oct 5">' + ''.join(g) + '</svg>')


def legend(color, label, dashed=False, area=False):
    if area:
        sw = f'<span style="width: 14px; height: 10px; background: {color}; opacity: 0.18; border-radius: 2px;"></span>'
    else:
        b = 'dashed' if dashed else 'solid'
        sw = f'<span style="width: 14px; border-top: 2px {b} {color};"></span>'
    return f'<span style="display: inline-flex; align-items: center; gap: 6px;">{sw}{label}</span>'


def kpi(label, value, sub, first=False, tone='#1D1B17'):
    bl = '' if first else 'border-left: 1px solid #ECE9E3;'
    return (f'<div style="padding: 14px 18px; {bl} display: flex; flex-direction: column; gap: 3px; min-width: 0;">'
            f'<span style="{SUB}">{label}</span><span style="font-size: 22px; font-weight: 600; color: {tone}; letter-spacing: -0.01em;">{value}</span>'
            f'<span style="{SUB}">{sub}</span></div>')


def need(key, title, meta, button, primary=False):
    b = ('border: 0; background: #1D1B17; color: #FFFFFF;' if primary else 'border: 1px solid #D4CFC4; background: #FFFFFF; color: #1D1B17;')
    k = f'<span class="mono" style="font-size: 11.5px; color: #6B6456;">{key}</span> · ' if key else ''
    return (f'<li style="display: flex; align-items: center; gap: 12px; padding: 11px 0; border-bottom: 1px solid #ECE9E3;">'
            f'<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px;"><span style="line-height: 1.35;">{title}</span>'
            f'<span style="{SUB}">{k}{meta}</span></div>'
            f'<button style="{b} padding: 5px 12px; border-radius: 6px; font-size: 12.5px; font-weight: 500; flex-shrink: 0;">{button}</button></li>')


def waiting(ini, text, meta):
    return (f'<li style="display: flex; align-items: center; gap: 10px; padding: 8px 0;">{avatar(ini, 22)}'
            f'<span style="flex-grow: 1; line-height: 1.35;">{text}</span><span style="{SUB} flex-shrink: 0;">{meta}</span></li>')


STATE = {
    'done': (icon(I['check'], 14, '2.4', '#2E7D4A'), 'Done'),
    'weak': (icon(I['warn'], 14, '2', '#9A4F1C'), 'Tests too weak'),
    'prog': ('<span style="width: 12px; height: 12px; border-radius: 6px; border: 2px solid #2F6FB5; box-sizing: border-box; background: linear-gradient(90deg, #2F6FB5 50%, transparent 50%);"></span>', 'In progress'),
    'todo': ('<span style="width: 12px; height: 12px; border-radius: 6px; border: 1.5px solid #B7B0A2; box-sizing: border-box;"></span>', 'Not started'),
    'block': (icon(I['block'], 14, '2', '#B3402F'), 'Blocked'),
}


def req(state, text, issues):
    ic, lab = STATE[state]
    return (f'<li style="display: flex; align-items: center; gap: 10px; padding: 6px 0;"><span title="{lab}" aria-label="{lab}" style="width: 16px; display: flex; justify-content: center;">{ic}</span>'
            f'<span style="flex-grow: 1; line-height: 1.35;">{text}</span><span style="{SUB} white-space: nowrap;">{issues}</span></li>')


def risk(tone, text, sub):
    col = {'warn': '#9A4F1C', 'fail': '#B3402F', 'info': '#6B6456'}[tone]
    ic = I['block'] if tone == 'fail' else (I['warn'] if tone == 'warn' else I['arrowup'])
    return (f'<li style="display: flex; gap: 10px; padding: 9px 0; border-bottom: 1px solid #ECE9E3;">{icon(ic, 15, "1.9", col, TOP)}'
            f'<div style="display: flex; flex-direction: column; gap: 3px;"><span style="line-height: 1.45;">{text}</span><span style="{SUB}">{sub}</span></div></li>')


def worker(av, name, role, what, state, state_col):
    return (f'<li style="display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid #ECE9E3;">{av}'
            f'<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;"><span><span style="font-weight: 500;">{name}</span> <span style="{SUB}">{role}</span></span>'
            f'<span style="font-size: 12.5px; color: #2B2822; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{what}</span></div>'
            f'<span style="font-size: 12px; color: {state_col}; flex-shrink: 0;">{state}</span></li>')


def build():
    s = head('Status')
    s += f'<div style="width: {W}px; height: {H}px; display: flex; background: #F7F6F3; font-size: 13px; color: #1D1B17;">\n'
    s += sidebar('status')
    s += '<main style="flex-grow: 1; display: flex; flex-direction: column; min-width: 0;">\n'
    s += ('<header style="display: flex; align-items: center; gap: 12px; padding: 0 28px; height: 56px; background: #FFFFFF; border-bottom: 1px solid #E6E3DC; flex-shrink: 0;">'
          '<div style="display: flex; align-items: center; gap: 8px; color: #5F584B;"><span>Chronicle</span><span aria-hidden="true">/</span>'
          '<h1 style="margin: 0; font-size: 15px; font-weight: 600; color: #1D1B17;">Status</h1></div><div style="flex-grow: 1;"></div>'
          f'<span style="{SUB}">Updated 2 min ago</span>'
          '<button style="border: 1px solid #D4CFC4; background: #FFFFFF; color: #1D1B17; padding: 6px 12px; border-radius: 7px; font-size: 12.5px;">Ask Seshat</button>'
          '<button style="border: 1px solid #D4CFC4; background: #FFFFFF; color: #1D1B17; padding: 6px 12px; border-radius: 7px; font-size: 12.5px;">Write update</button></header>\n')
    s += '<div style="flex-grow: 1; padding: 22px 28px; display: flex; flex-direction: column; gap: 18px; overflow: hidden;">\n'
    # headline
    s += ('<section aria-label="Summary" style="display: flex; flex-direction: column; gap: 6px;">'
          '<div style="display: flex; align-items: center; gap: 10px;"><span style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: #2E7D4A; background: #EEF6F0; border-radius: 5px; padding: 3px 8px;">'
          '<span style="width: 7px; height: 7px; border-radius: 4px; background: #2E7D4A;"></span>On track</span>'
          f'<span style="{SUB}">Set by Brennan Kelley on Monday · Release 1 · Loans and returns</span></div>'
          '<h2 style="margin: 0; font-size: 18px; font-weight: 600; line-height: 1.4; max-width: 980px;">Release 1 is forecast for Oct 3–7 against a target of Oct 5. 5 of 11 requirements are done; one issue is blocked until the event store is finished.</h2></section>\n')
    # KPIs
    s += (f'<section aria-label="Key numbers" style="{PANEL} display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));">'
          + kpi('Release 1 forecast', 'Oct 3–7', '50% by Oct 3 · 85% by Oct 7', True)
          + kpi('Requirements done', '5 <span style="font-size: 15px; color: #6B6456; font-weight: 500;">of 11</span>', '2 more need stronger tests')
          + kpi('Issues done', '14 <span style="font-size: 15px; color: #6B6456; font-weight: 500;">of 24</span>', '4 added on Sep 18')
          + kpi('Sprint 3', '6 <span style="font-size: 15px; color: #6B6456; font-weight: 500;">of 16</span>', 'Day 4 of 10 · ends Oct 5')
          + kpi('Needs attention', '3', '1 blocked · 2 waiting for review', tone='#9A4F1C')
          + '</section>\n')
    # chart + needs you
    s += '<div style="display: grid; grid-template-columns: minmax(0, 1fr) 400px; gap: 18px;">\n'
    s += (f'<section aria-labelledby="bu-h" style="{PANEL} padding: 16px 18px 10px; display: flex; flex-direction: column; gap: 8px;">'
          f'<div style="display: flex; align-items: center; gap: 14px;"><h3 id="bu-h" style="{H3}">Release 1 burn-up</h3>'
          f'<div style="display: flex; gap: 14px; {SUB}">' + legend('#2E7D4A', 'Done') + legend('#8C8577', 'Scope') + legend('#2F6FB5', 'Forecast range', area=True) + legend('#1D1B17', 'Target', dashed=True) + '</div>'
          '<div style="flex-grow: 1;"></div><div role="tablist" aria-label="Range" style="display: flex; gap: 2px; background: #F2F0EB; border-radius: 7px; padding: 2px;">'
          '<button role="tab" aria-selected="true" style="border: 0; background: #FFFFFF; color: #1D1B17; padding: 3px 10px; border-radius: 5px; font-size: 12px; font-weight: 500; box-shadow: 0 1px 2px rgba(29,27,23,0.08);">Release 1</button>'
          '<button role="tab" aria-selected="false" style="border: 0; background: transparent; color: #5F584B; padding: 3px 10px; border-radius: 5px; font-size: 12px;">Sprint 3</button></div></div>'
          + burnup() +
          f'<p style="margin: 0; {SUB}">Forecast from the last 14 days of finished issues (1,000 simulated runs). It moves as work is finished or added.</p></section>\n')
    s += (f'<section aria-labelledby="need-h" style="{PANEL} padding: 14px 18px; display: flex; flex-direction: column;">'
          f'<div style="display: flex; align-items: baseline; gap: 8px;"><h3 id="need-h" style="{H3}">Needs you</h3><span style="{SUB}">3</span></div>'
          '<ul style="list-style: none; margin: 4px 0 0; padding: 0;">'
          + need('CHR-6', 'Review: Verify the whole hash chain on start', 'ready 2 h ago', 'Review', True)
          + need('CHR-7', 'The Agent asks: stream the ledger or load it whole?', 'continuing on “stream” in 40 min', 'Answer')
          + need('', 'Seshat proposes 2 requirements from Dana’s request', 'sign-in audit, export to CSV', 'Look')
          + '</ul>'
          f'<div style="display: flex; align-items: baseline; gap: 8px; margin-top: 14px;"><h3 style="{H3}">Waiting on others</h3><span style="{SUB}">2</span></div>'
          '<ul style="list-style: none; margin: 2px 0 0; padding: 0;">'
          + waiting('PN', 'Priya is reviewing CHR-9 Export loans as CSV', '1 d')
          + waiting('DR', 'Dana to decide how long loan history is kept', 'due today')
          + '</ul></section>\n')
    s += '</div>\n'
    # bottom row
    s += '<div style="display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr) minmax(0, 1fr); gap: 18px;">\n'
    s += (f'<section aria-labelledby="rq-h" style="{PANEL} padding: 14px 18px;">'
          f'<div style="display: flex; align-items: baseline; gap: 8px;"><h3 id="rq-h" style="{H3}">Requirements</h3><span style="{SUB}">Release 1</span><div style="flex-grow: 1;"></div><a href="#" style="font-size: 12px; color: #2F6FB5;">All 11</a></div>'
          f'<div style="{SUB} margin: 8px 0 2px; font-weight: 500;">Must have</div><ul style="list-style: none; margin: 0; padding: 0;">'
          + req('done', 'Check an item out to a person, with a due date', '3 issues')
          + req('done', 'Check an item back in', '2 issues')
          + req('done', 'See who has what, and what is overdue', '3 issues')
          + req('weak', 'Sign in with company accounts', '2 issues')
          + req('prog', 'Every change is recorded and can be verified', '4 issues')
          + req('block', 'History of every loan for each item', '2 issues')
          + '</ul>'
          f'<div style="{SUB} margin: 8px 0 2px; font-weight: 500;">Should have</div><ul style="list-style: none; margin: 0; padding: 0;">'
          + req('done', 'Email a reminder the day before an item is due', '2 issues')
          + req('todo', 'Export loans as CSV', '1 issue')
          + '</ul></section>\n')
    s += (f'<section aria-labelledby="rk-h" style="{PANEL} padding: 14px 18px;">'
          f'<div style="display: flex; align-items: baseline; gap: 8px;"><h3 id="rk-h" style="{H3}">Risks</h3><span style="{SUB}">3</span></div>'
          '<ul style="list-style: none; margin: 2px 0 0; padding: 0;">'
          + risk('fail', 'CHR-10 is blocked by the event store (CHR-4).', 'If CHR-4 slips past Sep 29, the release moves about 2 days.')
          + risk('warn', 'Reviews wait 1.6 days on average, up from 0.8.', 'Suggested: add a second reviewer for the ledger area. Why: three open reviews share one reviewer.')
          + risk('info', 'Scope grew by 4 issues on Sep 18.', 'Overdue reminders were added; the forecast includes them.')
          + '</ul>'
          f'<div style="display: flex; align-items: baseline; gap: 8px; margin-top: 14px;"><h3 style="{H3}">Done this week</h3><span style="{SUB}">5</span></div>'
          '<ul style="list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px;">'
          f'<li style="display: flex; gap: 8px;">{icon(I["check"], 14, "2.2", "#2E7D4A", TOP)}<span>Overdue items are listed first <span style="{SUB}">· accepted by Dana</span></span></li>'
          f'<li style="display: flex; gap: 8px;">{icon(I["check"], 14, "2.2", "#2E7D4A", TOP)}<span>Reminder emails <span style="{SUB}">· accepted by Brennan</span></span></li>'
          f'<li style="display: flex; gap: 8px;">{icon(I["check"], 14, "2.2", "#2E7D4A", TOP)}<span>Check-in keeps the item’s history <span style="{SUB}">· accepted by Priya</span></span></li>'
          '</ul></section>\n')
    s += (f'<section aria-labelledby="tm-h" style="{PANEL} padding: 14px 18px;">'
          f'<div style="display: flex; align-items: baseline; gap: 8px;"><h3 id="tm-h" style="{H3}">Who’s working on what</h3></div>'
          '<ul style="list-style: none; margin: 4px 0 0; padding: 0;">'
          + worker(agent_avatar(24), 'Agent', 'Coding', 'CHR-7 Stream the ledger verifier', 'Running checks', '#2F6FB5')
          + worker(avatar('SO', 24), 'Sam Ortiz', 'Developer', 'CHR-12 Late-return fees · with the Agent', 'In progress', '#2F6FB5')
          + worker(avatar('PN', 24), 'Priya Nair', 'Developer', 'Reviewing CHR-9 Export loans as CSV', 'In review', '#6B6456')
          + worker(avatar('DR', 24), 'Dana Reyes', 'Product owner', 'Release 1 notes', 'Drafting', '#6B6456')
          + '</ul>'
          f'<div style="display: flex; align-items: center; gap: 8px; margin-top: 12px; {SUB}">{icon(I["cpu"], 14, "1.8", "#6B6456")}<span>Models: Coding model busy · 2 issues queued · next free about 25 min</span></div>'
          '</section>\n')
    s += '</div>\n'
    # flow strip
    s += (f'<section aria-label="Flow this sprint" style="display: flex; align-items: center; gap: 22px; padding: 10px 2px; border-top: 1px solid #E6E3DC; {SUB}">'
          '<span style="font-weight: 600; color: #1D1B17;">Flow this sprint</span>'
          '<span>Median cycle time <strong style="color: #1D1B17; font-weight: 600;">1.2 days</strong></span>'
          '<span>85% finish within <strong style="color: #1D1B17; font-weight: 600;">3 days</strong></span>'
          '<span>Throughput <strong style="color: #1D1B17; font-weight: 600;">4.5 a week</strong></span>'
          '<span>Sent back <strong style="color: #1D1B17; font-weight: 600;">2 of 14</strong></span>'
          '<span>Checks first-time pass <strong style="color: #1D1B17; font-weight: 600;">71%</strong></span>'
          '<div style="flex-grow: 1;"></div><a href="#" style="color: #2F6FB5;">Open Insights</a></section>\n')
    s += '</div>\n</main>\n</div>\n'
    s += foot(W, H)
    return s


if __name__ == '__main__':
    import sys
    out = sys.argv[1]
    open(out + '/Status.dc.html', 'w').write(build())
