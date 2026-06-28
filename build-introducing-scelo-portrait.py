#!/usr/bin/env python3
"""Portrait (1080x1920) Scelo intro for TikTok / IG Reels.
Same storyboard/song as the 4K cut, re-laid-out for 9:16 and with
screenshot beats that pan card-by-card so each highlight fills the frame."""
import sys, os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SP = "/tmp/claude-1000/-home-adu-00-ali-scelo/b96e64c2-f974-4813-beee-7f715d0f102f/scratchpad"
ASSETS = f"{SP}/assets"
OUT = f"{SP}/frames_port"
W, H = 1080, 1920
AR = W / H
FPS = 30

BG    = (25, 25, 25)
INK   = (236, 233, 226)
MUTED = (152, 150, 146)
KGREY = (138, 138, 138)
TEAL  = (91, 200, 160)
PERI  = (126, 136, 232)
RING  = (124, 140, 240)
DOT_B, DOT_G, DOT_P = (110, 126, 232), (70, 201, 154), (154, 107, 214)

FDIR = "/home/adu-00/.local/share/fonts/SNPro"
def font(w, s): return ImageFont.truetype(f"{FDIR}/SNPro-{w}.ttf", s)

def smooth(t):
    t = max(0.0, min(1.0, t)); return t*t*(3-2*t)
def lerp(a, b, t): return a+(b-a)*t
def cam_at(keys, ts):
    if ts <= keys[0][0]: return keys[0][1:]
    if ts >= keys[-1][0]: return keys[-1][1:]
    for i in range(len(keys)-1):
        t0,*a = keys[i]; t1,*b = keys[i+1]
        if t0 <= ts <= t1:
            f = smooth((ts-t0)/(t1-t0))
            return tuple(lerp(a[j], b[j], f) for j in range(3))
    return keys[-1][1:]
def env(lt, dur, fin=0.35, fout=0.30):
    ai = smooth(lt/fin) if lt < fin else 1.0
    ao = smooth((dur-lt)/fout) if lt > dur-fout else 1.0
    return min(ai, ao)

# ---- text helpers (auto-fit to width) ----
def fit_size(d, text, weight, size, maxw, ls=0):
    while size > 10:
        f = font(weight, size)
        w = sum(d.textlength(c, font=f)+ls for c in text)-ls if ls else d.textlength(text, font=f)
        if w <= maxw: return size
        size -= 2
    return size

def draw_center(base, cx, y, text, fnt, color, alpha):
    layer = Image.new("RGBA", base.size, (0,0,0,0)); d = ImageDraw.Draw(layer)
    w = d.textlength(text, font=fnt)
    d.text((cx-w/2, y), text, font=fnt, fill=color+(int(255*alpha),))
    base.alpha_composite(layer)

def draw_ls(base, cx, y, text, weight, size, color, ls, alpha, maxw=1000):
    layer = Image.new("RGBA", base.size, (0,0,0,0)); d = ImageDraw.Draw(layer)
    size = fit_size(d, text, weight, size, maxw, ls)
    fnt = font(weight, size)
    total = sum(d.textlength(c, font=fnt)+ls for c in text)-ls
    x = cx-total/2; col = color+(int(255*alpha),)
    for c in text:
        d.text((x, y), c, font=fnt, fill=col); x += d.textlength(c, font=fnt)+ls
    base.alpha_composite(layer)

def draw_wordmark(base, cx, cy, s_size, alpha):
    layer = Image.new("RGBA", base.size, (0,0,0,0)); d = ImageDraw.Draw(layer)
    fS = font("400", s_size); fsub = font("400", int(s_size*0.42))
    col = INK+(int(255*alpha),)
    sb = d.textbbox((0,0), "S", font=fS); sw, sh = sb[2]-sb[0], sb[3]-sb[1]
    ub = d.textbbox((0,0), "0.1", font=fsub); uw, uh = ub[2]-ub[0], ub[3]-ub[1]
    gap = int(s_size*0.04); x0 = cx-(sw+gap+uw)/2; sy = cy-sh/2
    d.text((x0-sb[0], sy-sb[1]), "S", font=fS, fill=col)
    sub_bottom = sy+sh+int(s_size*0.03)
    d.text((x0+sw+gap-ub[0], sub_bottom-uh-ub[1]), "0.1", font=fsub, fill=col)
    base.alpha_composite(layer)

