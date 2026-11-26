"""Build a compact AirCondition.data: the climate popup as a strip at the bottom of the screen.

The stock popup (window 0) covers 0,72..1024,600 with seat drawings and airflow arrows. This keeps
only the status icons, the two temperatures and the seat-heating bars, and shrinks the window to a
strip; the fan-speed window (window 1, already at the bottom) is left as it is.

usage: build_ac_bar.py <AirCondition.data> <out AirCondition.data> [--y 440] [--icons-y 8] [--seat-y 52]
"""
import struct
import sys
from uidata import UiData, Window, U, I, rec_name

ICONS = ['ViewShowImageAcOn', 'ViewShowImageAutoHighWind', 'ViewShowImageAutoLowWind', 'ViewShowImageDual',
         'ViewShowImageMaxFront', 'ViewShowImageRearLight', 'ViewShowImageRearLock',
         'ViewShowImageInCycle', 'ViewShowImageOutCycle']
SEAT_BARS = [f'ViewShowImage{s}Warm{k}' for s in ('Left', 'Right') for k in (1, 2, 3)]
TEMPS = ['ViewShowStrLeftTemperature', 'ViewShowStrRightTemperature']
STR_RECT = 0x19c   # x, y, w, h of a string record (other records keep theirs at +0xd4)


def main(src, out, y=440, icons_y=8, seat_y=52):
    u = UiData(open(src, 'rb').read())
    w, base = u.windows[0]
    raw = bytearray(w.raw)
    wx, wy, ww, wh = (I(raw, 0xd4 + 4 * k) for k in range(4))
    h = wy + wh - y                       # strip reaches the bottom of the old window
    struct.pack_into('<iiII', raw, 0xd4, wx, y, ww, h)
    shift = y - wy                        # children are window-relative

    keep = []
    for t, rel in w.children(base):
        name = rec_name(raw, rel)
        if name not in ICONS + SEAT_BARS + TEMPS:
            continue
        p = rel + (STR_RECT if t == 0 else 0xd4)
        cy = I(raw, p + 4)
        ny = icons_y if name in ICONS else seat_y if name in SEAT_BARS else cy - shift
        struct.pack_into('<i', raw, p + 4, ny)
        keep.append((t, rel))

    hdr = U(raw, 4)
    for k, (t, rel) in enumerate(keep):
        struct.pack_into('<II', raw, hdr + 8 + 8 * k, t, rel + base)
    struct.pack_into('<I', raw, 0xf4, len(keep))
    u.windows[0] = (Window(bytes(raw), base), base)

    data = u.build()
    open(out, 'wb').write(data)
    cw, cb = UiData(data).windows[0]
    print(f'{out}: window 0 rect {[I(cw.raw, 0xd4 + 4 * k) for k in range(4)]}, '
          f'{len(keep)} widgets: {[rec_name(cw.raw, r)[13:] for _, r in cw.children(cb)]}')


if __name__ == '__main__':
    a = sys.argv[1:]
    opt = lambda k, d: int(a[a.index(k) + 1]) if k in a else d
    main(a[0], a[1], y=opt('--y', 440), icons_y=opt('--icons-y', 8), seat_y=opt('--seat-y', 52))
