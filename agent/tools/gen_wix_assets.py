from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from pathlib import Path


def vertical_gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]):
    from PIL import Image

    w, h = size
    img = Image.new("RGB", size, top)
    px = img.load()
    for y in range(h):
        t = y / max(1, (h - 1))
        r = int(top[0] * (1 - t) + bottom[0] * t)
        g = int(top[1] * (1 - t) + bottom[1] * t)
        b = int(top[2] * (1 - t) + bottom[2] * t)
        for x in range(w):
            px[x, y] = (r, g, b)
    return img


def _local_tag(tag: str) -> str:
    return tag.split("}", 1)[-1] if "}" in tag else tag


def _parse_viewbox(s: str | None) -> tuple[float, float, float, float]:
    if not s:
        return (0.0, 0.0, 32.0, 32.0)
    parts = re.split(r"[\s,]+", s.strip())
    if len(parts) != 4:
        return (0.0, 0.0, 32.0, 32.0)
    return tuple(float(x) for x in parts)  # type: ignore[return-value]


def _hex_to_rgba(color: str | None, default: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    if not color or not color.startswith("#") or len(color) not in (4, 7):
        return default
    h = color[1:]
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    return (r, g, b, 255)


def parse_frontend_favicon(svg_path: Path) -> dict:
    """Read path + circle (+ colors) from frontend/public/favicon.svg."""
    tree = ET.parse(svg_path)
    root = tree.getroot()
    vb = _parse_viewbox(root.get("viewBox"))

    path_d: str | None = None
    stroke_rgba = (95, 107, 122, 255)
    stroke_width = 1.5
    circle_spec: dict | None = None

    for el in root.iter():
        t = _local_tag(el.tag)
        if t == "path":
            path_d = el.get("d")
            stroke_rgba = _hex_to_rgba(el.get("stroke"), stroke_rgba)
            sw = el.get("stroke-width")
            if sw:
                try:
                    stroke_width = float(sw)
                except ValueError:
                    pass
        elif t == "circle":
            try:
                circle_spec = {
                    "cx": float(el.get("cx", 0)),
                    "cy": float(el.get("cy", 0)),
                    "r": float(el.get("r", 0)),
                    "fill": _hex_to_rgba(el.get("fill"), stroke_rgba),
                }
            except (TypeError, ValueError):
                circle_spec = None

    if not path_d:
        raise ValueError(f"No <path> with d= in {svg_path}")

    return {
        "viewbox": vb,
        "path_d": path_d,
        "stroke_rgba": stroke_rgba,
        "stroke_width": stroke_width,
        "circle": circle_spec,
    }


def render_favicon_rgba(
    spec: dict,
    out_size: int,
    *,
    supersample: int = 4,
):
    """Raster the favicon paths to a square RGBA image (matches SVG viewBox aspect)."""
    from PIL import Image, ImageDraw
    from svg.path import parse_path

    min_x, min_y, vb_w, vb_h = spec["viewbox"]
    path = parse_path(spec["path_d"])
    stroke_rgba: tuple[int, int, int, int] = spec["stroke_rgba"]
    stroke_w: float = spec["stroke_width"]
    circle = spec.get("circle")

    w = h = out_size * supersample
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    def tx(x: float) -> float:
        return (x - min_x) / vb_w * w

    def ty(y: float) -> float:
        return (y - min_y) / vb_h * h

    n = max(100, int(path.length() * 3))
    pts: list[tuple[float, float]] = []
    for i in range(n + 1):
        z = path.point(i / n)
        pts.append((tx(z.real), ty(z.imag)))

    line_w = max(1, round(stroke_w / vb_w * w))
    draw.line(pts + [pts[0]], fill=stroke_rgba, width=line_w, joint="curve")

    if circle:
        cx, cy, r = circle["cx"], circle["cy"], circle["r"]
        fill = circle["fill"]
        draw.ellipse(
            [tx(cx - r), ty(cy - r), tx(cx + r), ty(cy + r)],
            fill=fill,
        )

    if supersample > 1:
        img = img.resize((out_size, out_size), Image.Resampling.LANCZOS)
    return img


def _load_windows_font(px: int):
    """Best-effort TrueType on Windows; falls back to PIL default."""
    from PIL import ImageFont

    candidates = [
        r"C:\Windows\Fonts\seguisb.ttf",  # Segoe UI Semibold
        r"C:\Windows\Fonts\segoeuib.ttf",  # Segoe UI Bold
        r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\arial.ttf",
    ]
    for p in candidates:
        try:
            return ImageFont.truetype(p, px)
        except Exception:
            pass
    return ImageFont.load_default()


def write_license_rtf(out_path: Path, license_txt_path: Path):
    body = license_txt_path.read_text(encoding="utf-8").replace("\r\n", "\n")
    rtf = r"{\rtf1\ansi\deff0{\fonttbl{\f0 Consolas;}}\fs18" + "\n"
    for line in body.split("\n"):
        line = line.replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}")
        rtf += line + r"\par" + "\n"
    rtf += "}"
    out_path.write_text(rtf, encoding="utf-8")


