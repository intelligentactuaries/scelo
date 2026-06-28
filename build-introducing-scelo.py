#!/usr/bin/env python3
"""Rebuild the 'Introducing Scelo' 4K intro.
 - flat #191919 background (no gradient)
 - retimed to the 24.88s song
 - screenshot beats zoom-in + ring real UI controls (no Ken-Burns)
"""
import sys, os, math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SP = "/tmp/claude-1000/-home-adu-00-ali-scelo/b96e64c2-f974-4813-beee-7f715d0f102f/scratchpad"
ASSETS = f"{SP}/assets"
OUT_FRAMES = f"{SP}/frames_out"
W, H = 3840, 2160
FPS = 30

# ---- palette -------------------------------------------------------------
BG      = (25, 25, 25)            # #191919 flat
INK     = (236, 233, 226)         # warm headline white
MUTED   = (152, 150, 146)
KGREY   = (138, 138, 138)
TEAL    = (91, 200, 160)
PERI    = (126, 136, 232)
RING    = (124, 140, 240)
DOT_B   = (110, 126, 232)
DOT_G   = (70, 201, 154)
DOT_P   = (154, 107, 214)

FDIR = "/home/adu-00/.local/share/fonts/SNPro"
def font(w, size):
    return ImageFont.truetype(f"{FDIR}/SNPro-{w}.ttf", size)

# ---- easing --------------------------------------------------------------
def smooth(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)

def lerp(a, b, t): return a + (b - a) * t

def cam_at(keys, ts):
    """keys: list of (t, cx, cy, z). returns eased (cx,cy,z) at ts."""
    if ts <= keys[0][0]: return keys[0][1:]
    if ts >= keys[-1][0]: return keys[-1][1:]
    for i in range(len(keys) - 1):
        t0, *a = keys[i]; t1, *b = keys[i + 1]
        if t0 <= ts <= t1:
            f = smooth((ts - t0) / (t1 - t0))
            return tuple(lerp(a[j], b[j], f) for j in range(3))
    return keys[-1][1:]

# ---- text helpers --------------------------------------------------------
def ls_width(draw, text, fnt, ls):
    w = 0
    for ch in text:
        w += draw.textlength(ch, font=fnt) + ls
    return w - ls if text else 0

def draw_ls(base, cx, y, text, fnt, color, ls, alpha):
    """centered letter-spaced text, alpha 0..1, anchored by top y."""
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    total = ls_width(d, text, fnt, ls)
    x = cx - total / 2
    col = color + (int(255 * alpha),)
    for ch in text:
        d.text((x, y), ch, font=fnt, fill=col)
        x += d.textlength(ch, font=fnt) + ls
    base.alpha_composite(layer)

def draw_center(base, cx, y, text, fnt, color, alpha):
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    w = d.textlength(text, font=fnt)
    d.text((cx - w / 2, y), text, font=fnt, fill=color + (int(255 * alpha),))
    base.alpha_composite(layer)

# ---- wordmark + dots -----------------------------------------------------
def draw_wordmark(base, cx, cy, s_size, alpha):
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    fS = font("400", s_size)
    sub_size = int(s_size * 0.42)
    fsub = font("400", sub_size)
    col = INK + (int(255 * alpha),)
    sb = d.textbbox((0, 0), "S", font=fS)
    sw, sh = sb[2] - sb[0], sb[3] - sb[1]
    gap = int(s_size * 0.04)
    subtext = "0.1"
    ub = d.textbbox((0, 0), subtext, font=fsub)
    uw, uh = ub[2] - ub[0], ub[3] - ub[1]
    total_w = sw + gap + uw
    x0 = cx - total_w / 2
    sy = cy - sh / 2
    d.text((x0 - sb[0], sy - sb[1]), "S", font=fS, fill=col)
    # subscript bottom aligns slightly below S bottom
    s_bottom = sy + sh
    sub_bottom = s_bottom + int(s_size * 0.03)
    ux = x0 + sw + gap
    uy = sub_bottom - uh
    d.text((ux - ub[0], uy - ub[1]), subtext, font=fsub, fill=col)
    base.alpha_composite(layer)

def draw_dots(base, cx, y, alpha, spread=150):
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    a = int(255 * alpha)
    d.line([(cx - spread, y), (cx + spread, y)], fill=(90, 90, 90, a), width=3)
    r = 11
    for dx, c in [(-spread, DOT_B), (0, DOT_G), (spread, DOT_P)]:
        d.ellipse([cx + dx - r, y - r, cx + dx + r, y + r], fill=c + (a,))
    base.alpha_composite(layer)

