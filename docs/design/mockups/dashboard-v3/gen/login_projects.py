from common import *

SUB = 'font-size: 12px; color: #6B6456;'
H3 = 'margin: 0; font-size: 12.5px; font-weight: 600;'
BTN2 = 'border: 1px solid #D4CFC4; background: #FFFFFF; color: #1D1B17; padding: 6px 12px; border-radius: 7px; font-size: 12.5px;'
BTN1 = 'border: 0; background: #1D1B17; color: #FFFFFF; padding: 7px 14px; border-radius: 7px; font-size: 12.5px; font-weight: 500;'
INPUT = 'height: 38px; border: 1px solid #B7B0A2; border-radius: 8px; padding: 0 12px; font-size: 13.5px; background: #FFFFFF; color: #1D1B17; outline: none;'


def build_login():
    W, H = 1440, 900
    s = head('Sign in')
    s += f'<div style="width: {W}px; height: {H}px; display: flex; flex-direction: column; align-items: center; background: #F7F6F3; font-size: 13px; color: #1D1B17;">\n'
    s += '<div style="flex-grow: 1;"></div>\n'
    s += (f'<div style="display: flex; flex-direction: column; align-items: center; gap: 12px; margin-bottom: 26px;">{mark(40)}'
          '<h1 style="margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.01em;">Sign in to Northwind</h1>'
          f'<span style="{SUB} font-size: 13px;">sekhemet.northwind.internal</span></div>\n')
    s += '<main style="width: 380px; background: #FFFFFF; border: 1px solid #E6E3DC; border-radius: 12px; padding: 26px 28px; box-sizing: border-box; display: flex; flex-direction: column; gap: 16px;">\n'
    s += (f'<button style="height: 40px; border: 1px solid #B7B0A2; background: #FFFFFF; color: #1D1B17; border-radius: 8px; font-size: 13.5px; font-weight: 500; display: flex; align-items: center; justify-content: center; gap: 10px;">'
          f'{icon(I["globe"], 16, "1.8")}Continue with company SSO</button>\n'
          f'<button style="height: 40px; border: 1px solid #B7B0A2; background: #FFFFFF; color: #1D1B17; border-radius: 8px; font-size: 13.5px; font-weight: 500; display: flex; align-items: center; justify-content: center; gap: 10px;">'
          f'{icon(I["key"], 16, "1.8")}Sign in with a passkey</button>\n')
    s += ('<div style="display: flex; align-items: center; gap: 12px; color: #8C8577; font-size: 12px;"><span style="flex-grow: 1; height: 1px; background: #E6E3DC;"></span>or<span style="flex-grow: 1; height: 1px; background: #E6E3DC;"></span></div>\n')
    s += ('<form style="display: flex; flex-direction: column; gap: 14px;" onsubmit="return false">'
          f'<label style="display: flex; flex-direction: column; gap: 6px;"><span style="font-weight: 500;">Email</span><input type="email" value="brennan@northwind.dev" autocomplete="username" style="{INPUT}"></label>'
          f'<label style="display: flex; flex-direction: column; gap: 6px;"><span style="display: flex;"><span style="font-weight: 500; flex-grow: 1;">Password</span><a href="#" style="font-size: 12.5px; color: #2F6FB5;">Forgot password?</a></span>'
          f'<input type="password" value="••••••••••••" autocomplete="current-password" style="{INPUT}"></label>'
          f'<button type="submit" style="{BTN1} height: 40px; font-size: 13.5px;">Sign in</button></form>\n')
    s += '</main>\n'
    s += (f'<p style="margin: 18px 0 0; {SUB} font-size: 12.5px;">New to Northwind? Ask an admin for an invite link.</p>\n')
    s += '<div style="flex-grow: 1;"></div>\n'
    s += (f'<footer style="padding: 18px; display: flex; gap: 16px; {SUB}"><span>Sekhemet 1.0 · self-hosted</span><span style="display: inline-flex; align-items: center; gap: 5px;">{icon(I["lock"], 12, "1.9", "#6B6456")}Your code and data stay on this server</span></footer>\n')
    s += '</div>\n'
    s += foot(W, H)
    return s