def write_app_icon_ico(out_path: Path, spec: dict):
    from PIL import Image

    sizes = (256, 128, 64, 48, 32, 16)
    images: list[Image.Image] = []
    for s in sizes:
        rgba = render_favicon_rgba(spec, s, supersample=4 if s >= 32 else 2)
        images.append(rgba)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    first, *rest = images
    first.save(
        out_path,
        format="ICO",
        sizes=[(im.width, im.height) for im in images],
        append_images=rest,
    )


def write_readme_banner_png(out_path: Path, spec: dict):
    from PIL import Image, ImageDraw

    # GitHub-friendly wide banner, styled like the provided reference (dark bar, icon at left, title text).
    W, H = (1280, 320)
    base = vertical_gradient((W, H), (20, 28, 40), (12, 18, 28)).convert("RGBA")
    draw = ImageDraw.Draw(base)

    # Centered logo + title group (no panels; everything sits directly on the gradient).
    logo = render_favicon_rgba(spec, 132)
    title = "Vantyr"
    font = _load_windows_font(82)
    text_bbox = draw.textbbox((0, 0), title, font=font)
    text_w = text_bbox[2] - text_bbox[0]
    text_h = text_bbox[3] - text_bbox[1]

    gap = 34
    group_w = logo.width + gap + text_w
    start_x = (W - group_w) // 2

    logo_x = start_x
    logo_y = (H - logo.height) // 2
    base.alpha_composite(logo, (logo_x, logo_y))

    text_x = logo_x + logo.width + gap
    text_y = (H - text_h) // 2 - text_bbox[1]
    draw.text((text_x, text_y), title, font=font, fill=(245, 247, 250, 255))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.unlink(missing_ok=True)
    base.convert("RGB").save(out_path, format="PNG", optimize=True)


def write_github_repo_social_card_png(out_path: Path, spec: dict):
    """
    GitHub repository social preview / Open Graph image (2:1, typically 1280×640).
    Keeps branding inside ~40px margins so crops on various platforms stay safe.
    """
    from PIL import Image, ImageDraw

    W, H = 1280, 640
    margin = 40
    base = vertical_gradient((W, H), (20, 28, 40), (12, 18, 28)).convert("RGBA")
    draw = ImageDraw.Draw(base)

    title = "Vantyr"
    subtitle = "Windows monitoring agent"

    logo = render_favicon_rgba(spec, 168)
    title_font = _load_windows_font(96)
    sub_font = _load_windows_font(34)

    title_bbox = draw.textbbox((0, 0), title, font=title_font)
    sub_bbox = draw.textbbox((0, 0), subtitle, font=sub_font)
    title_w = title_bbox[2] - title_bbox[0]
    sub_w = sub_bbox[2] - sub_bbox[0]

    gap_logo_title = 36
    gap_title_sub = 22
    title_span = title_bbox[3] - title_bbox[1]
    sub_span = sub_bbox[3] - sub_bbox[1]
    text_stack_h = title_span + gap_title_sub + sub_span

    group_w = logo.width + gap_logo_title + max(title_w, sub_w)
    group_h = max(logo.height, text_stack_h)

    # Center the block in the canvas, respecting margins (content stays in safe zone).
    cx = margin + (W - 2 * margin - group_w) // 2
    cy = margin + (H - 2 * margin - group_h) // 2

    logo_x = cx
    logo_y = cy + (group_h - logo.height) // 2
    base.alpha_composite(logo, (logo_x, logo_y))

    text_block_left = logo_x + logo.width + gap_logo_title
    title_x = text_block_left
    # Stack using ink bounds: subtitle top = title bottom + gap (avoids overlap when bbox[1] != 0).
    text_stack_top = cy + (group_h - text_stack_h) // 2
    title_y = text_stack_top - title_bbox[1]
    draw.text((title_x, title_y), title, font=title_font, fill=(245, 247, 250, 255))

    sub_x = text_block_left
    sub_y = title_y + title_bbox[3] + gap_title_sub - sub_bbox[1]
    draw.text((sub_x, sub_y), subtitle, font=sub_font, fill=(180, 190, 205, 255))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.unlink(missing_ok=True)
    base.convert("RGB").save(out_path, format="PNG", optimize=True)