def draw_dots(base, cx, y, alpha, spread=100):
    layer = Image.new("RGBA", base.size, (0,0,0,0)); d = ImageDraw.Draw(layer)
    a = int(255*alpha); r = 9
    d.line([(cx-spread, y), (cx+spread, y)], fill=(90,90,90,a), width=3)
    for dx, c in [(-spread,DOT_B),(0,DOT_G),(spread,DOT_P)]:
        d.ellipse([cx+dx-r, y-r, cx+dx+r, y+r], fill=c+(a,))
    base.alpha_composite(layer)

# ---- screenshot beats ----
PIPE = SIM = None
def load_assets():
    global PIPE, SIM
    PIPE = Image.open(f"{ASSETS}/src_pipeline_4k.png").convert("RGB")
    ImageDraw.Draw(PIPE).rectangle([3560,2030,3840,2160], fill=BG)
    SIM = Image.open(f"{ASSETS}/src_sim_4k.png").convert("RGB")

def draw_ring(base, rect, cam, alpha, radius=22):
    if alpha <= 0: return
    cx, cy, hc = cam; S = H/hc
    x0,y0,x1,y1 = rect
    r = [(x0-cx)*S+W/2,(y0-cy)*S+H/2,(x1-cx)*S+W/2,(y1-cy)*S+H/2]
    pad = 14; rr = [r[0]-pad, r[1]-pad, r[2]+pad, r[3]+pad]
    layer = Image.new("RGBA", base.size, (0,0,0,0)); d = ImageDraw.Draw(layer)
    a = int(255*alpha)
    d.rounded_rectangle(rr, radius=radius, outline=RING+(a,), width=6)
    base.alpha_composite(layer.filter(ImageFilter.GaussianBlur(12)))
    base.alpha_composite(layer)

def caption_pill(base, text, alpha):
    if alpha <= 0: return
    layer = Image.new("RGBA", base.size, (0,0,0,0)); d = ImageDraw.Draw(layer)
    fnt = font("500", 34); tw = d.textlength(text, font=fnt)
    padx, pady = 34, 18; cx = W/2; y = 1726
    box = [cx-tw/2-padx, y-pady, cx+tw/2+padx, y+44+pady]
    a = int(alpha*255)
    d.rounded_rectangle(box, radius=30, fill=(18,18,18,int(a*0.86)))
    d.text((cx-tw/2, y), text, font=fnt, fill=INK+(a,))
    base.alpha_composite(layer)

def render_screen(still, lt, dur, keys, rings, caption):
    cx, cy, hc = cam_at(keys, lt)
    cw = hc*AR; ch = hc
    cx = max(cw/2, min(W*0+3840-cw/2, cx)); cy = max(ch/2, min(2160-ch/2, cy))
    cam = (cx, cy, hc)
    crop = still.crop((round(cx-cw/2), round(cy-ch/2), round(cx+cw/2), round(cy+ch/2)))
    frame = crop.resize((W, H), Image.LANCZOS).convert("RGBA")
    e = env(lt, dur, 0.3, 0.3)
    for rect, t0, t1, rad in rings:
        la = 0.0 if (lt < t0 or lt > t1) else min(smooth((lt-t0)/0.28), smooth((t1-lt)/0.28))
        draw_ring(frame, rect, cam, la*e, radius=rad)
    caption_pill(frame, caption, e)
    if e < 1.0:
        frame = Image.blend(Image.new("RGBA",(W,H),BG+(255,)), frame, e)
    return frame.convert("RGB")