def proj_row(ini, bg, name, lead_ini, lead, health, hcol, hbg, release, prog, due, waiting, agent):
    bar = (f'<div style="display: flex; align-items: center; gap: 8px;"><div style="width: 96px; height: 5px; border-radius: 3px; background: #EFECE6; overflow: hidden;">'
           f'<div style="width: {prog}%; height: 100%; background: #2E7D4A;"></div></div><span style="{SUB}">{prog}%</span></div>')
    w = (f'<span style="font-weight: 600; color: #9A4F1C;">{waiting}</span>' if waiting else '<span style="color: #A9A293;">—</span>')
    return (f'<tr style="border-bottom: 1px solid #ECE9E3;">'
            f'<td style="padding: 12px 16px;"><a href="Status.dc.html" style="display: flex; align-items: center; gap: 10px;"><span style="width: 22px; height: 22px; border-radius: 5px; background: {bg}; color: #FFFFFF; font-size: 10px; font-weight: 600; display: flex; align-items: center; justify-content: center;">{ini}</span><span style="font-weight: 500;">{name}</span></a></td>'
            f'<td style="padding: 12px 16px;"><span style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: {hcol}; background: {hbg}; border-radius: 5px; padding: 2px 8px;"><span style="width: 6px; height: 6px; border-radius: 3px; background: {hcol};"></span>{health}</span></td>'
            f'<td style="padding: 12px 16px;"><div style="display: flex; flex-direction: column; gap: 5px;"><span>{release}</span>{bar}</div></td>'
            f'<td style="padding: 12px 16px;">{due}</td>'
            f'<td style="padding: 12px 16px; text-align: right;">{w}</td>'
            f'<td style="padding: 12px 16px; color: #5F584B;">{agent}</td>'
            f'<td style="padding: 12px 16px;"><span style="display: flex; align-items: center; gap: 8px;">{avatar(lead_ini, 22)}{lead}</span></td></tr>')


