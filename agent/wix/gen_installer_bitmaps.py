#!/usr/bin/env python3
"""
Generate Vantyr-branded WiX installer bitmap assets.

WiX standard sizes:
  wix-banner.bmp  – 493 × 58   shown at the TOP of inner dialogs (InstallDir, Progress, etc.)
  wix-dialog.bmp  – 493 × 312  shown as the LEFT-PANEL background of WelcomeDlg / ExitDialog

Run from anywhere; outputs to the same directory as this script.
"""

import os
import math
from PIL import Image, ImageDraw, ImageFont

# ── Vantyr design tokens ──────────────────────────────────────────────────────
BG       = (  8,   9,  11)   # #08090b  near-black background
SURFACE  = ( 20,  21,  24)   # #141518  surface
SURFACE2 = ( 27,  29,  33)   # #1b1d21  surface-alt
ACCENT   = ( 32, 221, 143)   # #20dd8f  mint-green
# 45 % opacity accent blended over BG:
#   R = round(32*0.45 + 8*0.55)   = 19
#   G = round(221*0.45 + 9*0.55)  = 104
#   B = round(143*0.45 + 11*0.55) = 70
ACCENT_D = ( 19, 104,  70)   # dim accent (for the faded bottom-right bracket)
TEXT     = (243, 244, 246)   # #f3f4f6  primary text
MUTED    = (149, 152, 161)   # #9598a1  secondary text

# ── Helpers ───────────────────────────────────────────────────────────────────

def lerp(c1, c2, t: float):
    t = max(0.0, min(1.0, t))
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))


def get_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    """Load a system font with graceful fall-back chain."""
    candidates = (
        ["segoeuib.ttf", "segoeuisb.ttf", "arialbd.ttf", "calibrib.ttf"]
        if bold else
        ["segoeui.ttf",  "arial.ttf",     "calibri.ttf", "verdana.ttf"]
    )
    for name in candidates:
        for prefix in [r"C:\Windows\Fonts", r"C:\Windows\Fonts"]:
            path = os.path.join(prefix, name)
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                pass
    return ImageFont.load_default()


def text_size(draw: ImageDraw.ImageDraw, text: str, font) -> tuple[int, int]:
    """Return (width, height) of rendered text."""
    bb = draw.textbbox((0, 0), text, font=font)
    return bb[2] - bb[0], bb[3] - bb[1]


# ── Logo renderer ─────────────────────────────────────────────────────────────

def draw_logo(draw: ImageDraw.ImageDraw, x0: int, y0: int, size: int) -> None:
    """
    Render the Vantyr logo at (x0, y0) in a square of `size` pixels.

    SVG viewBox 0 0 20 20:
      top-left bracket   M2 2h5.5v2.6H4.6V8H2V2z
      top-right bracket  M18 2h-5.5v2.6h2.9V8H18V2z
      bottom-right bkt   M18 18h-5.5v-2.6h2.9V12H18v6z  (opacity .45)
      center dot         cx=10 cy=10 r=1.6
    """
    def p(v: float) -> int:
        return round(v * size / 20.0)

    G  = ACCENT
    GD = ACCENT_D

    # Top-left:   horizontal bar (2,2)→(7.5,4.6)  +  vertical bar (2,4.6)→(4.6,8)
    draw.rectangle([x0+p(2),    y0+p(2),    x0+p(7.5), y0+p(4.6)], fill=G)
    draw.rectangle([x0+p(2),    y0+p(4.6),  x0+p(4.6), y0+p(8)  ], fill=G)

    # Top-right:  horizontal bar (12.5,2)→(18,4.6) + vertical bar (15.4,4.6)→(18,8)
    draw.rectangle([x0+p(12.5), y0+p(2),    x0+p(18),  y0+p(4.6)], fill=G)
    draw.rectangle([x0+p(15.4), y0+p(4.6),  x0+p(18),  y0+p(8)  ], fill=G)

    # Bottom-right (45 % opacity):
    #   vertical bar (15.4,12)→(18,15.4) + horizontal bar (12.5,15.4)→(18,18)
    draw.rectangle([x0+p(15.4), y0+p(12),   x0+p(18),  y0+p(15.4)], fill=GD)
    draw.rectangle([x0+p(12.5), y0+p(15.4), x0+p(18),  y0+p(18)  ], fill=GD)

    # Center dot
    cx = x0 + p(10)
    cy = y0 + p(10)
    r  = max(1, p(1.6))
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=G)