def main():
    from PIL import Image, ImageFilter

    root = Path(__file__).resolve().parents[1]  # agent/
    repo = root.parent
    svg_path = repo / "frontend" / "public" / "favicon.svg"
    if not svg_path.is_file():
        svg_path = root / "ui-src" / "public" / "favicon.svg"
    if not svg_path.is_file():
        raise SystemExit(f"Missing favicon SVG (tried frontend/ and agent ui-src/)")

    spec = parse_frontend_favicon(svg_path)

    out_dir = root / "wix" / "assets"
    out_dir.mkdir(parents=True, exist_ok=True)

    BANNER = (493, 58)
    DIALOG = (493, 312)

    bg1 = (14, 20, 30)
    bg2 = (35, 55, 90)
    # Flat light panel: WiX draws black titles/subtitles here — keep it uniform, no dark under the text.
    panel = (244, 246, 250)

    # Top banner: keep the text area clean but replace the default WiX red disc by providing
    # our own banner with a small right-aligned branded tile.
    strip_w = 150
    img = Image.new("RGB", BANNER, panel)
    tile = vertical_gradient((44, 44), bg1, bg2).filter(ImageFilter.GaussianBlur(radius=2))
    # paste as RGB (no alpha in BMP)
    tx = BANNER[0] - 44 - 10
    ty = (BANNER[1] - 44) // 2
    img.paste(tile, (tx, ty))
    logo = render_favicon_rgba(spec, 22)
    lx = tx + (44 - logo.width) // 2
    ly = ty + (44 - logo.height) // 2
    img.paste(logo, (lx, ly), logo)
    (out_dir / "wix-banner.bmp").unlink(missing_ok=True)
    img.save(out_dir / "wix-banner.bmp", format="BMP")

    # Side graphic: single vertical strip + logo (this is the only branding image).
    img = Image.new("RGB", DIALOG, (242, 244, 248))
    left_panel = vertical_gradient((strip_w, DIALOG[1]), (11, 16, 24), (22, 34, 55))
    img.paste(left_panel, (0, 0))
    mark = render_favicon_rgba(spec, 96)
    mx = max(0, (strip_w - mark.width) // 2)
    my = (DIALOG[1] - mark.height) // 2
    img.paste(mark, (mx, my), mark)
    (out_dir / "wix-dialog.bmp").unlink(missing_ok=True)
    img.save(out_dir / "wix-dialog.bmp", format="BMP")

    repo_license = repo / "LICENSE"
    write_license_rtf(out_dir / "license.rtf", repo_license)

    ico_path = root / "icons" / "icon.ico"
    write_app_icon_ico(ico_path, spec)

    readme_banner_path = repo / ".github" / "images" / "readme-banner.png"
    write_readme_banner_png(readme_banner_path, spec)

    repo_social_path = repo / ".github" / "images" / "github-repo-social-card.png"
    write_github_repo_social_card_png(repo_social_path, spec)

    print(f"Wrote {out_dir / 'wix-banner.bmp'}")
    print(f"Wrote {out_dir / 'wix-dialog.bmp'}")
    print(f"Wrote {out_dir / 'license.rtf'}")
    print(f"Wrote {ico_path} (from {svg_path})")
    print(f"Wrote {readme_banner_path}")
    print(f"Wrote {repo_social_path} (GitHub repo Settings -> General -> Social preview)")


if __name__ == "__main__":
    main()