def build_projects():
    W, H = 1440, 900
    s = head('Projects')
    s += f'<div style="width: {W}px; height: {H}px; display: flex; background: #F7F6F3; font-size: 13px; color: #1D1B17;">\n'
    s += sidebar('projects')
    s += '<main style="flex-grow: 1; display: flex; flex-direction: column; min-width: 0;">\n'
    s += ('<header style="display: flex; align-items: center; gap: 12px; padding: 0 28px; height: 56px; background: #FFFFFF; border-bottom: 1px solid #E6E3DC; flex-shrink: 0;">'
          '<div style="display: flex; align-items: center; gap: 8px; color: #5F584B;"><span>Northwind</span><span aria-hidden="true">/</span><h1 style="margin: 0; font-size: 15px; font-weight: 600; color: #1D1B17;">Projects</h1></div>'
          '<div style="flex-grow: 1;"></div>'
          f'<button style="{BTN2}">Import</button>'
          f'<a href="Start.dc.html" style="{BTN1} display: inline-flex; align-items: center; gap: 6px;">{icon(I["plus"], 13, "2.2")}New project</a></header>\n')
    s += '<div style="padding: 22px 28px; display: flex; flex-direction: column; gap: 18px;">\n'
    # attention strip
    s += ('<div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); background: #FFFFFF; border: 1px solid #E6E3DC; border-radius: 10px;">'
          + ''.join(
              f'<div style="padding: 14px 18px; {"" if i == 0 else "border-left: 1px solid #ECE9E3;"} display: flex; flex-direction: column; gap: 3px;"><span style="{SUB}">{a}</span>'
              f'<span style="font-size: 22px; font-weight: 600; color: {c};">{b}</span><span style="{SUB}">{d}</span></div>'
              for i, (a, b, d, c) in enumerate([
                  ('Waiting on you', '5', 'across 3 projects · oldest 1 d', '#9A4F1C'),
                  ('Active projects', '4', '1 at risk', '#1D1B17'),
                  ('Shipped this month', '3 releases', '41 issues accepted', '#1D1B17'),
                  ('Agent time today', '6.2 h', '23 issues worked · 2 queued', '#1D1B17')]))
          + '</div>\n')
    # table
    th = 'text-align: left; padding: 9px 16px; font-size: 12px; font-weight: 500; color: #6B6456; border-bottom: 1px solid #E6E3DC;'
    s += ('<section aria-labelledby="pl-h" style="background: #FFFFFF; border: 1px solid #E6E3DC; border-radius: 10px; overflow: hidden;">'
          '<div style="display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #E6E3DC;">'
          f'<h2 id="pl-h" style="{H3}">All projects</h2>'
          '<div role="tablist" aria-label="Filter" style="display: flex; gap: 2px; background: #F2F0EB; border-radius: 7px; padding: 2px;">'
          '<button role="tab" aria-selected="true" style="border: 0; background: #FFFFFF; color: #1D1B17; padding: 3px 10px; border-radius: 5px; font-size: 12px; font-weight: 500; box-shadow: 0 1px 2px rgba(29,27,23,0.08);">Active</button>'
          '<button role="tab" aria-selected="false" style="border: 0; background: transparent; color: #5F584B; padding: 3px 10px; border-radius: 5px; font-size: 12px;">Mine</button>'
          '<button role="tab" aria-selected="false" style="border: 0; background: transparent; color: #5F584B; padding: 3px 10px; border-radius: 5px; font-size: 12px;">Archived</button></div>'
          '<div style="flex-grow: 1;"></div>'
          f'<label style="display: flex; align-items: center; gap: 8px; border: 1px solid #D4CFC4; border-radius: 7px; padding: 5px 10px; width: 220px; color: #6B6456;">{icon(I["search"], 14)}<span style="font-size: 12.5px;">Filter projects</span></label></div>'
          '<table style="width: 100%; border-collapse: collapse;"><thead><tr>'
          f'<th style="{th}">Project</th><th style="{th}">Health</th><th style="{th}">Current release</th><th style="{th}">Forecast</th><th style="{th} text-align: right;">Waiting on you</th><th style="{th}">Agent</th><th style="{th}">Lead</th></tr></thead><tbody>'
          + proj_row('CH', '#2F6FB5', 'Chronicle', 'BK', 'Brennan Kelley', 'On track', '#2E7D4A', '#EEF6F0', 'Release 1 · Loans and returns', 58, 'Oct 3–7 <span style="color: #6B6456;">· target Oct 5</span>', 3, 'Working on CHR-7')
          + proj_row('LO', '#8E6512', 'Equipment loans', 'DR', 'Dana Reyes', 'Planning', '#6B6456', '#F2F0EB', 'Plan awaiting approval', 0, '—', 1, 'Idle')
          + proj_row('BI', '#6B4FA0', 'Billing export', 'PN', 'Priya Nair', 'At risk', '#9A4F1C', '#FDF6E8', 'Release 3 · Invoices to CSV', 72, 'Oct 12–16 <span style="color: #9A4F1C;">· target Oct 10</span>', 1, '2 queued')
          + proj_row('WS', '#2E7D4A', 'Website', 'SO', 'Sam Ortiz', 'On track', '#2E7D4A', '#EEF6F0', 'Release 2 · Accessibility fixes', 35, 'Oct 17–22 <span style="color: #6B6456;">· target Oct 24</span>', 0, 'Idle')
          + '</tbody></table></section>\n')
    # bottom: waiting on you + models
    s += '<div style="display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 18px;">\n'
    rows = [('CHR-6', 'Chronicle', 'Review: Verify the whole hash chain on start', '2 h', 'Review'),
            ('CHR-7', 'Chronicle', 'The Agent asks: stream the ledger or load it whole?', '20 min', 'Answer'),
            ('LOAN', 'Equipment loans', 'Approve the plan Dana made with Seshat', '1 h', 'Open plan'),
            ('BIL-31', 'Billing export', 'Review: Round invoice totals per line', '1 d', 'Review')]
    s += (f'<section aria-labelledby="wy-h" style="background: #FFFFFF; border: 1px solid #E6E3DC; border-radius: 10px; padding: 14px 18px;">'
          f'<div style="display: flex; align-items: baseline; gap: 8px;"><h2 id="wy-h" style="{H3}">Waiting on you</h2><span style="{SUB}">5 · oldest first</span><div style="flex-grow: 1;"></div><a href="#" style="font-size: 12px; color: #2F6FB5;">Open Inbox</a></div>'
          '<ul style="list-style: none; margin: 4px 0 0; padding: 0;">'
          + ''.join(f'<li style="display: flex; align-items: center; gap: 12px; padding: 9px 0; border-bottom: 1px solid #ECE9E3;"><span class="mono" style="font-size: 11.5px; color: #6B6456; width: 52px;">{k}</span>'
                    f'<span style="flex-grow: 1;">{t} <span style="{SUB}">· {p}</span></span><span style="{SUB}">{a}</span>'
                    f'<button style="{BTN2} padding: 4px 10px; font-size: 12px;">{b}</button></li>' for k, p, t, a, b in rows)
          + '</ul></section>\n')
    s += (f'<section aria-labelledby="md-h" style="background: #FFFFFF; border: 1px solid #E6E3DC; border-radius: 10px; padding: 14px 18px;">'
          f'<div style="display: flex; align-items: baseline; gap: 8px;"><h2 id="md-h" style="{H3}">Models on this server</h2><span style="{SUB}">2 × 80 GB GPU</span><div style="flex-grow: 1;"></div><a href="Configuration.dc.html" style="font-size: 12px; color: #2F6FB5;">Configuration</a></div>'
          '<ul style="list-style: none; margin: 6px 0 0; padding: 0;">'
          + ''.join(f'<li style="display: grid; grid-template-columns: 110px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid #ECE9E3;"><span style="color: #6B6456;">{r}</span>'
                    f'<span>{m}</span><span style="font-size: 12px; color: {c};">{st}</span></li>'
                    for r, m, st, c in [('Coding model', 'Busy · Chronicle CHR-7', '2 queued', '#2F6FB5'),
                                         ('Planning model', 'Ready · shared by 4 people', '41 tok/s', '#2E7D4A'),
                                         ('Review model', 'Ready', '38 tok/s', '#2E7D4A')])
          + '</ul>'
          f'<div style="margin-top: 10px; display: flex; align-items: center; gap: 10px; {SUB}"><div style="flex-grow: 1; height: 6px; border-radius: 3px; background: #EFECE6; overflow: hidden;"><div style="width: 71%; height: 100%; background: #5F584B;"></div></div>GPU memory 114 of 160 GB</div>'
          '</section>\n')
    s += '</div>\n</div>\n</main>\n</div>\n'
    s += foot(W, H)
    return s


if __name__ == '__main__':
    import sys
    out = sys.argv[1]
    open(out + '/Login.dc.html', 'w').write(build_login())
    open(out + '/Projects.dc.html', 'w').write(build_projects())