# ---- highlight ring ------------------------------------------------------
def transform_rect(rect, cam):
    cx, cy, z = cam
    x0, y0, x1, y1 = rect
    ox0 = (x0 - cx) * z + W / 2; oy0 = (y0 - cy) * z + H / 2
    ox1 = (x1 - cx) * z + W / 2; oy1 = (y1 - cy) * z + H / 2
    return [ox0, oy0, ox1, oy1]

def draw_ring(base, rect, cam, alpha, radius=26, grow=1.0):
    if alpha <= 0: return
    r = transform_rect(rect, cam)
    cxr = (r[0] + r[2]) / 2; cyr = (r[1] + r[3]) / 2
    hw = (r[2] - r[0]) / 2 * grow; hh = (r[3] - r[1]) / 2 * grow
    pad = 18
    rr = [cxr - hw - pad, cyr - hh - pad, cxr + hw + pad, cyr + hh + pad]
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    a = int(255 * alpha)
    d.rounded_rectangle(rr, radius=radius, outline=RING + (a,), width=8)
    glow = layer.filter(ImageFilter.GaussianBlur(16))
    glow = Image.eval(glow, lambda p: p)  # keep
    base.alpha_composite(glow)
    base.alpha_composite(layer)

def caption_pill(base, text, alpha):
    if alpha <= 0: return
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    fnt = font("500", 50)
    tw = d.textlength(text, font=fnt)
    padx, pady = 50, 28
    cx = W / 2; y = 1956
    box = [cx - tw / 2 - padx, y - pady, cx + tw / 2 + padx, y + 64 + pady]
    a = int(alpha * 255)
    d.rounded_rectangle(box, radius=44, fill=(18, 18, 18, int(a * 0.86)))
    d.text((cx - tw / 2, y), text, font=fnt, fill=INK + (a,))
    base.alpha_composite(layer)

# ---- beats ---------------------------------------------------------------
PIPE = None; SIM = None
def load_assets():
    global PIPE, SIM
    PIPE = Image.open(f"{ASSETS}/src_pipeline_4k.png").convert("RGB")
    # mask the tiny window widget bottom-right
    dp = ImageDraw.Draw(PIPE)
    dp.rectangle([3560, 2030, 3840, 2160], fill=BG)
    SIM = Image.open(f"{ASSETS}/src_sim_4k.png").convert("RGB")

def env(local_t, dur, fin=0.35, fout=0.30):
    a_in = smooth(local_t / fin) if local_t < fin else 1.0
    a_out = smooth((dur - local_t) / fout) if local_t > dur - fout else 1.0
    return min(a_in, a_out)

def render_screen(still, local_t, dur, keys, rings, caption):
    cam = cam_at(keys, local_t)
    cx, cy, z = cam
    halfw, halfh = W / (2 * z), H / (2 * z)
    cx = max(halfw, min(W - halfw, cx)); cy = max(halfh, min(H - halfh, cy))
    cam = (cx, cy, z)
    crop = still.crop((round(cx - halfw), round(cy - halfh),
                       round(cx + halfw), round(cy + halfh)))
    frame = crop.resize((W, H), Image.LANCZOS).convert("RGBA")
    e = env(local_t, dur, 0.3, 0.3)
    for rect, t0, t1, rad in rings:
        ra = env(local_t, t1 - t0 if False else dur)  # placeholder
        # ring local alpha: fade in/out within [t0,t1]
        if local_t < t0 or local_t > t1:
            la = 0.0
        else:
            la = min(smooth((local_t - t0) / 0.28),
                     smooth((t1 - local_t) / 0.28))
        draw_ring(frame, rect, cam, la * e, radius=rad)
    caption_pill(frame, caption, e)
    if e < 1.0:
        bg = Image.new("RGBA", (W, H), BG + (255,))
        frame = Image.blend(bg, frame, e)
    return frame.convert("RGB")

