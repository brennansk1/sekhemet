"""Bring the earlier boards (Board, Issue, Review, Configuration, Tips) up to the team design."""
from common import *
import os

SRC = os.path.join(os.path.dirname(__file__), 'src')
BADGE = ('<span title="AI teammate" style="margin-left: 5px; font-size: 10px; font-weight: 600; letter-spacing: 0.02em; color: #6B6456; '
         'border: 1px solid #D4CFC4; border-radius: 4px; padding: 0 4px; vertical-align: 1px;">AI</span>')


def read(name):
    return open(os.path.join(SRC, name + '.orig.html')).read()


def rep(s, a, b, count=1):
    n = s.count(a)
    assert n == count, (a[:80], n)
    return s.replace(a, b)


def board():
    return replace_sidebar(read('Main'), 'board')


def tips(main_html):
    s = main_html
    U = 'text-decoration: underline dotted #8C8577; text-underline-offset: 3px; text-decoration-thickness: 1px;'
    s = rep(s, '<title>Board</title>', '<title>Board · Tips on</title>')
    s = rep(s, '<div style="width: 1440px; height: 900px; display: flex;', '<div style="width: 1440px; height: 900px; position: relative; display: flex;')
    s = rep(s, '<button aria-pressed="false" style="display: flex; align-items: center; gap: 6px; border: 1px solid #D4CFC4; background: #FFFFFF; color: #5F584B; padding: 6px 10px; border-radius: 7px; font-size: 12.5px;">Tips</button>',
            '<button aria-pressed="true" style="display: flex; align-items: center; gap: 6px; border: 1px solid #1D1B17; background: #EFECE6; color: #1D1B17; padding: 6px 10px; border-radius: 7px; font-size: 12.5px; font-weight: 500;">'
            + icon(I['check'], 12, '2.4') + 'Tips</button>')
    s = rep(s, '<span style="font-weight: 600;">Sprint 3</span>', f'<span style="font-weight: 600; {U}">Sprint 3</span>')
    s = rep(s, '<span style="color: #5F584B;">Release 1</span>', f'<span style="color: #5F584B; {U}">Release 1</span>')
    s = rep(s, '<span style="color: #5F584B; font-size: 11.5px;" title="{{col.limitTitle}}">{{col.limit}}</span>',
            '<span style="color: #5F584B; font-size: 11.5px; ' + U + '" title="{{col.limitTitle}}">{{col.limit}}</span>')
    pop = ('<div role="dialog" aria-labelledby="tip-wip-h" style="position: absolute; left: 668px; top: 148px; width: 284px; background: #FFFFFF; border: 1px solid #DAD5CB; border-radius: 9px; box-shadow: 0 8px 24px rgba(29,27,23,0.12), 0 1px 3px rgba(29,27,23,0.08); padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; z-index: 5;">\n'
           '<span aria-hidden="true" style="position: absolute; top: -6px; right: 30px; width: 10px; height: 10px; background: #FFFFFF; border-left: 1px solid #DAD5CB; border-top: 1px solid #DAD5CB; transform: rotate(45deg);"></span>\n'
           '<div style="display: flex; align-items: center; gap: 8px;"><h3 id="tip-wip-h" style="margin: 0; font-size: 13px; font-weight: 600;">WIP limit</h3><span style="font-size: 12px; color: #6B6456;">Work in progress</span></div>\n'
           '<p style="margin: 0; font-size: 12.5px; line-height: 1.55; color: #2B2822;">The most issues this column may hold at once. Finishing work before starting more keeps issues moving and makes blockers visible. This column has 2 of 3.</p>\n'
           '<div style="display: flex; align-items: center; gap: 12px; font-size: 12px;"><a href="#" style="color: #2F6FB5;">Change the limit</a><div style="flex-grow: 1;"></div><span style="color: #8C8577;">Tips can be turned off in the header</span></div>\n'
           '</div>\n')
    s = rep(s, '</main>\n</div>\n</x-dc>', '</main>\n' + pop + '</div>\n</x-dc>')
    return s


def solo_board():
    s = replace_sidebar(read('Main'), 'board', account_open=True, solo=True)
    s = rep(s, '<title>Board</title>', '<title>Board · Solo, account menu</title>')
    return s


