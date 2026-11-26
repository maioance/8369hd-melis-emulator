"""Build a VolumeBar.data (volume popup) for firmwares that ship without one (8369HD).

init.axf already has the CVolumeBar app: it loads Data\\VolumeBar.data at start-up (message 1140),
shows ViewShowWndVolumeBar when the volume changes and hides it again after a timeout. Handlers
(name table at 0xe928a340 in the 8369HD init.axf):
  window  ViewShowWndVolumeBar  0xe918ab84 (visibility + auto-hide)
  slider  ViewShowSliderVolume  0xe918a850
  label   ViewShowStrVolume     0xe918a956
The popup is the backlight row of the display settings page (SetupVideo.data): row background,
slider and value label, renamed to the volume handler names and moved into a small window.
The row caption is inline Chinese text that the app translates through Language\\VolumeBar.txt
(same format as Language\\Setup.txt); --lang writes that file from Setup.txt's volume entry.

With --panel H the window becomes a full-width strip of height H at --y with a generated opaque
background (window field +0xe4 = background image index), so it can cover the status bar.

usage: build_volume_bar.py <SetupVideo.data> <out VolumeBar.data> [--y 470]
                           [--panel 70 [--width 1024] [--color 10,16,18] [--alpha 255] [--line 26,140,140]]
                           [--row-line] [--effect 0] [--icon volume.png] [--lang <Setup.txt> <out VolumeBar.txt>]
--icon draws a PNG in place of the "Volume" caption (into the row background image); with --icon-muted too
it becomes a ViewShowImageMute control that the firmware switches to the second picture while muted.
--row-line keeps the thin separator line under the row (removed by default).
"""
import os
import struct
import sys
import zlib
from uidata import UiData, Window, U, I, rec_name, set_name

ROW, SLIDER, LABEL = '', 'ViewShowSliderVmBackLight', 'ViewShowStrVmBackLight'
CAPTION_OFF = 0x1ec          # inline UTF-16 caption inside the row record
LABEL_RECT = 0x19c           # x, y, w, h of a string record
OLD_CAPTION, NEW_CAPTION = '背光：', '音量'
# In the settings row the caption is centred on the row but the bar sits 4 px and the value 8 px
# lower (measured on the rendered row); shift them so all three share the row's centre line.
SLIDER_DY, LABEL_DY = -4, -8
# The caption is followed by 81 px of space before the bar but the bar by only 45 px before the
# value: move the caption right so both gaps are 45 px, and the whole row right so the visible
# group (caption .. two-digit value) is centred again.
CAPTION_RECT = 0x118 + LABEL_RECT   # rect of the caption string record nested in the row record
CAPTION_DX, GROUP_DX = 41, 31
WND_EFFECT = 0x1c4                  # window show effect: 0 none; the settings pages use 2 (slide in)


def panel_image(w, h, rgb=(10, 16, 18), alpha=255, line=None):
    """Image blob in the UI format: 0x20 header, zlib payload of RGB565 + alpha rows (4-byte aligned)."""
    px = lambda c, a: struct.pack('<HB', ((c[0] >> 3) << 11) | ((c[1] >> 2) << 5) | (c[2] >> 3), a)
    stride = (w * 3 + 3) & ~3
    rows = []
    for y in range(h):
        row = (px(line, 255) if line and y >= h - 2 else px(rgb, alpha)) * w  # optional 2 px bottom line
        rows.append(row + b'\0' * (stride - len(row)))
    payload = zlib.compress(b''.join(rows), 9)
    # header: size, width, height, two format fields (3, 3 = RGB565+A), payload pointer (fixed by build), 8 bytes
    return struct.pack('<IIIIII', 0x20, w, h, 3, 3, 0) + bytes.fromhex('0100000000000000') + payload


def image_blob(im):
    """PIL RGBA image -> UI image blob (RGB565 + 5-bit alpha 0..31, rows padded to 4 bytes)"""
    w, h = im.size
    raw = im.convert('RGBA').tobytes()
    stride = (w * 3 + 3) & ~3
    rows = bytearray()
    for y in range(h):
        row = bytearray()
        for x in range(w):
            r, g, b, a = raw[(y * w + x) * 4:(y * w + x) * 4 + 4]
            row += struct.pack('<HB', ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3), (a * 31 + 127) // 255)
        rows += row + b'\0' * (stride - len(row))
    return struct.pack('<IIIIII', 0x20, w, h, 3, 3, 0) + bytes.fromhex('0100000000000000') + zlib.compress(bytes(rows), 9)