def render_text(beat, local_t, dur):
    base = Image.new("RGBA", (W, H), BG + (255,))
    e = env(local_t, dur)
    drift = int((1 - smooth(min(local_t / 0.5, 1))) * 26)
    cx = W / 2
    kind = beat["kind"]
    if kind == "title":
        draw_ls(base, cx, 470 + drift, "INTRODUCING", font("500", 44), KGREY, 18, e)
        draw_wordmark(base, cx, 1090 + drift, 320, e)
        draw_ls(base, cx, 1545 + drift, "SCELO", font("500", 60), (190, 190, 188), 30, e)
        draw_dots(base, cx, 1760, e)
    elif kind == "end":
        draw_wordmark(base, cx, 900 + drift, 300, e)
        draw_ls(base, cx, 1310 + drift, "SCELO", font("500", 58), (190, 190, 188), 30, e)
        draw_center(base, cx, 1520 + drift, "from the Intelligent Actuaries lab",
                    font("400", 46), MUTED, e)
        draw_dots(base, cx, 1770, e)
    else:
        draw_ls(base, cx, 560 + drift, beat["kicker"], font("500", 46),
                beat["kcolor"], 16, e)
        fh = font("600", beat.get("hsize", 150))
        lines = beat["lines"]
        lh = beat.get("hsize", 150) * 1.16
        total = lh * len(lines)
        y = 1060 - total / 2 + drift
        for ln in lines:
            draw_center(base, cx, y, ln, fh, INK, e)
            y += lh
        draw_center(base, cx, 1620 + drift, beat["sub"], font("400", 50), MUTED, e)
    return base.convert("RGB")

# ---- storyboard ----------------------------------------------------------
def build_beats():
    return [
        dict(type="text", frames=99, kind="title"),
        dict(type="text", frames=81, kind="mid",
             kicker="THE OFFLINE ACTUARIAL WORKBENCH", kcolor=TEAL,
             lines=["AI-assisted analysis,", "without the cloud."],
             sub="A desktop workbench for actuaries."),
        dict(type="screen", frames=129, still="pipe",
             caption="Soft data → Tools → Hard data",
             keys=[(0.00, 1920, 1080, 1.00), (0.55, 1917, 1296, 1.20),
                   (2.30, 1917, 1296, 1.24), (2.95, 3050, 600, 1.75),
                   (4.30, 3360, 455, 2.30)],
             rings=[((314, 762, 1184, 1830), 0.7, 2.55, 30),
                    ((1482, 762, 2358, 1830), 1.05, 2.6, 30),
                    ((2650, 762, 3520, 1830), 1.45, 2.65, 30),
                    ((3236, 360, 3584, 452), 3.05, 4.30, 18)]),
        dict(type="text", frames=75, kind="mid", hsize=132,
             kicker="THE PIPELINE", kcolor=KGREY,
             lines=["Soft data → Tools → Hard data"],
             sub="One-way and auditable. Every number traceable to its source."),
        dict(type="text", frames=75, kind="mid",
             kicker="PRIVATE BY DESIGN", kcolor=PERI,
             lines=["Your client data", "never leaves your machine."],
             sub="Models run locally. No cloud round-trip."),
        dict(type="screen", frames=129, still="sim",
             caption="Population simulation — live progress",
             keys=[(0.00, 1920, 1080, 1.00), (0.60, 2285, 819, 1.92),
                   (1.95, 2285, 819, 1.96), (2.55, 1277, 1146, 1.45),
                   (4.30, 1277, 1146, 1.62)],
             rings=[((2150, 775, 2420, 865), 0.75, 2.15, 18),
                    ((122, 954, 2432, 1338), 2.7, 4.30, 26)]),
        dict(type="text", frames=78, kind="mid",
             kicker="SWARM COUNCIL", kcolor=TEAL,
             lines=["Hundreds of agents.", "One defensible forecast."],
             sub="Stress-test decisions across a simulated society."),
        dict(type="text", frames=80, kind="end"),
    ]

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "full"
    load_assets()
    beats = build_beats()
    os.makedirs(OUT_FRAMES, exist_ok=True)

    def render_beat_frame(beat, lf):
        dur = beat["frames"] / FPS
        lt = lf / FPS
        if beat["type"] == "text":
            return render_text(beat, lt, dur)
        still = PIPE if beat["still"] == "pipe" else SIM
        return render_screen(still, lt, dur, beat["keys"], beat["rings"], beat["caption"])

    if mode == "preview":
        os.makedirs(f"{SP}/preview", exist_ok=True)
        picks = [(0, 50), (1, 45), (2, 55), (2, 110), (3, 40),
                 (4, 40), (5, 35), (5, 110), (6, 40), (7, 45)]
        for i, (bi, lf) in enumerate(picks):
            img = render_beat_frame(beats[bi], lf)
            img.save(f"{SP}/preview/p{i:02d}_b{bi}.png")
            print("preview", i, bi, lf)
        return

    n = 0
    for bi, beat in enumerate(beats):
        for lf in range(beat["frames"]):
            img = render_beat_frame(beat, lf)
            img.save(f"{OUT_FRAMES}/f{n:05d}.png")
            n += 1
        print(f"beat {bi} done, total {n}")
    print("TOTAL FRAMES", n)

if __name__ == "__main__":
    main()
