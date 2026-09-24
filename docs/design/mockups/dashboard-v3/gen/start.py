from common import *

SUB = 'font-size: 12px; color: #6B6456;'
H3 = 'margin: 0; font-size: 12.5px; font-weight: 600;'
BTN2 = 'border: 1px solid #D4CFC4; background: #FFFFFF; color: #1D1B17; padding: 6px 12px; border-radius: 7px; font-size: 12.5px;'
BTN1 = 'border: 0; background: #1D1B17; color: #FFFFFF; padding: 7px 14px; border-radius: 7px; font-size: 12.5px; font-weight: 500;'
TOP2 = ' style="flex-shrink: 0; margin-top: 3px;"'


def topbar(title, right=''):
    return ('<header style="height: 56px; display: flex; align-items: center; gap: 12px; padding: 0 24px; background: #FFFFFF; border-bottom: 1px solid #E6E3DC; flex-shrink: 0;">'
            f'{mark(22)}<div style="display: flex; align-items: center; gap: 8px; color: #5F584B;"><a href="Projects.dc.html">Projects</a><span aria-hidden="true">/</span>'
            f'<h1 style="margin: 0; font-size: 15px; font-weight: 600; color: #1D1B17;">{title}</h1></div><div style="flex-grow: 1;"></div>{right}'
            f'<a href="Projects.dc.html" aria-label="Close" style="width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; border-radius: 6px; color: #5F584B;">{icon(I["x"], 16, "2")}</a></header>\n')


def who(av, name, role, time):
    return (f'<div style="display: flex; align-items: center; gap: 8px; font-size: 12.5px;">{av}<strong style="font-weight: 600;">{name}</strong>'
            f'<span style="color: #6B6456;">{role}</span><span style="color: #A9A293;">· {time}</span></div>')


def entry(av, name, role, time, body):
    return (f'<li style="display: flex; flex-direction: column; gap: 6px;">{who(av, name, role, time)}'
            f'<div style="padding-left: 30px; display: flex; flex-direction: column; gap: 10px; line-height: 1.6; color: #2B2822;">{body}</div></li>\n')


def event(ic, text, time, col='#6B6456'):
    return (f'<li style="display: flex; align-items: center; gap: 10px; padding-left: 4px; font-size: 12.5px; color: #6B6456;">'
            f'<span style="width: 18px; display: flex; justify-content: center;">{icon(I[ic], 14, "2", col)}</span><span>{text}</span><span style="color: #A9A293;">· {time}</span></li>\n')


def opt(label, conseq, selected=False, rec=False):
    bd = '#1D1B17' if selected else '#DAD5CB'
    dot = ('<span style="width: 14px; height: 14px; border-radius: 7px; border: 4px solid #1D1B17; box-sizing: border-box; flex-shrink: 0; margin-top: 2px;"></span>' if selected
           else '<span style="width: 14px; height: 14px; border-radius: 7px; border: 1.5px solid #B7B0A2; box-sizing: border-box; flex-shrink: 0; margin-top: 2px;"></span>')
    r = ' <span style="font-size: 11.5px; color: #2E7D4A; font-weight: 500;">Recommended</span>' if rec else ''
    return (f'<label style="display: flex; gap: 10px; padding: 9px 12px; border: 1px solid {bd}; border-radius: 8px; cursor: pointer;">{dot}'
            f'<span style="display: flex; flex-direction: column; gap: 2px;"><span style="font-weight: 500; color: #1D1B17;">{label}{r}</span><span style="{SUB}">{conseq}</span></span></label>')


