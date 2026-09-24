from common import *
from existing import BADGE

SUB = 'font-size: 12px; color: #6B6456;'
H3 = 'margin: 0; font-size: 12.5px; font-weight: 600;'
BTN2 = 'border: 1px solid #D4CFC4; background: #FFFFFF; color: #1D1B17; padding: 6px 12px; border-radius: 7px; font-size: 12.5px;'
BTN1 = 'border: 0; background: #1D1B17; color: #FFFFFF; padding: 7px 14px; border-radius: 7px; font-size: 12.5px; font-weight: 500;'
TAB_ON = 'border: 0; background: transparent; padding: 10px 0; font-size: 13px; color: #1D1B17; font-weight: 500; box-shadow: inset 0 -2px 0 #1D1B17;'
TAB_OFF = 'border: 0; background: transparent; padding: 10px 0; font-size: 13px; color: #6B6456;'


def page_header(crumb, title, right):
    return ('<header style="display: flex; align-items: center; gap: 12px; padding: 0 28px; height: 56px; background: #FFFFFF; border-bottom: 1px solid #E6E3DC; flex-shrink: 0;">'
            f'<div style="display: flex; align-items: center; gap: 8px; color: #5F584B;"><span>{crumb}</span><span aria-hidden="true">/</span>'
            f'<h1 style="margin: 0; font-size: 15px; font-weight: 600; color: #1D1B17;">{title}</h1></div><div style="flex-grow: 1;"></div>{right}</header>\n')


def level_chip(level):
    return (f'<button style="display: inline-flex; align-items: center; gap: 6px; border: 1px solid #DAD5CB; background: #FFFFFF; color: #1D1B17; padding: 3px 8px; border-radius: 6px; font-size: 12.5px;">'
            f'{level}{icon(I["chevdown"], 12, "2", "#8C8577")}</button>')


def member(ini, name, email, level, labels, projects, accept, active, online=False):
    dot = ('<span style="position: absolute; right: -1px; bottom: -1px; width: 8px; height: 8px; border-radius: 4px; background: #2E7D4A; border: 2px solid #FFFFFF;"></span>' if online else '')
    lab = ' '.join(f'<span style="font-size: 12px; background: #F2F0EB; color: #3A362E; border-radius: 4px; padding: 1px 6px;">{l}</span>' for l in labels)
    acc = accept or '<span style="color: #A9A293;">—</span>'
    act = f'<span style="color: #2E7D4A;">{active}</span>' if online else active
    return (f'<tr style="border-bottom: 1px solid #ECE9E3;">'
            f'<td style="padding: 10px 16px;"><div style="display: flex; align-items: center; gap: 10px;"><span style="position: relative; display: inline-flex;">{avatar(ini, 28)}{dot}</span>'
            f'<div style="display: flex; flex-direction: column; gap: 1px;"><span style="font-weight: 500;">{name}</span><span style="{SUB}">{email}</span></div></div></td>'
            f'<td style="padding: 10px 16px;">{level_chip(level)}</td>'
            f'<td style="padding: 10px 16px;"><div style="display: flex; gap: 4px; flex-wrap: wrap;">{lab}</div></td>'
            f'<td style="padding: 10px 16px; color: #2B2822;">{projects}</td>'
            f'<td style="padding: 10px 16px; color: #2B2822;">{acc}</td>'
            f'<td style="padding: 10px 16px; {SUB} font-size: 12.5px;">{act}</td>'
            f'<td style="padding: 10px 12px; text-align: right;"><button aria-label="More" style="width: 28px; height: 28px; border: 0; background: transparent; border-radius: 6px; color: #6B6456;">{icon(I["more"], 16, "2.4")}</button></td></tr>')