def render_text(b, lt, dur):
    base = Image.new("RGBA", (W,H), BG+(255,)); e = env(lt, dur)
    drift = int((1-smooth(min(lt/0.5,1)))*22); cx = W/2
    k = b["kind"]
    if k == "title":
        draw_ls(base, cx, 470+drift, "INTRODUCING", "500", 36, KGREY, 14, e)
        draw_wordmark(base, cx, 840+drift, 230, e)
        draw_ls(base, cx, 1120+drift, "SCELO", "500", 46, (190,190,188), 26, e)
        draw_dots(base, cx, 1290, e)
    elif k == "end":
        draw_wordmark(base, cx, 800+drift, 220, e)
        draw_ls(base, cx, 1075+drift, "SCELO", "500", 44, (190,190,188), 26, e)
        draw_center(base, cx, 1210+drift, "from the Intelligent Actuaries lab", font("400", 34), MUTED, e)
        draw_dots(base, cx, 1380, e)
    else:
        draw_ls(base, cx, 600+drift, b["kicker"], "500", 34, b["kcolor"], 10, e, maxw=1000)
        lines = b["lines"]
        hs = fit_size(ImageDraw.Draw(base), max(lines, key=len), "600", b.get("hsize",96), 1000)
        fh = font("600", hs); lh = hs*1.16
        y = 940 - lh*len(lines)/2 + drift
        for ln in lines:
            draw_center(base, cx, y, ln, fh, INK, e); y += lh
        draw_ls(base, cx, 1290+drift, b["sub"], "400", 36, MUTED, 0, e, maxw=1000) \
            if d_width(base, b["sub"], 36) > 1000 else draw_center(base, cx, 1290+drift, b["sub"], font("400", 36), MUTED, e)
    return base.convert("RGB")

def d_width(base, text, size):
    return ImageDraw.Draw(base).textlength(text, font=font("400", size))

def build_beats():
    return [
        dict(type="text", frames=99, kind="title"),
        dict(type="text", frames=81, kind="mid", kicker="THE OFFLINE ACTUARIAL WORKBENCH",
             kcolor=TEAL, lines=["AI-assisted analysis,","without the cloud."],
             sub="A desktop workbench for actuaries."),
        dict(type="screen", frames=129, still="pipe", caption="Soft → Tools → Hard",
             keys=[(0.00,1920,1296,2120),(0.70,749,1296,1320),(1.55,749,1296,1320),
                   (1.90,1920,1296,1320),(2.55,1920,1296,1320),(2.90,3085,1296,1320),
                   (3.35,3085,1296,1320),(3.70,3410,415,740),(4.30,3410,415,700)],
             rings=[((314,762,1184,1830),0.78,1.70,26),((1482,762,2358,1830),1.95,2.60,26),
                    ((2650,762,3520,1830),2.95,3.55,26),((3236,360,3584,452),3.72,4.30,16)]),
        dict(type="text", frames=75, kind="mid", kicker="THE PIPELINE", kcolor=KGREY,
             lines=["Soft data → Tools","→ Hard data"],
             sub="Auditable. Every number traceable to its source."),
        dict(type="text", frames=75, kind="mid", kicker="PRIVATE BY DESIGN", kcolor=PERI,
             lines=["Your client data","never leaves","your machine."],
             sub="Models run locally. No cloud round-trip."),
        dict(type="screen", frames=129, still="sim", caption="Population simulation — live",
             keys=[(0.00,1920,1080,2120),(0.65,2285,820,840),(1.95,2285,820,840),
                   (2.55,540,1146,1520),(4.30,540,1146,1440)],
             rings=[((2150,775,2420,865),0.82,2.10,16),((122,952,952,1344),2.70,4.30,22)]),
        dict(type="text", frames=78, kind="mid", kicker="SWARM COUNCIL", kcolor=TEAL,
             lines=["Hundreds of agents.","One defensible","forecast."],
             sub="Stress-test decisions across a simulated society."),
        dict(type="text", frames=80, kind="end"),
    ]

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "full"
    load_assets(); beats = build_beats(); os.makedirs(OUT, exist_ok=True)
    def rbf(b, lf):
        dur = b["frames"]/FPS; lt = lf/FPS
        if b["type"] == "text": return render_text(b, lt, dur)
        still = PIPE if b["still"] == "pipe" else SIM
        return render_screen(still, lt, dur, b["keys"], b["rings"], b["caption"])
    if mode == "preview":
        os.makedirs(f"{SP}/prev_port", exist_ok=True)
        picks = [(0,50),(1,45),(2,35),(2,62),(2,95),(2,118),(3,40),(4,40),(5,35),(5,110),(6,40),(7,45)]
        for i,(bi,lf) in enumerate(picks):
            rbf(beats[bi], lf).save(f"{SP}/prev_port/p{i:02d}.png")
        print("preview done"); return
    n = 0
    for bi, b in enumerate(beats):
        for lf in range(b["frames"]):
            rbf(b, lf).save(f"{OUT}/f{n:05d}.png"); n += 1
        print("beat", bi, "done", n)
    print("TOTAL", n)

if __name__ == "__main__":
    main()