def cand(text, source, state, prio_line=False):
    if state == 'accepted':
        ctl = (f'<span style="display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: #2E7D4A;">{icon(I["check"], 13, "2.4", "#2E7D4A")}Accepted</span>')
    elif state == 'rejected':
        ctl = '<span style="font-size: 12px; color: #8C8577;">Removed</span>'
    else:
        ctl = (f'<span style="display: inline-flex; gap: 4px;"><button aria-label="Accept" style="width: 26px; height: 26px; border: 1px solid #D4CFC4; background: #FFFFFF; border-radius: 6px; display: flex; align-items: center; justify-content: center;">{icon(I["check"], 14, "2.2", "#2E7D4A")}</button>'
               f'<button aria-label="Remove" style="width: 26px; height: 26px; border: 1px solid #D4CFC4; background: #FFFFFF; border-radius: 6px; display: flex; align-items: center; justify-content: center;">{icon(I["x"], 13, "2.2", "#6B6456")}</button></span>')
    tc = '#8C8577; text-decoration: line-through' if state == 'rejected' else '#1D1B17'
    return (f'<li style="display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid #ECE9E3;">'
            f'<div style="flex-grow: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;"><span style="color: {tc}; line-height: 1.4;">{text}</span><span style="font-size: 11.5px; color: #8C8577;">{source}</span></div>{ctl}</li>')


def group(label, n):
    return f'<div style="display: flex; align-items: baseline; gap: 8px; margin-top: 14px;"><span style="font-size: 12px; font-weight: 600; color: #1D1B17;">{label}</span><span style="{SUB}">{n}</span></div>'


def release_line(text):
    return (f'<div role="separator" style="display: flex; align-items: center; gap: 8px; margin: 10px 0 0; font-size: 11.5px; color: #8E6512; font-weight: 500;">'
            f'<span style="flex-grow: 1; border-top: 1.5px dashed #8E6512;"></span>{icon(I["updown"], 12, "2", "#8E6512")}{text}<span style="flex-grow: 1; border-top: 1.5px dashed #8E6512;"></span></div>')