def build_members():
    W, H = 1440, 900
    s = head('Members')
    s += f'<div style="width: {W}px; height: {H}px; display: flex; background: #F7F6F3; font-size: 13px; color: #1D1B17;">\n'
    s += sidebar('none')
    s += '<main style="flex-grow: 1; display: flex; flex-direction: column; min-width: 0;">\n'
    s += page_header('Northwind', 'Members', f'<button style="{BTN2}">Audit log</button><button style="{BTN1} display: inline-flex; align-items: center; gap: 6px;">{icon(I["plus"], 13, "2.2")}Invite people</button>')
    s += '<div style="padding: 0 28px; background: #FFFFFF; border-bottom: 1px solid #E6E3DC;"><div role="tablist" style="display: flex; gap: 22px;">'
    s += f'<button role="tab" aria-selected="true" style="{TAB_ON}">Members <span style="color: #6B6456; font-weight: 400;">6</span></button>'
    s += f'<button role="tab" aria-selected="false" style="{TAB_OFF}">Invites <span>2</span></button>'
    s += f'<button role="tab" aria-selected="false" style="{TAB_OFF}">Sign-in</button></div></div>\n'
    s += '<div style="padding: 20px 28px; display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 18px; align-items: start;">\n'
    th = 'text-align: left; padding: 9px 16px; font-size: 12px; font-weight: 500; color: #6B6456; border-bottom: 1px solid #E6E3DC;'
    s += ('<div style="display: flex; flex-direction: column; gap: 18px; min-width: 0;">'
          '<section aria-label="People" style="background: #FFFFFF; border: 1px solid #E6E3DC; border-radius: 10px; overflow: hidden;">'
          '<table style="width: 100%; border-collapse: collapse;"><thead><tr>'
          f'<th style="{th}">Name</th><th style="{th}">Access</th><th style="{th}">Labels</th><th style="{th}">Projects</th><th style="{th}">Can accept in</th><th style="{th}">Last active</th><th style="{th}"></th></tr></thead><tbody>'
          + member('BK', 'Brennan Kelley', 'brennan@northwind.dev', 'Admin', ['Project lead', 'Developer'], 'All 4', 'Chronicle, Website', 'Now', True)
          + member('PN', 'Priya Nair', 'priya@northwind.dev', 'Member', ['Developer', 'Reviewer'], '3', 'Chronicle, Billing', 'Now', True)
          + member('SO', 'Sam Ortiz', 'sam@northwind.dev', 'Member', ['Developer'], '2', 'Website', '1 h ago')
          + member('ML', 'Mei Lin', 'mei@northwind.dev', 'Member', ['Researcher'], '1', '', 'Yesterday')
          + member('DR', 'Dana Reyes', 'dana@northwind.dev', 'Stakeholder', ['Product owner'], '2', '', '12 min ago')
          + member('JT', 'Jordan Tate', 'jordan@northwind.dev', 'Viewer', ['Finance'], '1', '', '3 days ago')
          + '</tbody></table></section>\n')
    s += ('<section aria-labelledby="ai-h" style="background: #FFFFFF; border: 1px solid #E6E3DC; border-radius: 10px; padding: 14px 16px;">'
          f'<div style="display: flex; align-items: baseline; gap: 8px;"><h2 id="ai-h" style="{H3}">AI teammates</h2><span style="{SUB}">not members · no access level · no seat</span></div>'
          '<ul style="list-style: none; margin: 8px 0 0; padding: 0;">'
          f'<li style="display: flex; align-items: center; gap: 12px; padding: 9px 0; border-bottom: 1px solid #ECE9E3;">{seshat_avatar(28)}<div style="flex-grow: 1; display: flex; flex-direction: column; gap: 2px;"><span><span style="font-weight: 500;">Seshat</span>{BADGE} <span style="{SUB}">Project manager · Planning model</span></span>'
          f'<span style="{SUB}">Suggests; people apply. Auto-apply: off for every property</span></div><button style="{BTN2} padding: 4px 10px; font-size: 12px;">Settings</button></li>'
          f'<li style="display: flex; align-items: center; gap: 12px; padding: 9px 0;">{agent_avatar(28)}<div style="flex-grow: 1; display: flex; flex-direction: column; gap: 2px;"><span><span style="font-weight: 500;">Agent</span>{BADGE} <span style="{SUB}">Coding model</span></span>'
          f'<span style="{SUB}">Acts with the access of the person who starts it · 1 issue per person at a time</span></div><button style="{BTN2} padding: 4px 10px; font-size: 12px;">Settings</button></li>'
          '</ul></section></div>\n')
    # right: levels
    lv = [('Admin', 'Members, invites, models, configuration, the queue, audit log'),
          ('Member', 'Create and move issues, start and guide the Agent, review, approve plans'),
          ('Stakeholder', 'File issues, comment, talk to Seshat, start a project conversation, answer questions'),
          ('Viewer', 'Read and comment')]
    s += ('<aside style="display: flex; flex-direction: column; gap: 18px;">'
          '<section aria-labelledby="lv-h" style="background: #FFFFFF; border: 1px solid #E6E3DC; border-radius: 10px; padding: 14px 16px;">'
          f'<h2 id="lv-h" style="{H3}">Access levels</h2>'
          '<dl style="margin: 8px 0 0; display: flex; flex-direction: column;">'
          + ''.join(f'<div style="padding: 8px 0; border-bottom: 1px solid #ECE9E3; display: flex; flex-direction: column; gap: 2px;"><dt style="font-weight: 500;">{a}</dt><dd style="margin: 0; {SUB} line-height: 1.45;">{b}</dd></div>' for a, b in lv)
          + f'</dl><p style="margin: 10px 0 0; {SUB} line-height: 1.5;">Accepting work is set per project. Labels such as Developer or Product owner set a person’s home page, not what they can do.</p></section>'
          '<section aria-labelledby="si-h" style="background: #FFFFFF; border: 1px solid #E6E3DC; border-radius: 10px; padding: 14px 16px;">'
          f'<h2 id="si-h" style="{H3}">Sign-in</h2>'
          '<dl style="margin: 8px 0 0; display: grid; grid-template-columns: 110px minmax(0, 1fr); row-gap: 8px; font-size: 12.5px;">'
          '<dt style="color: #6B6456;">Company SSO</dt><dd style="margin: 0;">On · levels set here</dd>'
          '<dt style="color: #6B6456;">Passkeys</dt><dd style="margin: 0;">On</dd>'
          '<dt style="color: #6B6456;">Passwords</dt><dd style="margin: 0;">On · 15 characters minimum</dd>'
          '<dt style="color: #6B6456;">Open sign-up</dt><dd style="margin: 0;">Off · invite links only</dd>'
          '<dt style="color: #6B6456;">Sessions</dt><dd style="margin: 0;">1 h idle · 24 h total</dd>'
          '</dl></section></aside>\n')
    s += '</div>\n</main>\n</div>\n'
    s += foot(W, H)
    return s