ICON_GAP = 45   # icon -> bar, same as bar -> value
# Speaker icon as ViewShowImageMute: CVolumeBar (handler 0xe918a634) switches it to state 'm' (109) while
# muted or at volume 0 and 'u' (117) otherwise. The record is a two-image control cloned from
# AirCondition.data (ViewShowImageInCycle): +0xe4 current code, +0xf0 image count, (code, image) pairs at +0x100.
MUTE_TEMPLATE = ('AirCondition.data', 'ViewShowImageInCycle')
CODE_UNMUTED, CODE_MUTED = 117, 109


def mute_record(template_data, img_unmuted, img_muted, x, y, w, h):
    t = UiData(open(template_data, 'rb').read())
    tw, tb = t.windows[0]
    rel = next(r for _, r in tw.children(tb) if rec_name(tw.raw, r) == MUTE_TEMPLATE[1])
    rec = bytearray(tw.raw[rel:rel + U(tw.raw, rel)])
    set_name(rec, 0, 'ViewShowImageMute')
    struct.pack_into('<iiII', rec, 0xd4, x, y, w, h)
    struct.pack_into('<I', rec, 0xe4, CODE_UNMUTED)
    struct.pack_into('<IIII', rec, 0x100, CODE_UNMUTED, img_unmuted, CODE_MUTED, img_muted)
    return bytes(rec)