def build_start():
    W, H = 1440, 1000
    s = head('Start a project')
    s += f'<div style="width: {W}px; height: {H}px; display: flex; flex-direction: column; background: #FFFFFF; font-size: 13px; color: #1D1B17;">\n'
    s += topbar('New project', f'<span style="{SUB}">Draft saved</span>')
    s += '<div style="flex-grow: 1; display: flex; min-height: 0;">\n'
    # conversation
    s += '<section aria-label="Conversation with Seshat" style="flex-grow: 1; display: flex; justify-content: center; min-width: 0; background: #FFFFFF;">\n'
    s += '<div style="width: 700px; display: flex; flex-direction: column; padding: 26px 0 22px; gap: 16px;">\n'
    s += '<ol style="list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 18px; flex-grow: 1;">\n'
    s += entry(avatar('DR', 22), 'Dana Reyes', 'Operations', '10:02',
               'Our office lends out laptops, cameras and projectors. We track it in a spreadsheet and things go missing. I want a simple way to see who has what and when it’s due back.')
    s += entry(seshat_avatar(22), 'Seshat', 'Project manager', '10:02',
               '<span>I read this as an internal tool for one office of about 40 people: nothing public, no payments. I’d plan it as an <strong style="font-weight: 600;">Internal tool</strong>, so sign-in, backups and error handling are included, and launch and scale work are left out.</span>'
               '<div style="display: flex; gap: 8px;"><button style="' + BTN2 + '">Change type</button></div>')
    s += event('check', 'Dana confirmed the type: Internal tool', '10:03', '#2E7D4A')
    s += event('globe', 'Dana allowed research for this project. Only search terms leave this server.', '10:03')
    s += entry(seshat_avatar(22), 'Seshat', 'Project manager', '10:06',
               '<span>I looked at 5 comparable tools and 12 open-source libraries. Four of the five have check-out, check-in, due dates, overdue reminders and an item history, so I’ve put those on the list. Barcode scanning appears in two, so I’ve left it for later.</span>'
               f'<a href="#" style="display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: #2F6FB5;">{icon(I["link"], 13, "1.9")}17 sources</a>')
    q = ('<div style="border: 1px solid #E2DDD3; border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; background: #FFFFFF;">'
         f'<div style="display: flex; align-items: baseline; gap: 8px;"><strong style="font-weight: 600; color: #1D1B17;">How should people sign in?</strong><span style="{SUB}">Question 1 of 2</span></div>'
         '<div style="display: flex; flex-direction: column; gap: 6px;">'
         + opt('Company accounts (SSO)', 'Nobody manages passwords · adds 2 issues', True, True)
         + opt('Email and password', 'Needs password resets · adds 3 issues')
         + opt('No sign-in', 'Anyone on the office network can make changes')
         + '</div>'
         f'<div style="display: flex; align-items: center; gap: 10px;"><span style="{SUB} flex-grow: 1;">No answer by 4 pm: I’ll plan with company accounts and note it as an assumption.</span>'
         '<a href="#" style="font-size: 12.5px; color: #2F6FB5;">Use defaults for the rest</a></div></div>')
    s += entry(seshat_avatar(22), 'Seshat', 'Project manager', '10:06', q)
    s += '</ol>\n'
    s += ('<div style="border: 1px solid #D4CFC4; border-radius: 10px; display: flex; flex-direction: column;">'
          '<textarea aria-label="Message Seshat" rows="2" placeholder="Reply to Seshat, or @mention someone to bring them in…" style="border: 0; resize: none; padding: 12px 14px; font-size: 13px; outline: none; border-radius: 10px;"></textarea>'
          f'<div style="display: flex; align-items: center; gap: 8px; padding: 6px 8px 8px 12px;"><span style="{SUB} display: inline-flex; align-items: center; gap: 6px;">{icon(I["people"], 14, "1.8", "#6B6456")}Brennan Kelley can see this conversation</span><div style="flex-grow: 1;"></div>'
          f'<button style="{BTN1}">Send</button></div></div>\n')
    s += '</div>\n</section>\n'
    # brief panel
    s += '<aside aria-label="Project draft" style="width: 460px; flex-shrink: 0; border-left: 1px solid #E6E3DC; background: #FBFAF8; display: flex; flex-direction: column;">\n'
    s += ('<div style="padding: 18px 22px 0; display: flex; flex-direction: column; gap: 12px;">'
          f'<div style="display: flex; flex-direction: column; gap: 3px;"><span style="{SUB}">Draft · updates as you talk</span><h2 style="margin: 0; font-size: 18px; font-weight: 600;">Equipment loans</h2></div>'
          '<div role="tablist" aria-label="Draft" style="display: flex; gap: 18px; border-bottom: 1px solid #E6E3DC;">'
          '<button role="tab" aria-selected="false" style="border: 0; background: transparent; padding: 8px 0; font-size: 13px; color: #6B6456;">Brief</button>'
          '<button role="tab" aria-selected="true" style="border: 0; background: transparent; padding: 8px 0; font-size: 13px; color: #1D1B17; font-weight: 500; box-shadow: inset 0 -2px 0 #1D1B17;">Requirements <span style="color: #6B6456; font-weight: 400;">9</span></button>'
          '<button role="tab" aria-selected="false" style="border: 0; background: transparent; padding: 8px 0; font-size: 13px; color: #6B6456;">Plan</button></div></div>\n')
    s += '<div style="padding: 4px 22px 16px; flex-grow: 1; overflow: hidden;">\n'
    s += f'<p style="margin: 10px 0 0; {SUB} line-height: 1.5;">Accept what belongs in the project. Drag the line to choose what ships first.</p>'
    s += group('Must have', 5) + '<ul style="list-style: none; margin: 2px 0 0; padding: 0;">'
    s += cand('Check an item out to a person, with a due date', 'You said · 5 of 5 comparable tools', 'accepted')
    s += cand('Check an item back in', 'You said · 5 of 5 comparable tools', 'accepted')
    s += cand('See who has what, and what is overdue', 'You said', 'accepted')
    s += cand('Sign in', 'Internal tool checklist · method to be decided', 'accepted')
    s += cand('Nightly backup, restorable in one step', 'Internal tool checklist', 'open')
    s += '</ul>' + group('Should have', 2) + '<ul style="list-style: none; margin: 2px 0 0; padding: 0;">'
    s += cand('Email a reminder the day before an item is due', '4 of 5 comparable tools', 'open')
    s += cand('History of every loan for each item', '4 of 5 comparable tools', 'accepted')
    s += '</ul>' + release_line('Release 1 ends here') + group('Could have', 2) + '<ul style="list-style: none; margin: 2px 0 0; padding: 0;">'
    s += cand('Barcode scanning', '2 of 5 comparable tools', 'open')
    s += cand('Reservations in advance', '1 of 5 comparable tools', 'rejected')
    s += '</ul>\n</div>\n'
    s += ('<div style="padding: 14px 22px; border-top: 1px solid #E6E3DC; background: #FFFFFF; display: flex; align-items: center; gap: 10px;">'
          f'<span style="{SUB} flex-grow: 1;">Release 1: 7 requirements · about 18 issues · 2 to 3 weeks</span>'
          '<button disabled style="border: 0; background: #E6E2DA; color: #8C8577; padding: 7px 14px; border-radius: 7px; font-size: 12.5px; font-weight: 500; white-space: nowrap;">Review plan</button></div>\n')
    s += '</aside>\n</div>\n</div>\n'
    s += foot(W, H)
    return s