def inbox_item(ic_html, key, title, reason, time, selected=False, unread=True):
    bg = 'background: #EFECE6;' if selected else ''
    dot = '<span style="width: 6px; height: 6px; border-radius: 3px; background: #2F6FB5; flex-shrink: 0;"></span>' if unread else '<span style="width: 6px; flex-shrink: 0;"></span>'
    fw = 'font-weight: 500;' if unread else ''
    return (f'<li style="display: flex; gap: 10px; align-items: flex-start; padding: 10px 14px; border-radius: 8px; {bg}">{dot}{ic_html}'
            f'<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;"><span style="{fw} line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{title}</span>'
            f'<span style="{SUB}"><span class="mono" style="font-size: 11.5px;">{key}</span> · {reason}</span></div><span style="{SUB} flex-shrink: 0;">{time}</span></li>')


def group(label, n):
    return f'<li style="padding: 12px 14px 4px; font-size: 11.5px; font-weight: 600; color: #6B6456;">{label} <span style="font-weight: 400;">{n}</span></li>'


def build_inbox():
    W, H = 1440, 900
    s = head('Inbox')
    s += f'<div style="width: {W}px; height: {H}px; display: flex; background: #F7F6F3; font-size: 13px; color: #1D1B17;">\n'
    s += sidebar('inbox')
    s += '<main style="flex-grow: 1; display: flex; min-width: 0;">\n'
    # list
    s += ('<section aria-label="Inbox" style="width: 460px; flex-shrink: 0; background: #FFFFFF; border-right: 1px solid #E6E3DC; display: flex; flex-direction: column;">'
          '<header style="height: 56px; display: flex; align-items: center; gap: 10px; padding: 0 16px 0 20px; border-bottom: 1px solid #E6E3DC;">'
          '<h1 style="margin: 0; font-size: 15px; font-weight: 600;">Inbox</h1><div style="flex-grow: 1;"></div>'
          '<div role="tablist" style="display: flex; gap: 2px; background: #F2F0EB; border-radius: 7px; padding: 2px;">'
          '<button role="tab" aria-selected="true" style="border: 0; background: #FFFFFF; color: #1D1B17; padding: 3px 10px; border-radius: 5px; font-size: 12px; font-weight: 500; box-shadow: 0 1px 2px rgba(29,27,23,0.08);">All</button>'
          '<button role="tab" aria-selected="false" style="border: 0; background: transparent; color: #5F584B; padding: 3px 10px; border-radius: 5px; font-size: 12px;">Saved</button>'
          '<button role="tab" aria-selected="false" style="border: 0; background: transparent; color: #5F584B; padding: 3px 10px; border-radius: 5px; font-size: 12px;">Done</button></div></header>'
          '<ul style="list-style: none; margin: 0; padding: 6px 6px; display: flex; flex-direction: column; overflow: hidden;">'
          + group('Needs you', 3)
          + inbox_item(icon(I['review'], 15, '2', '#1D1B17', TOPI), 'CHR-6', 'Review: Verify the whole hash chain on start', 'ready for your review', '2 h')
          + inbox_item(agent_avatar(18), 'CHR-7', 'Stream the ledger or load it whole?', 'the Agent asked you', '20 min')
          + inbox_item(avatar('DR', 18), 'LOAN', 'Approve the plan for Equipment loans', 'Dana sent it for your approval', '1 h')
          + group('Mentioned', 1)
          + inbox_item(avatar('PN', 18), 'CHR-9', 'Priya mentioned you on Export loans as CSV', 'mentioned', '35 min', selected=True)
          + group('Agent finished', 2)
          + inbox_item(agent_avatar(18), 'CHR-12', 'Late-return fees is ready for review', 'you started it · checks passed', '1 h')
          + inbox_item(agent_avatar(18), 'BIL-31', 'Round invoice totals per line: checks failed', 'you started it · 2 of 6 criteria', '3 h')
          + group('Watching', 2)
          + inbox_item(icon(I['status'], 15, '1.8', '#6B6456', TOPI), 'Chronicle', 'Project update posted: On track', 'Brennan Kelley', 'Mon', unread=False)
          + inbox_item(icon(I['check'], 15, '2', '#2E7D4A', TOPI), 'CHR-8', 'Overdue items are listed first was accepted', 'accepted by Dana Reyes', 'Mon', unread=False)
          + '</ul></section>\n')
    # detail
    s += '<section aria-label="Selected" style="flex-grow: 1; display: flex; flex-direction: column; min-width: 0;">'
    s += ('<header style="height: 56px; display: flex; align-items: center; gap: 10px; padding: 0 24px; background: #FFFFFF; border-bottom: 1px solid #E6E3DC;">'
          '<span style="display: flex; align-items: center; gap: 8px; color: #5F584B;">Chronicle<span aria-hidden="true">/</span><span class="mono" style="color: #1D1B17; font-size: 12.5px;">CHR-9</span></span>'
          '<div style="flex-grow: 1;"></div>'
          f'<button style="{BTN2} display: inline-flex; align-items: center; gap: 6px;">{icon(I["clock"], 14, "1.8")}Snooze</button>'
          f'<button style="{BTN2}">Save</button>'
          f'<button style="{BTN1} display: inline-flex; align-items: center; gap: 6px;">{icon(I["check"], 13, "2.4")}Done</button></header>')
    s += '<div style="padding: 26px 32px; display: flex; flex-direction: column; gap: 18px; max-width: 760px;">'
    s += ('<div style="display: flex; flex-direction: column; gap: 6px;"><h2 style="margin: 0; font-size: 18px; font-weight: 600;">Export loans as CSV</h2>'
          f'<span style="{SUB}">In review · owner Priya Nair · delegate Agent · Release 1</span></div>')
    s += ('<ol style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 16px;">'
          f'<li style="display: flex; gap: 10px; align-items: center; font-size: 12.5px; color: #6B6456;"><span style="width: 20px; display: flex; justify-content: center;">{icon(I["check"], 14, "2", "#2E7D4A")}</span><span>Checks passed on all 5 criteria</span><span style="color: #A9A293;">· 10:02</span></li>'
          f'<li style="display: flex; gap: 10px;">{avatar("PN", 20)}<div style="display: flex; flex-direction: column; gap: 4px;"><div style="font-size: 12.5px;"><strong style="font-weight: 500;">Priya Nair</strong> <span style="color: #6B6456;">Developer</span><span style="color: #A9A293; margin-left: 6px;">10:40</span></div>'
          '<div style="line-height: 1.6; color: #2B2822; background: #FDF6E8; border-radius: 6px; padding: 8px 10px; margin-left: -10px;"><a href="#" style="color: #2F6FB5; font-weight: 500;">@Brennan Kelley</a> the export includes returned items by default. Finance wanted only open loans. Keep it, or switch the default? The Agent can change it either way.</div></div></li>'
          '</ol>')
    s += ('<div style="border: 1px solid #D4CFC4; border-radius: 10px; background: #FFFFFF; display: flex; flex-direction: column;">'
          '<textarea aria-label="Reply" rows="3" placeholder="Reply to Priya…" style="border: 0; resize: none; padding: 12px 14px; font-size: 13px; outline: none; border-radius: 10px;"></textarea>'
          f'<div style="display: flex; align-items: center; gap: 8px; padding: 6px 8px 8px 14px;"><span style="{SUB}">Type @ to mention a person or the Agent</span><div style="flex-grow: 1;"></div>'
          f'<a href="Issue.dc.html" style="font-size: 12.5px; color: #2F6FB5; margin-right: 8px;">Open issue</a><button style="{BTN2}">Reply</button></div></div>')
    s += '</div></section>\n'
    s += '</main>\n</div>\n'
    s += foot(W, H)
    return s


TOPI = ' style="flex-shrink: 0; margin-top: 1px;"'

if __name__ == '__main__':
    import sys
    out = sys.argv[1]
    open(out + '/Members.dc.html', 'w').write(build_members())
    open(out + '/Inbox.dc.html', 'w').write(build_inbox())