def issue():
    s = read('Issue')
    old_ai = ('<span style="width: 20px; height: 20px; border-radius: 10px; background: #1D1B17; color: #E2C07A; font-size: 9px; font-weight: 600; '
              'display: flex; align-items: center; justify-content: center; flex-shrink: 0;">AI</span>')
    s = rep(s, old_ai, agent_avatar(20), 2)
    s = rep(s, '<strong style="font-weight: 500;">Agent</strong> <span', '<strong style="font-weight: 500;">Agent</strong>' + BADGE + ' <span', 2)
    # header: presence + watch
    presence = ('<div style="display: flex; align-items: center; gap: 8px; margin-right: 6px;">'
                '<span title="Priya Nair is viewing" style="position: relative; display: inline-flex;">' + avatar('PN', 24) +
                '<span style="position: absolute; right: -1px; bottom: -1px; width: 8px; height: 8px; border-radius: 4px; background: #2E7D4A; border: 2px solid #FFFFFF;"></span></span>'
                '<span style="font-size: 12px; color: #6B6456;">Priya is viewing</span></div>'
                '<button aria-pressed="true" style="display: flex; align-items: center; gap: 6px; border: 1px solid #DAD5CB; background: #FFFFFF; color: #1D1B17; padding: 5px 10px; border-radius: 6px; font-size: 12.5px; margin-right: 4px;">'
                + icon(I['bell'], 14, '1.8') + 'Watching<span style="color: #6B6456;">3</span></button>\n')
    s = rep(s, '<button aria-label="Copy link"', presence + '<button aria-label="Copy link"')
    # activity: a teammate's comment and a Seshat suggestion before the live line
    priya = ('<li style="display: flex; gap: 10px;">' + avatar('PN', 20) +
             '<div style="display: flex; flex-direction: column; gap: 4px; flex-grow: 1;"><div style="font-size: 12.5px;"><strong style="font-weight: 500;">Priya Nair</strong> '
             '<span style="color: #6B6456;">Developer</span><span style="color: #A9A293; margin-left: 6px;">10:14</span></div>'
             '<div style="line-height: 1.6; color: #2B2822;"><a href="#" style="color: #2F6FB5; font-weight: 500;">@Agent</a> when <code>verify()</code> fails, include both the stored and the recomputed hash in the message. It saves a lookup when I review.</div></div></li>\n\n')
    seshat = ('<li style="display: flex; gap: 10px;">' + seshat_avatar(20) +
              '<div style="display: flex; flex-direction: column; gap: 8px; flex-grow: 1;"><div style="font-size: 12.5px;"><strong style="font-weight: 500;">Seshat</strong>' + BADGE +
              ' <span style="color: #6B6456;">suggested</span><span style="color: #A9A293; margin-left: 6px;">10:15</span></div>'
              '<div style="display: flex; align-items: center; gap: 12px; border-left: 2px solid #D4CFC4; padding: 2px 0 2px 12px;">'
              '<div style="flex-grow: 1; line-height: 1.55;"><div>Link <a href="#" style="font-family: \'JetBrains Mono\', monospace; font-size: 12px; color: #2F6FB5;">CHR-11</a> as related.</div>'
              '<div style="font-size: 12px; color: #6B6456;">Why: both change <code>verify()</code> in <code>src/ledger.ts</code>.</div></div>'
              '<button style="border: 1px solid #D4CFC4; background: #FFFFFF; color: #1D1B17; padding: 4px 10px; border-radius: 6px; font-size: 12px;">Apply</button>'
              '<button style="border: 0; background: transparent; color: #6B6456; padding: 4px 6px; font-size: 12px;">Dismiss</button></div></div></li>\n\n')
    live = '<li style="display: flex; gap: 10px; align-items: center; font-size: 12.5px; color: #6B6456;"><span style="width: 20px; display: flex; justify-content: center;"><span style="width: 8px; height: 8px; b'
    s = rep(s, live, priya + seshat + live)
    s = rep(s, 'The agent reads new comments at its next step.', 'Type @ to mention a person or the Agent. The Agent reads comments at its next step.')
    # properties
    old_assignee = s[s.index('<dt style="color: #6B6456;">Assignee</dt>'):]
    old_assignee = old_assignee[:old_assignee.index('</dd>') + 5]
    new_people = ('<dt style="color: #6B6456;">Owner</dt><dd style="margin: 0; display: flex; align-items: center; gap: 6px;">' + avatar('BK', 18) + 'Brennan Kelley</dd>\n'
                  '<dt style="color: #6B6456;">Delegate</dt><dd style="margin: 0; display: flex; align-items: center; gap: 6px;">' + agent_avatar(18) + 'Agent' + BADGE + '</dd>\n'
                  '<dt style="color: #6B6456;">Reviewer</dt><dd style="margin: 0; display: flex; align-items: center; gap: 6px;">' + avatar('PN', 18) + 'Priya Nair</dd>')
    s = rep(s, old_assignee, new_people)
    old_rep = s[s.index('<dt style="color: #6B6456;">Reporter</dt>'):]
    old_rep = old_rep[:old_rep.index('</dd>') + 5]
    s = rep(s, old_rep, '<dt style="color: #6B6456;">Reporter</dt><dd style="margin: 0; display: flex; align-items: center; gap: 6px;">' + avatar('DR', 18) + 'Dana Reyes</dd>')
    watchers = ('<dt style="color: #6B6456;">Watchers</dt><dd style="margin: 0; display: flex; align-items: center; gap: 0;">'
                + avatar('BK', 20) + '<span style="margin-left: -5px; display: inline-flex; border: 2px solid #FCFBF9; border-radius: 12px;">' + avatar('DR', 20) + '</span>'
                + '<span style="margin-left: -5px; display: inline-flex; border: 2px solid #FCFBF9; border-radius: 12px;">' + avatar('PN', 20) + '</span></dd>\n</dl>')
    s = rep(s, '</dl>\n</aside>', watchers + '\n</aside>')
    return s


def review():
    s = read('Review')
    old = '<button style="border: 1px solid #DAD5CB; background: #FFFFFF; color: #1D1B17; padding: 8px 0; border-radius: 7px; font-size: 13px;">Request changes</button>'
    new = ('<div style="display: flex; gap: 8px;"><button style="flex-grow: 1; border: 1px solid #DAD5CB; background: #FFFFFF; color: #1D1B17; padding: 8px 0; border-radius: 7px; font-size: 13px;">Request changes</button>'
           '<button style="flex-grow: 1; border: 1px solid #DAD5CB; background: #FFFFFF; color: #1D1B17; padding: 8px 0; border-radius: 7px; font-size: 13px;">Comment</button></div>')
    return rep(s, old, new)


def configuration():
    return read('Configuration')


def build(out):
    b = board()
    files = {'Main.dc.html': b, 'TipsBoard.dc.html': tips(b), 'SoloBoard.dc.html': solo_board(),
             'Issue.dc.html': issue(), 'Configuration.dc.html': configuration()}
    r = review()
    if '<nav aria-label="Main"' in r:
        r = replace_sidebar(r, 'review')
    files['Review.dc.html'] = r
    for k, v in files.items():
        open(os.path.join(out, k), 'w').write(v)


if __name__ == '__main__':
    import sys
    build(sys.argv[1])
