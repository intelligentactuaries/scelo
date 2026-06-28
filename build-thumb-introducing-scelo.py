#!/usr/bin/env python3
"""Simple Scelo YouTube thumbnail — flat bg, S0.1 wordmark, short tagline."""
from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
BG   = (25, 25, 25)
INK  = (236, 233, 226)
MUT  = (150, 148, 144)
DOT_B, DOT_G, DOT_P = (110, 126, 232), (70, 201, 154), (154, 107, 214)
FDIR = "/home/adu-00/.local/share/fonts/SNPro"
def font(w, s): return ImageFont.truetype(f"{FDIR}/SNPro-{w}.ttf", s)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)
cx = W / 2

# --- wordmark S0.1 (centered lockup) ---
s_size = 300
fS = font("400", s_size)
fsub = font("400", int(s_size * 0.42))
cy = 300
sb = d.textbbox((0, 0), "S", font=fS); sw, sh = sb[2]-sb[0], sb[3]-sb[1]
ub = d.textbbox((0, 0), "0.1", font=fsub); uw, uh = ub[2]-ub[0], ub[3]-ub[1]
gap = int(s_size * 0.04)
x0 = cx - (sw + gap + uw) / 2
sy = cy - sh / 2
d.text((x0 - sb[0], sy - sb[1]), "S", font=fS, fill=INK)
sub_bottom = sy + sh + int(s_size * 0.03)
d.text((x0 + sw + gap - ub[0], sub_bottom - uh - ub[1]), "0.1", font=fsub, fill=INK)

# --- SCELO letterspaced ---
def ls(y, text, fnt, color, sp):
    total = sum(d.textlength(c, font=fnt) + sp for c in text) - sp
    x = cx - total / 2
    for c in text:
        d.text((x, y), c, font=fnt, fill=color)
        x += d.textlength(c, font=fnt) + sp
ls(470, "SCELO", font("500", 50), (196, 196, 193), 26)

# --- short tagline ---
ls(556, "THE OFFLINE ACTUARIAL WORKBENCH", font("500", 26), MUT, 8)

# --- brand dots ---
y = 638; spread = 90; r = 8
d.line([(cx - spread, y), (cx + spread, y)], fill=(85, 85, 85), width=2)
for dx, c in [(-spread, DOT_B), (0, DOT_G), (spread, DOT_P)]:
    d.ellipse([cx+dx-r, y-r, cx+dx+r, y+r], fill=c)

img.save("/tmp/claude-1000/-home-adu-00-ali-scelo/b96e64c2-f974-4813-beee-7f715d0f102f/scratchpad/thumb.png")
print("saved")