# ── Banner (493 × 58) ─────────────────────────────────────────────────────────

def make_banner() -> Image.Image:
    """
    The banner sits across the TOP of install-dir, progress, and feature dialogs.
    WiX overlays the dialog title starting around x≈180 px, so the left ~170 px
    is safe for logo + product name (no text collision).
    """
    W, H  = 493, 58
    WHITE = (255, 255, 255)
    img   = Image.new("RGB", (W, H), WHITE)
    draw  = ImageDraw.Draw(img)

    # WiX renders dark text from x≈20 on the left — keep all that space white.
    # Put branding on the RIGHT only.

    # Logo: 26 px, right-aligned
    LS = 26
    LX = W - LS - 14
    LY = (H - LS) // 2
    draw_logo(draw, LX, LY, LS)

    # "Vantyr" label — dark text, to the left of the logo
    fn = get_font(13, bold=True)
    label = "Vantyr"
    tw, th = text_size(draw, label, fn)
    tx = LX - tw - 8
    ty = (H - th) // 2
    draw.text((tx, ty), label, fill=(20, 20, 20), font=fn)

    return img


# ── Dialog (493 × 312) ────────────────────────────────────────────────────────

def make_dialog() -> Image.Image:
    """
    WelcomeDlg / ExitDialog background.
    Left ~165 px: dark branding panel (logo + name).
    Right remainder: white — matches WiX's default dialog background so the
    content area looks correct and the panel appears the same width as before.
    No coloured borders or accent lines.
    """
    W, H = 493, 312
    PW   = 165   # dark panel width — matches WiX standard sidebar (~164 WiX units)

    # Fill entire bitmap white (right side will show through as WiX default bg)
    img  = Image.new("RGB", (W, H), (255, 255, 255))
    draw = ImageDraw.Draw(img)

    # Dark left panel — plain solid black, no gradient
    draw.rectangle([0, 0, PW - 1, H - 1], fill=BG)

    # ── Logo: 60 px, centred in panel, ~90 px from top ───────────────────────
    LS = 60
    LX = (PW - LS) // 2
    LY = 90
    draw_logo(draw, LX, LY, LS)

    # ── "Vantyr" title ────────────────────────────────────────────────────────
    fn_title = get_font(20, bold=True)
    title    = "Vantyr"
    tw, th   = text_size(draw, title, fn_title)
    title_y  = LY + LS + 16
    draw.text(((PW - tw) // 2, title_y), title, fill=TEXT, font=fn_title)

    # ── "Agent" sub-label ─────────────────────────────────────────────────────
    fn_sub = get_font(12, bold=False)
    sub    = "Agent"
    sw, _  = text_size(draw, sub, fn_sub)
    sub_y  = title_y + th + 6
    draw.text(((PW - sw) // 2, sub_y), sub, fill=MUTED, font=fn_sub)

    return img


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # BMPs go into the assets/ sub-directory (where the WiX template references them)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    assets_dir = os.path.join(script_dir, "assets")
    os.makedirs(assets_dir, exist_ok=True)

    banner = make_banner()
    banner.save(os.path.join(assets_dir, "wix-banner.bmp"), "BMP")
    banner.save(os.path.join(script_dir, "wix-banner-preview.png"))
    print(f"OK wix-banner.bmp  ({banner.size[0]}x{banner.size[1]})")

    dialog = make_dialog()
    dialog.save(os.path.join(assets_dir, "wix-dialog.bmp"), "BMP")
    dialog.save(os.path.join(script_dir, "wix-dialog-preview.png"))
    print(f"OK wix-dialog.bmp  ({dialog.size[0]}x{dialog.size[1]})")

    print("OK PNG previews written to wix/ for quick inspection")
