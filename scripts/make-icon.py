#!/usr/bin/env python3
"""{R} — a flipped R inside curly braces.

The braces stay upright while the R is turned over: a code block holding
something that runs backwards, which is the whole point of the app. Same pixel
pipeline as before (small grid, per-pixel bevel, NEAREST upscale).
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

G = 64
OUT = 512
BLACK = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
MONO = "/System/Library/Fonts/SFNSMono.ttf"
THIN = "/System/Library/Fonts/Supplemental/Arial.ttf"
NARROW = "/System/Library/Fonts/Supplemental/Arial Narrow.ttf"

INK = (16, 20, 30, 255)
PLATE_TOP = (32, 40, 62, 255)
PLATE_BOT = (12, 15, 24, 255)

BLUE = dict(base=(74, 143, 255, 255), light=(168, 214, 255, 255), dark=(32, 84, 172, 255))
AMBER = dict(base=(255, 176, 60, 255), light=(255, 224, 150, 255), dark=(190, 112, 20, 255))
TEAL = dict(base=(45, 205, 190, 255), light=(150, 245, 235, 255), dark=(20, 130, 124, 255))
GREY = dict(base=(120, 134, 158, 255), light=(190, 202, 220, 255), dark=(70, 80, 98, 255))
PINK = dict(base=(240, 100, 160, 255), light=(255, 180, 214, 255), dark=(168, 48, 102, 255))


def hard(m, t=110):
    return m.point(lambda v: 255 if v > t else 0, mode="L")


def shift(m, dx, dy):
    o = Image.new("L", m.size, 0)
    o.paste(m, (dx, dy))
    return o


def sub(a, b):
    return Image.composite(a, Image.new("L", a.size, 0), Image.eval(b, lambda v: 255 - v))


def outline_of(m, w=1):
    grown = Image.new("L", m.size, 0)
    for dx in range(-w, w + 1):
        for dy in range(-w, w + 1):
            grown = Image.composite(Image.new("L", m.size, 255), grown, shift(m, dx, dy))
    return sub(grown, m)


def shade(canvas, m, pal, ink=INK, bevel=True):
    if not bevel:
        canvas.paste(Image.new("RGBA", canvas.size, pal["base"]), (0, 0), m)
        canvas.paste(Image.new("RGBA", canvas.size, ink), (0, 0), outline_of(m))
        return
    lit = sub(m, shift(m, 1, 1))
    shadow = sub(m, shift(m, -1, -1))
    body = sub(sub(m, lit), shadow)
    for mask, c in ((outline_of(m), ink), (body, pal["base"]),
                    (lit, pal["light"]), (shadow, pal["dark"])):
        canvas.paste(Image.new("RGBA", canvas.size, c), (0, 0), mask)


def glyph(ch, size, dx=0, dy=0, rot180=False, font=BLACK, W=None):
    W = W or G
    path = font if os.path.exists(font) else BLACK
    f = ImageFont.truetype(path, size)
    m = Image.new("L", (W, G), 0)
    d = ImageDraw.Draw(m)
    b = d.textbbox((0, 0), ch, font=f)
    d.text(((W - (b[2] - b[0])) / 2 - b[0] + dx, (G - (b[3] - b[1])) / 2 - b[1] + dy),
           ch, font=f, fill=255)
    m = hard(m)
    return m.rotate(180) if rot180 else m


def finish(art, inset=0.86, light_plate=False):
    s = OUT // G
    big = art.resize((art.width * s, art.height * s), Image.NEAREST)
    top, bot = ((238, 241, 247, 255), (198, 206, 222, 255)) if light_plate else (PLATE_TOP, PLATE_BOT)
    grad = Image.new("RGBA", (1, OUT))
    px = grad.load()
    for y in range(OUT):
        t = y / (OUT - 1)
        px[0, y] = tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(4))
    mask = Image.new("L", (OUT, OUT), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, OUT - 1, OUT - 1],
                                           radius=int(OUT * 0.225), fill=255)
    bg = Image.new("RGBA", (OUT, OUT), (0, 0, 0, 0))
    bg.paste(grad.resize((OUT, OUT)), (0, 0), mask)
    w = int(OUT * inset)
    h = round(w * big.height / big.width)
    inner = big.resize((w, h), Image.NEAREST)
    hold = Image.new("RGBA", (OUT, OUT), (0, 0, 0, 0))
    hold.paste(inner, ((OUT - w) // 2, (OUT - h) // 2))
    return Image.alpha_composite(bg, hold)


W = 84   # drawing canvas is wider than tall so the braces can breathe


def brace_mark(brace_pal, r_pal, r_size=44, brace_size=74, gap=28,
               brace_font=THIN, r_font=BLACK, bevel=True, light_plate=False, inset=0.92):
    a = Image.new("RGBA", (W, G), (0, 0, 0, 0))
    shade(a, glyph("{", brace_size, dx=-gap, font=brace_font, W=W), brace_pal, bevel=bevel)
    shade(a, glyph("}", brace_size, dx=gap, font=brace_font, W=W), brace_pal, bevel=bevel)
    shade(a, glyph("R", r_size, rot180=True, font=r_font, W=W), r_pal, bevel=bevel)
    return finish(a, inset=inset, light_plate=light_plate)


# thickness x gap, so the two axes can be judged independently
VARIANTS = []
for wi, (wn, wf) in enumerate((("bold", BOLD), ("thin", THIN), ("narrow", NARROW)), 1):
    for gi, gp in enumerate((26, 30, 34), 1):
        VARIANTS.append((
            f"{wi}{gi}-{wn}-gap{gp}",
            (lambda f=wf, g=gp: (lambda: brace_mark(AMBER, BLUE, brace_font=f, gap=g)))(),
        ))
VARIANTS += [
    ("A-flat", lambda: brace_mark(AMBER, BLUE, bevel=False, gap=30)),
    ("B-grey", lambda: brace_mark(GREY, BLUE, gap=30)),
    ("C-allblue", lambda: brace_mark(BLUE, BLUE, gap=30)),
]

if __name__ == "__main__":
    dest = sys.argv[1]
    os.makedirs(dest, exist_ok=True)
    names = []
    for name, fn in VARIANTS:
        fn().save(os.path.join(dest, name + ".png"))
        names.append(name)
    cols, cell = 3, 200
    rows = (len(names) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cell, rows * cell), (244, 245, 248, 255))
    for i, n in enumerate(names):
        im = Image.open(os.path.join(dest, n + ".png")).resize((cell - 30, cell - 30), Image.NEAREST)
        sheet.paste(im, ((i % cols) * cell + 15, (i // cols) * cell + 15), im)
    sheet.save(os.path.join(dest, "_braces.png"))
    print("\n".join(names))