def dl_row(k, v):
    return f'<dt style="color: #6B6456;">{k}</dt><dd style="margin: 0; line-height: 1.55;">{v}</dd>'


def rel(name, when, body, issues, current=False):
    dot = '#1D1B17' if current else '#B7B0A2'
    return (f'<li style="display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 12px; padding: 12px 0; border-bottom: 1px solid #ECE9E3;">'
            f'<span style="width: 10px; height: 10px; border-radius: 5px; background: {dot}; margin-top: 4px;"></span>'
            f'<div style="display: flex; flex-direction: column; gap: 3px;"><span style="font-weight: 600;">{name}</span><span style="color: #2B2822; line-height: 1.5;">{body}</span></div>'
            f'<div style="display: flex; flex-direction: column; gap: 3px; align-items: flex-end; {SUB}"><span style="color: #1D1B17;">{when}</span><span>{issues}</span></div></li>')


def build_plan():
    W, H = 1440, 780
    s = head('Start a project · plan')
    s += f'<div style="width: {W}px; height: {H}px; display: flex; flex-direction: column; background: #F7F6F3; font-size: 13px; color: #1D1B17;">\n'
    s += topbar('New project', f'<span style="{SUB}">Draft saved</span>')
    s += '<div style="flex-grow: 1; display: flex; justify-content: center; min-height: 0; overflow: hidden;">\n'
    s += '<div style="width: 1080px; padding: 26px 0; display: flex; flex-direction: column; gap: 18px;">\n'
    s += ('<div style="display: flex; align-items: flex-end; gap: 16px;"><div style="display: flex; flex-direction: column; gap: 4px; flex-grow: 1;">'
          f'<span style="{SUB}">Plan by Seshat with Dana Reyes · ready for approval</span>'
          '<h2 style="margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.01em;">Equipment loans</h2>'
          '<div style="display: flex; gap: 8px; margin-top: 4px;">'
          '<span style="font-size: 12px; background: #EFECE6; border-radius: 5px; padding: 2px 8px;">Internal tool</span>'
          '<span style="font-size: 12px; background: #EFECE6; border-radius: 5px; padding: 2px 8px;">TypeScript · SQLite</span>'
          '<span style="font-size: 12px; background: #EFECE6; border-radius: 5px; padding: 2px 8px;">Key: LOAN</span></div></div>'
          f'<button style="{BTN2}">Keep talking</button><button style="{BTN1}">Send to Brennan for approval</button></div>\n')
    s += '<div style="display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 18px; align-items: start;">\n'
    # brief
    s += ('<section aria-labelledby="brief-h" style="background: #FFFFFF; border: 1px solid #E6E3DC; border-radius: 10px; padding: 18px 20px;">'
          f'<div style="display: flex; align-items: baseline; gap: 8px; margin-bottom: 12px;"><h3 id="brief-h" style="{H3}">Brief</h3><span style="{SUB}">saved as docs/product/brief.md</span><div style="flex-grow: 1;"></div><a href="#" style="font-size: 12px; color: #2F6FB5;">Edit</a></div>'
          '<dl style="margin: 0; display: grid; grid-template-columns: 136px minmax(0, 1fr); row-gap: 12px; column-gap: 12px;">'
          + dl_row('Problem', 'Equipment is lent from a spreadsheet; items go missing and nobody knows who has them.')
          + dl_row('Outcome', 'Anyone in the office can see who has an item and when it is due; overdue items are chased automatically.')
          + dl_row('Users', 'One office, about 40 people; 2 people run the equipment room.')
          + dl_row('Not in scope', 'Buying or retiring equipment; other offices; a phone app.')
          + dl_row('Constraints', 'Runs on the office server; company accounts for sign-in <span style="color: #9A4F1C;">(assumed — not answered)</span>.')
          + dl_row('Prior art', '5 comparable tools reviewed; reuse an MIT-licensed mail library for reminders. <a href="#" style="color: #2F6FB5;">Sources</a>')
          + dl_row('Riskiest assumption', 'People will record returns at the desk. First check: a week of use in Release 1.')
          + dl_row('Done means', 'The equipment room stops using the spreadsheet for a full month.')
          + '</dl></section>\n')
    # right column
    s += '<div style="display: flex; flex-direction: column; gap: 18px;">\n'
    s += ('<section aria-labelledby="rel-h" style="background: #FFFFFF; border: 1px solid #E6E3DC; border-radius: 10px; padding: 16px 20px 6px;">'
          f'<div style="display: flex; align-items: baseline; gap: 8px;"><h3 id="rel-h" style="{H3}">Releases</h3><span style="{SUB}">forecast from similar projects on this server</span></div>'
          '<ul style="list-style: none; margin: 4px 0 0; padding: 0;">'
          + rel('Release 1 · Loans and returns', 'in 2–3 weeks', 'Check out, check in, who has what, overdue list, sign-in, item history, backups.', '18 issues', True)
          + rel('Release 2 · Reminders', '+1 week', 'Reminder emails the day before an item is due; weekly overdue summary.', '6 issues')
          + rel('Later', '—', 'Barcode scanning.', 'not planned')
          + '</ul></section>\n')
    s += ('<section aria-labelledby="as-h" style="background: #FFFFFF; border: 1px solid #E6E3DC; border-radius: 10px; padding: 16px 20px;">'
          f'<div style="display: flex; align-items: baseline; gap: 8px;"><h3 id="as-h" style="{H3}">Assumptions</h3><span style="{SUB}">recorded on the issues they affect</span></div>'
          '<ul style="list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; line-height: 1.5;">'
          f'<li style="display: flex; gap: 10px;">{icon(I["warn"], 14, "1.9", "#9A4F1C", TOP2)}<span>Sign-in uses company accounts. Dana didn’t answer; this was the recommended default.</span></li>'
          f'<li style="display: flex; gap: 10px;">{icon(I["warn"], 14, "1.9", "#9A4F1C", TOP2)}<span>Loan history is kept for 2 years. Dana is checking with HR.</span></li>'
          '</ul></section>\n')
    s += ('<section aria-labelledby="cr-h" style="background: #FFFFFF; border: 1px solid #E6E3DC; border-radius: 10px; padding: 16px 20px;">'
          f'<div style="display: flex; align-items: baseline; gap: 8px;"><h3 id="cr-h" style="{H3}">What approval creates</h3></div>'
          '<ul style="list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; line-height: 1.5;">'
          f'<li style="display: flex; gap: 10px;">{icon(I["projects"], 14, "1.8", "#6B6456", TOP2)}<span>The project <strong style="font-weight: 600;">Equipment loans</strong> with 3 epics and 18 issues in Release 1</span></li>'
          f'<li style="display: flex; gap: 10px;">{icon(I["doc"], 14, "1.8", "#6B6456", TOP2)}<span>Brief and requirements in <span class="mono" style="font-size: 12px;">docs/product/</span></span></li>'
          f'<li style="display: flex; gap: 10px;">{icon(I["check"], 14, "2", "#6B6456", TOP2)}<span>First issue: set up the repository and its checks. The Agent can start straight away.</span></li>'
          '</ul>'
          f'<p style="margin: 12px 0 0; {SUB}">Nothing is created until someone who approves plans in Northwind approves this one.</p></section>\n')
    s += '</div>\n</div>\n</div>\n</div>\n</div>\n'
    s += foot(W, H)
    return s


if __name__ == '__main__':
    import sys
    out = sys.argv[1]
    open(out + '/Start.dc.html', 'w').write(build_start())
    open(out + '/StartPlan.dc.html', 'w').write(build_plan())