def main(src, out, y=470, panel=0, width=0, color=(10, 16, 18), alpha=255, line=None, row_line=False, effect=0,
         icon=None, icon_muted=None):
    u = UiData(open(src, 'rb').read())
    w, base = u.windows[0]
    kids = w.children(base)
    # the backlight row: last (t4 row, t2 slider, t0 label) triple of the settings window
    names = [(t, rec_name(w.raw, rel)) for t, rel in kids[-3:]]
    assert names == [(4, ROW), (2, SLIDER), (0, LABEL)], names
    row_rel, sl_rel, lb_rel = (rel for _, rel in kids[-3:])

    raw = bytearray(w.raw)
    set_name(raw, 0, 'ViewShowWndVolumeBar')
    struct.pack_into('<I', raw, WND_EFFECT, effect)
    set_name(raw, sl_rel, 'ViewShowSliderVolume')
    set_name(raw, lb_rel, 'ViewShowStrVolume')
    old, new = OLD_CAPTION.encode('utf-16le'), NEW_CAPTION.encode('utf-16le')
    cap = row_rel + CAPTION_OFF
    assert raw[cap:cap + len(old)] == old and len(new) <= len(old)
    raw[cap:cap + len(old)] = (b'' if icon else new).ljust(len(old), b'\0')   # an icon replaces the caption

    # window rect: the row, centred horizontally (or a full-width panel with the row centred in it);
    # children move so the row sits at (dx, dy) inside the window
    rx, ry, rw, rh = (I(raw, row_rel + 0xd4 + 4 * k) for k in range(4))
    sw = U(u.head, len(u.head) - 8)
    if panel:
        pw = width or sw
        struct.pack_into('<iiII', raw, 0xd4, (sw - pw) // 2, y, pw, panel)
        dx, dy = (pw - rw) // 2, (panel - rh) // 2
        struct.pack_into('<I', raw, 0xe4, len(u.images))  # background image index
        u.images.append(panel_image(pw, panel, color, alpha, line))
    else:
        struct.pack_into('<iiII', raw, 0xd4, (sw - rw) // 2, y, rw, rh)
        dx = dy = 0
    group_dx = GROUP_DX
    if icon:
        # the icon is drawn into the row background image, ICON_GAP left of the bar, on the row's centre line;
        # the group icon .. two-digit value is centred again
        from PIL import Image
        ico = Image.open(icon).convert('RGBA')
        bar_x = I(raw, sl_rel + 0xd4) - rx
        value_end = I(raw, lb_rel + LABEL_RECT) - rx + 22
        icon_x = bar_x - ICON_GAP - ico.width
        group_dx = round(rw / 2 - (icon_x + value_end) / 2)
        if icon_muted:
            # a ViewShowImageMute control: the firmware swaps the picture when muted
            mute_at = (icon_x, rh // 2 - ico.height // 2, ico.width, ico.height)
        else:
            bg0 = u.images[0]
            canvas = Image.new('RGBA', (U(bg0, 4), U(bg0, 8)), (0, 0, 0, 0))
            canvas.alpha_composite(ico, (icon_x, rh // 2 - ico.height // 2))
            u.images[0] = image_blob(canvas)
    else:
        struct.pack_into('<i', raw, row_rel + CAPTION_RECT, I(raw, row_rel + CAPTION_RECT) + CAPTION_DX)
    for p, ady in ((row_rel + 0xd4, 0), (sl_rel + 0xd4, SLIDER_DY), (lb_rel + LABEL_RECT, LABEL_DY)):
        struct.pack_into('<ii', raw, p, I(raw, p) - rx + dx + group_dx, I(raw, p + 4) - ry + dy + ady)

    # keep only the three records: rewrite the child (type, offset) pairs and the count
    hdr = U(raw, 4)
    for k, (t, rel) in enumerate(kids[-3:]):
        struct.pack_into('<II', raw, hdr + 8 + 8 * k, t, rel + base)
    struct.pack_into('<I', raw, 0xf4, 3)

    if icon and icon_muted:
        from PIL import Image
        ix, iy, iw, ih = mute_at
        n = len(u.images)
        u.images += [image_blob(Image.open(icon)), image_blob(Image.open(icon_muted).resize((iw, ih)))]
        rec = mute_record(os.path.join(os.path.dirname(src), MUTE_TEMPLATE[0]), n, n + 1,
                          ix + dx + group_dx, iy + dy, iw, ih)
        struct.pack_into('<II', raw, hdr + 8 + 8 * 3, 4, base + len(raw))   # 4th child
        struct.pack_into('<I', raw, 0xf4, 4)
        raw += rec
        struct.pack_into('<I', raw, 0, len(raw))

    if not row_line and not (icon and not icon_muted):
        # image 0 is the row background: transparent except a 1 px separator line at the bottom
        im = u.images[0]
        u.images[0] = panel_image(U(im, 4), U(im, 8), alpha=0)

    u.windows = [(Window(bytes(raw), base), base)]
    data = u.build()
    open(out, 'wb').write(data)
    check = UiData(data)
    cw, cb = check.windows[0]
    wr = [I(cw.raw, 0xd4 + 4 * k) for k in range(4)]
    print(f'{out}: {len(data)} bytes, window {rec_name(cw.raw, 0)} rect {wr}, bg image {I(cw.raw, 0xe4)}, '
          f'children {[rec_name(cw.raw, r) or f"t{t}" for t, r in cw.children(cb)]}')


def build_lang(setup_txt, out):
    """VolumeBar.txt: Setup.txt's header plus its '音量' row, keyed by the new caption."""
    lines = open(setup_txt, 'rb').read().decode('utf-16').split('\r\n')
    row = next(l.split('\t') for l in lines if l.split('\t')[1:2] == ['音量'])
    row[1] = NEW_CAPTION
    row[2] = 'Volume'  # English column ('Vol' in Setup.txt)
    open(out, 'wb').write(('\r\n'.join([lines[0], '\t'.join(row)]) + '\r\n').encode('utf-16'))
    print(f'{out}: {row[1]} -> {row[2]}')


if __name__ == '__main__':
    a = sys.argv[1:]
    opt = lambda k, d: type(d)(a[a.index(k) + 1]) if k in a else d
    rgb = lambda k: tuple(int(v) for v in a[a.index(k) + 1].split(',')) if k in a else None
    main(a[0], a[1], y=opt('--y', 470), panel=opt('--panel', 0), width=opt('--width', 0),
         color=rgb('--color') or (10, 16, 18), alpha=opt('--alpha', 255), line=rgb('--line'),
         row_line='--row-line' in a, effect=opt('--effect', 0), icon=opt('--icon', '') or None,
         icon_muted=opt('--icon-muted', '') or None)
    if '--lang' in a:
        build_lang(a[a.index('--lang') + 1], a[a.index('--lang') + 2])
