#!/usr/bin/env python3
"""Tests for tools/blackout/blackout.py.

Every image here is made by the test itself, with invented text (the fake
key API_KEY=sk-test-000, invented names and amounts); no real screenshot is
used. Three groups, each skipped when what it needs is missing:
  - pure Python: box parsing, OCR folding, word matching, format sniffing;
  - ImageMagick: redact and crop, checked pixel by pixel;
  - ImageMagick, Tesseract and a font: the end-to-end leak check. A
    synthetic screenshot's planted secrets must be readable before (the
    negative control: else the test proves nothing), boxes from `words`
    must cover every pixel of their ink, OCR must no longer read them, and
    the text meant to stay must still be read (proof that OCR ran).

Run: python3 tools/blackout/test/test_blackout.py
Prints PASS, FAIL and SKIP lines, then "N passed, M failed" (the installer
tests' format; install/test/blackout.test.sh runs this file).
"""
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import traceback
import zlib

HERE = os.path.dirname(os.path.realpath(__file__))
TOOL = os.path.join(os.path.dirname(HERE), "blackout.py")
sys.path.insert(0, os.path.dirname(HERE))
import blackout  # noqa: E402

PASSED = 0
FAILED = 0
WORK = tempfile.mkdtemp(prefix="blackout-test-")


def ok(name):
    global PASSED
    PASSED += 1
    print("PASS  " + name)


def bad(name, why=""):
    global FAILED
    FAILED += 1
    print("FAIL  " + name)
    for line in str(why).splitlines()[-12:]:
        print("      | " + line)


# BLACKOUT_TEST_REQUIRE=1 (CI with every tool installed): a skip is a failure.
REQUIRE = os.environ.get("BLACKOUT_TEST_REQUIRE") == "1"


def skip(name, why):
    if REQUIRE:
        bad("%s: skipped, but BLACKOUT_TEST_REQUIRE=1" % name, why)
    else:
        print("SKIP  %s (%s)" % (name, why))


def check(name, cond, why=""):
    if cond:
        ok(name)
    else:
        bad(name, why)


def path(name):
    return os.path.join(WORK, name)


def tool(*args):
    """Run blackout.py as a user would. Returns (exit code, stdout+stderr)."""
    p = subprocess.run([sys.executable, "-I", "-B", TOOL] + list(args),
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return p.returncode, p.stdout.decode("utf-8", "replace")


# ------------------------------------------------------------------ helpers

IM = None
try:
    IM = blackout.ImageMagick()
except blackout.ToolError:
    pass
HAVE_TESSERACT = bool(shutil.which("tesseract"))

# A font file to draw test text with, so the text does not depend on
# ImageMagick's default font being installed. None: ImageMagick's default.
FONT = next((f for f in (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
) if os.path.isfile(f)), None)
FONT_ARGS = ["-font", FONT] if FONT else []


def magick(*args):
    return IM(list(args))


def rgba(img):
    """(width, height, raw RGBA bytes) of an image, read by ImageMagick."""
    out = magick(img, "-format", "%w %h", "info:").decode().split()
    w, h = int(out[0]), int(out[1])
    return w, h, magick(img, "-depth", "8", "rgba:-")


def pixel(raw, w, x, y):
    i = (y * w + x) * 4
    return raw[i:i + 4]


def chunk_types(img):
    with open(img, "rb") as f:
        data = f.read()
    i, kinds = 8, []
    while i + 8 <= len(data):
        n = struct.unpack(">I", data[i:i + 4])[0]
        kinds.append(data[i + 4:i + 8].decode("latin-1"))
        i += 12 + n
    return kinds


def png_with_text_chunk(src, dest, keyword, text):
    """Copy a PNG with one more tEXt chunk after IHDR (metadata to strip)."""
    with open(src, "rb") as f:
        data = f.read()
    body = keyword.encode() + b"\x00" + text.encode()
    chunk = struct.pack(">I", len(body)) + b"tEXt" + body
    chunk += struct.pack(">I", zlib.crc32(b"tEXt" + body) & 0xffffffff)
    ihdr_end = 8 + 12 + 13
    with open(dest, "wb") as f:
        f.write(data[:ihdr_end] + chunk + data[ihdr_end:])


def jpeg_with_orientation(src, dest, orientation):
    """Copy a JPEG with an EXIF block whose one tag is Orientation."""
    with open(src, "rb") as f:
        data = f.read()
    tiff = (b"MM\x00\x2a" + struct.pack(">I", 8) + struct.pack(">H", 1)
            + struct.pack(">HHIHH", 0x0112, 3, 1, orientation, 0) + struct.pack(">I", 0))
    app1 = b"Exif\x00\x00" + tiff
    with open(dest, "wb") as f:
        f.write(data[:2] + b"\xff\xe1" + struct.pack(">H", len(app1) + 2) + app1 + data[2:])


def run_test(fn):
    try:
        fn()
    except Exception:
        bad(fn.__name__, traceback.format_exc())


# ------------------------------------------------------------------ pure Python

def test_parse_box():
    p = blackout.parse_box
    check("box: x1,y1,x2,y2 parses", p("1,2,30,40", 100, 50) == (1, 2, 30, 40))
    check("box: spaces are allowed", p(" 1, 2 ,30,40 ", 100, 50) == (1, 2, 30, 40))
    check("box: the whole image is allowed", p("0,0,100,50", 100, 50) == (0, 0, 100, 50))
    for b in ("1,2,3", "1,2,3,4,5", "a,b,c,d", "1.5,2,3,4", "", "1;2;3;4"):
        try:
            p(b, 100, 50)
            bad("box: %r is refused" % b, "it parsed")
        except blackout.Refused:
            ok("box: %r is refused" % b)
    for b in ("5,5,5,9", "9,5,5,9", "0,0,101,10", "0,0,10,51", "-1,0,10,10"):
        try:
            p(b, 100, 50)
            bad("box: %r (empty or outside a 100x50 image) is refused" % b, "it parsed")
        except blackout.Refused:
            ok("box: %r (empty or outside a 100x50 image) is refused" % b)


def test_fold_and_match():
    f = blackout.fold
    check("fold: case, spaces and punctuation are dropped", f("API_KEY = Sk-Test") == "apikeysktest")
    check("fold: i, l, 1 and | are one letter; o and 0 one", f("Del1a|0") == f("Deliaio") == "deiiaio")
    check("fold: an amount survives a comma read as a dot", f("$4,200") == f("$4.200"))
    check("fold: accents are dropped, so José Núñez is josenunez", f("José Núñez") == "josenunez")
    rp = blackout.readable_part
    lines = ["Reply to bexample.com today", "Weekly digest"]
    check("part: a partly covered address is caught, with its line",
          rp("jane.roe@example.com", lines) == ("exampi", "Reply to bexample.com today"))
    check("part: the whole text, when read, is returned whole", rp("today", lines) == ("today", ""))
    check("part: a whole text split over two lines is still read", rp("today Weekly", lines)[0] == "todayweekiy")
    check("part: a text not read gives nothing", rp("Marcus Vane", lines) == ("", ""))
    check("part: a run of letters across two lines is not a part", rp("odayweXXX", lines) == ("", ""))
    check("part: a short text must be read whole", rp("roe", ["rot"]) == ("", ""))
    m = blackout.word_matches
    check("match: a word of a phrase matches", m("Vane:", "Marcus Vane"))
    check("match: a fragment OCR split off matches", m("sk-test", "API_KEY=sk-test-000"))
    check("match: another word does not", not m("Friday", "Marcus Vane"))
    check("match: a two-letter word does not match inside a phrase", not m("in", "Brindlewick Labs"))


def test_sniff():
    s = blackout.sniff
    check("sniff: PNG", s(b"\x89PNG\r\n\x1a\n" + b"\x00" * 8) == "png")
    check("sniff: JPEG", s(b"\xff\xd8\xff\xe0" + b"\x00" * 8) == "jpeg")
    check("sniff: GIF", s(b"GIF89a" + b"\x00" * 8) == "gif")
    check("sniff: WebP", s(b"RIFF\x00\x00\x00\x00WEBP") == "webp")
    check("sniff: text is not an image", s(b"push graphic-context\n") is None)
    check("sniff: SVG is not accepted", s(b"<svg xmlns='http://www.w3.org/2000/svg'>") is None)


def test_png_orientation_chunk():
    # ImageMagick 7.1.2 writes an orNT (orientation) chunk; redact accepts it
    # only as 1 (top-left). png_info must read its value.
    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xffffffff)
    for value in (1, 6):
        data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 1, 8, 2, 0, 0, 0))
                + chunk(b"orNT", bytes([value])) + chunk(b"IDAT", zlib.compress(b"\x00" + b"\xff" * 6))
                + chunk(b"IEND", b""))
        f = path("ornt-%d.png" % value)
        with open(f, "wb") as out:
            out.write(data)
        check("png: an orNT chunk of %d is read as %d" % (value, value), blackout.png_info(f)[4] == value)


# ------------------------------------------------------------------ ImageMagick

def make_noise(name, w=120, h=80, alpha=False):
    """A deterministic image whose every pixel differs from black."""
    out = path(name)
    fill = "rgba(40,160,220,0.5)" if alpha else "#28a0dc"
    magick("-size", "%dx%d" % (w, h), "gradient:#ffcc00-#28a0dc", "-fill", fill,
           "-draw", "circle 60,40 60,10", "-depth", "8", "PNG32:" + out)
    return out


def test_redact_pixels():
    src = make_noise("noise.png")
    out = path("noise-out.png")
    rc, msg = tool("redact", src, out, "10,5,40,25", "100,60,120,80")
    check("redact: exit 0", rc == 0, msg)
    w, h, before = rgba(src)
    w2, h2, after = rgba(out)
    check("redact: same size as the input", (w, h) == (w2, h2), "%sx%s vs %sx%s" % (w, h, w2, h2))
    boxes = [(10, 5, 40, 25), (100, 60, 120, 80)]
    inside = lambda x, y: any(x1 <= x < x2 and y1 <= y < y2 for x1, y1, x2, y2 in boxes)
    wrong_in, wrong_out = 0, 0
    for y in range(h):
        for x in range(w):
            if inside(x, y):
                wrong_in += pixel(after, w, x, y) != b"\x00\x00\x00\xff"
            else:
                wrong_out += pixel(after, w, x, y) != pixel(before, w, x, y)
    check("redact: every pixel inside a box is opaque black", wrong_in == 0, "%d pixels not black" % wrong_in)
    check("redact: no pixel outside the boxes changed", wrong_out == 0, "%d pixels changed" % wrong_out)
    check("redact: box edges are exact (x2,y2 are outside the box)",
          pixel(after, w, 40, 10) == pixel(before, w, 40, 10)
          and pixel(after, w, 39, 24) == b"\x00\x00\x00\xff"
          and pixel(after, w, 39, 25) == pixel(before, w, 39, 25))


def test_redact_alpha():
    src = make_noise("alpha.png", alpha=True)
    out = path("alpha-out.png")
    rc, msg = tool("redact", src, out, "50,30,70,50")
    w, _, after = rgba(out)
    check("redact, see-through input: exit 0", rc == 0, msg)
    check("redact, see-through input: the box is opaque black over it",
          all(pixel(after, w, x, y) == b"\x00\x00\x00\xff" for x in range(50, 70) for y in range(30, 50)))
    check("redact, see-through input: every pixel of the output is opaque", after[3::4] == b"\xff" * (len(after) // 4))


def test_redact_hidden_layer():
    # Colour stored under fully transparent pixels is invisible, but anyone
    # can read it back by dropping the alpha channel. The output must not
    # carry it: see-through parts are laid on white.
    src = path("hidden.png")
    magick("-size", "60x30", "xc:#102030", "-fill", "#ff0000", "-draw", "rectangle 5,5 40,20",
           "-alpha", "set", "-channel", "A", "-evaluate", "set", "0", "+channel", "PNG32:" + src)
    w, h, before = rgba(src)
    check("hidden layer: the test input stores colour under alpha 0",
          pixel(before, w, 10, 10)[:3] == b"\xff\x00\x00" and pixel(before, w, 10, 10)[3] == 0)
    out = path("hidden-out.png")
    rc, msg = tool("redact", src, out)
    _, _, after = rgba(out)
    check("hidden layer: redact exits 0", rc == 0, msg)
    check("hidden layer: every output pixel is opaque white (nothing under it)",
          after == b"\xff\xff\xff\xff" * (w * h), "first pixel %r" % after[:4])
    kinds = chunk_types(out)
    check("hidden layer: the output has no transparency chunk", "tRNS" not in kinds, str(kinds))


def test_redact_strips_metadata():
    src = make_noise("meta-src.png")
    tagged = path("meta.png")
    png_with_text_chunk(src, tagged, "Comment", "owner jane.roe@example.com")
    check("metadata: the test input does carry a text chunk", "tEXt" in chunk_types(tagged))
    out = path("meta-out.png")
    rc, msg = tool("redact", tagged, out)
    kinds = chunk_types(out)
    check("metadata: redact with no boxes exits 0 (a clean working copy)", rc == 0, msg)
    left = [k for k in kinds if k in ("tEXt", "zTXt", "iTXt", "eXIf", "tIME", "iCCP")]
    check("metadata: no text, EXIF, time or profile chunk is left", not left, "left: %s" % left)
    with open(out, "rb") as f:
        check("metadata: the comment's text is gone from the file", b"jane.roe" not in f.read())


def test_redact_refusals():
    src = make_noise("refuse.png")
    out = path("refused.png")
    for args, what in ((["1,2,3"], "a malformed box"), (["0,0,121,10"], "a box outside the image"),
                       (["10,10,5,20"], "an empty box")):
        rc, msg = tool("redact", src, out, *args)
        check("refused: %s exits 2" % what, rc == 2, msg)
        check("refused: %s writes nothing" % what, not os.path.exists(out))
    rc, msg = tool("redact", src, path("out.jpg"), "1,1,5,5")
    check("refused: a non-PNG output exits 2", rc == 2, msg)
    text = path("not-an-image.png")
    with open(text, "w") as f:
        f.write("push graphic-context\nviewbox 0 0 10 10\npop graphic-context\n")
    rc, msg = tool("redact", text, out)
    check("refused: a file that is not an image exits 2", rc == 2 and "is not a PNG" in msg, msg)
    gif = path("two-frames.gif")
    magick("-size", "20x20", "xc:red", "xc:blue", gif)
    rc, msg = tool("redact", gif, out)
    check("refused: an image with two frames exits 2", rc == 2 and "2 frames" in msg, msg)
    check("refused: nothing was written by any refusal", not os.path.exists(out))


def test_redact_odd_names_and_passes():
    # ImageMagick reads "name:" and "name[...]" as commands; the tool feeds
    # it bytes, never the name, so such names are plain files.
    src = make_noise("odd.png")
    odd = path("x:frame[1] 100%d.png")
    shutil.copyfile(src, odd)
    out = path("odd out[2] %d.png")
    rc, msg = tool("redact", odd, out, "0,0,10,10")
    check("odd names: a file called 'x:frame[1] 100%d.png' redacts", rc == 0 and os.path.exists(out), msg)
    rc, msg = tool("redact", out, out, "20,20,30,30")
    w, _, after = rgba(out)
    check("passes: a second pass on the output keeps the first pass's box",
          rc == 0 and pixel(after, w, 5, 5) == b"\x00\x00\x00\xff"
          and pixel(after, w, 25, 25) == b"\x00\x00\x00\xff", msg)
    leftovers = [n for n in os.listdir(WORK) if n.startswith(".blackout-")]
    check("passes: no temporary file is left beside the output", not leftovers, str(leftovers))


def test_page_offset():
    # An image cropped without +repage keeps a page offset; every command
    # must still count from the image's own top-left pixel.
    src = path("offset.png")
    magick("-size", "800x200", "xc:white", "-fill", "#00ff00", "-draw", "rectangle 300,0 399,199",
           "-crop", "600x200+200+0", src)
    out = path("offset-crop.png")
    rc, msg = tool("crop", src, out, "100,0,200,10")
    w, _, c = rgba(out)
    check("page offset: crop reads the image's own pixels",
          rc == 0 and pixel(c, w, 0, 0) == b"\x00\xff\x00\xff" and pixel(c, w, 99, 9) == b"\x00\xff\x00\xff", msg)
    out = path("offset-red.png")
    rc, msg = tool("redact", src, out, "0,0,10,10")
    w, _, r = rgba(out)
    check("page offset: redact boxes the image's own pixels",
          rc == 0 and pixel(r, w, 5, 5) == b"\x00\x00\x00\xff" and pixel(r, w, 105, 5) == b"\x00\xff\x00\xff", msg)


def test_orientation_and_jpeg_metadata():
    # A JPEG whose EXIF says "rotate 90 degrees to show": every command uses
    # the displayed image. Its EXIF and comment must not reach the output.
    src = path("orient-src.png")
    magick("-size", "200x100", "xc:#0000ff", "-fill", "#ff0000", "-draw", "rectangle 0,0 49,49", src)
    plain = path("orient-plain.jpg")
    magick(src, "-set", "comment", "owner jane.roe@example.com", "-quality", "95", plain)
    jpg = path("orient.jpg")
    jpeg_with_orientation(plain, jpg, 6)   # 6: turn 90 degrees clockwise to show
    rc, msg = tool("info", jpg)
    check("orientation: info gives the displayed size (100 x 200)", rc == 0 and "100 x 200" in msg, msg)
    out = path("orient-out.png")
    rc, msg = tool("redact", jpg, out)
    w, h, r = rgba(out)
    red = pixel(r, w, w - 10, 10)
    check("orientation: the output is the image as displayed",
          rc == 0 and (w, h) == (100, 200) and red[0] > 200 and red[2] < 60, "%sx%s %r" % (w, h, red))
    kinds = chunk_types(out)
    with open(out, "rb") as f:
        data = f.read()
    check("jpeg metadata: only image chunks in the output", set(kinds) <= {"IHDR", "IDAT", "IEND", "gAMA", "cHRM", "sRGB", "bKGD", "pHYs", "orNT"}, str(kinds))
    check("jpeg metadata: the comment's text is gone", b"jane.roe" not in data and b"Exif" not in data)


def test_file_errors():
    src = make_noise("errors.png")
    folder = path("a-folder.png")
    os.makedirs(folder, exist_ok=True)
    rc, msg = tool("redact", src, folder)
    check("file errors: an output that is a folder exits 2", rc == 2, msg)
    rc, msg = tool("redact", path("no-such-file.png"), path("x.png"))
    check("file errors: a missing input exits 2", rc == 2, msg)
    if hasattr(os, "geteuid") and os.geteuid() != 0:
        locked = path("locked")
        os.makedirs(locked, exist_ok=True)
        os.chmod(locked, 0o500)
        rc, msg = tool("redact", src, os.path.join(locked, "out.png"))
        os.chmod(locked, 0o700)
        check("file errors: a folder it cannot write to exits 2, not 1", rc == 2 and "Traceback" not in msg, msg)
        check("file errors: the message names the output, not a temporary file",
              os.path.join(locked, "out.png") in msg and ".blackout-" not in msg, msg)
    out = path("mode.png")
    old = os.umask(0o022)
    try:
        rc, msg = tool("redact", src, out)
    finally:
        os.umask(old)
    check("file errors: the output's mode follows the umask (0644 under 022)",
          rc == 0 and (os.stat(out).st_mode & 0o777) == 0o644, oct(os.stat(out).st_mode & 0o777))


def test_crop():
    src = make_noise("crop-src.png")
    out = path("crop.png")
    rc, msg = tool("crop", src, out, "10,20,50,40")
    w, h, c = rgba(out)
    sw, _, s = rgba(src)
    check("crop: exit 0", rc == 0, msg)
    check("crop: the size is the box's", (w, h) == (40, 20), "%sx%s" % (w, h))
    check("crop: the pixels are the box's", pixel(c, w, 0, 0) == pixel(s, sw, 10, 20)
          and pixel(c, w, 39, 19) == pixel(s, sw, 49, 39))
    rc, msg = tool("crop", src, out, "10,20,50,40", "--scale", "3")
    w, h, c = rgba(out)
    check("crop --scale 3: three times the size, pixels kept sharp",
          rc == 0 and (w, h) == (120, 60) and pixel(c, w, 2, 2) == pixel(s, sw, 10, 20), msg)
    rc, msg = tool("crop", src, out, "10,20,50,40", "--scale", "9")
    check("crop --scale 9: refused", rc == 2, msg)


def test_info_and_jpeg():
    src = make_noise("info.png", w=123, h=45)
    rc, msg = tool("info", src)
    check("info: prints the size", rc == 0 and "123 x 45" in msg, msg)
    jpg = path("photo.jpg")
    magick(src, "-quality", "90", jpg)
    out = path("photo-out.png")
    rc, msg = tool("redact", jpg, out, "0,0,10,10")
    check("jpeg: a JPEG input gives a PNG output", rc == 0 and chunk_types(out)[0] == "IHDR", msg)


# ------------------------------------------------------------------ end to end (OCR)

# The synthetic screenshot: (x, y, point size, colour, text, secret?), one
# piece of text each, so a secret's ink can be told from its neighbours'.
# Everything is invented; the secrets are the parts to black out.
PANEL_LIGHT = (20, 20, 879, 230)
PANEL_DARK = (20, 250, 879, 430)
LINES = [
    (40, 55, 14, "#222222", "Build failed on main: test_ingest timed out", None),
    (40, 90, 14, "#222222", "API_KEY=sk-test-000", "API_KEY=sk-test-000"),
    (40, 122, 11, "#333333", "Invoice for", None),
    (125, 122, 11, "#333333", "Marcus Vane", "Marcus Vane"),
    (300, 122, 11, "#333333", "$4,200", "$4,200"),
    (40, 150, 11, "#333333", "Reply to", None),
    (110, 150, 11, "#333333", "jane.roe@example.com", "jane.roe@example.com"),
    (40, 200, 24, "#222222", "Weekly digest", None),
    (40, 290, 14, "#e6e6e6", "Deploy pipeline green", None),
    (40, 330, 14, "#e6e6e6", "Brindlewick Labs", "Brindlewick Labs"),
    (220, 330, 14, "#e6e6e6", "term sheet", None),
    (40, 390, 26, "#e6e6e6", "Project", None),
    (190, 390, 26, "#e6e6e6", "Quillfeather", "Quillfeather"),
]
KEEP = ["Build failed", "test_ingest", "Weekly digest", "Deploy pipeline green"]


def render(dest, skip_index=None):
    args = ["-size", "900x450", "xc:#f4f5f7",
            "-fill", "#ffffff", "-draw", "rectangle %d,%d %d,%d" % PANEL_LIGHT,
            "-fill", "#1e1f24", "-draw", "rectangle %d,%d %d,%d" % PANEL_DARK]
    args += FONT_ARGS
    for i, (x, y, size, colour, text, _) in enumerate(LINES):
        if i == skip_index:
            continue
        args += ["-fill", colour, "-pointsize", str(size), "-annotate", "+%d+%d" % (x, y), text]
    magick(*(args + ["-depth", "8", "PNG32:" + dest]))


def footprint(full, without):
    """The pixels where one text's ink is: where the two renders differ."""
    w, h, a = rgba(full)
    _, _, b = rgba(without)
    pts = [(x, y) for y in range(h) for x in range(w) if pixel(a, w, x, y) != pixel(b, w, x, y)]
    return w, pts


def test_end_to_end():
    shot = path("screenshot.png")
    try:
        render(shot)
    except blackout.ToolError as e:
        skip("end to end", "ImageMagick could not draw text here: %s" % e)
        return
    secrets = [s for (_, _, _, _, _, s) in LINES if s]

    # 1. Negative control: OCR reads every planted secret in the clear.
    rc, msg = tool("check", shot, *secrets)
    if rc != 1 or msg.count("READABLE") != len(secrets):
        bad("end to end: OCR reads all %d planted secrets before redaction (negative control); "
            "without that this test proves nothing" % len(secrets), msg)
        return
    ok("end to end: OCR reads all %d planted secrets before redaction (negative control)" % len(secrets))

    # 2. Boxes from `words`, padded 3 pixels the way the agent does.
    args = []
    for s in secrets:
        args += ["--match", s]
    rc, msg = tool("words", shot, *args)
    boxes = []
    for line in msg.splitlines():
        if "\t" in line:
            x1, y1, x2, y2 = (int(v) for v in line.split("\t")[0].split(","))
            boxes.append("%d,%d,%d,%d" % (max(0, x1 - 3), max(0, y1 - 3), min(900, x2 + 3), min(450, y2 + 3)))
    check("end to end: words found boxes for the secrets", rc == 0 and len(boxes) >= len(secrets), msg)

    out = path("screenshot-out.png")
    rc, msg = tool("redact", shot, out, *boxes)
    check("end to end: redact with those boxes exits 0", rc == 0, msg)
    if rc != 0:
        return

    # 3. Every pixel of every secret's ink is black in the output.
    w, _, after = rgba(out)
    for i, line in enumerate(LINES):
        if not line[5]:
            continue
        without = path("without-%d.png" % i)
        render(without, skip_index=i)
        _, pts = footprint(shot, without)
        shown = [p for p in pts if pixel(after, w, p[0], p[1]) != b"\x00\x00\x00\xff"]
        check("end to end: every ink pixel of secret %d (%s, %dpt) is covered" % (i, line[5], line[2]),
              pts and not shown, "%d of %d ink pixels still show" % (len(shown), len(pts)))

    # 4. OCR no longer reads any secret, and still reads the text kept.
    rc, msg = tool("check", out, *secrets)
    check("end to end: OCR reads none of the secrets after redaction", rc == 0 and "READABLE" not in msg, msg)
    rc, msg = tool("check", out, *KEEP)
    check("end to end: OCR still reads the %d texts that stay (proof OCR ran)" % len(KEEP),
          rc == 1 and msg.count("READABLE") == len(KEEP), msg)
    rc, msg = tool("ocr", out)
    check("end to end: ocr prints the kept text and no secret",
          rc == 0 and "Weekly digest" in msg and "sk-test" not in msg and "Vane" not in msg, msg)

    # 5. words names a word of a phrase that was not read.
    rc, msg = tool("words", shot, "--match", "Zebrafinch Marcus")
    check("end to end: words names the word of a phrase it did not read",
          rc == 0 and "'Zebrafinch'" in msg and "Marcus" in msg, msg)


def test_check_edges():
    # A partial cover: only the user part of an address is boxed.
    shot = path("partial.png")
    magick("-size", "700x80", "xc:white", *FONT_ARGS, "-fill", "#222", "-pointsize", "18",
           "-annotate", "+20+45", "Reply to jane.roe@example.com today", shot)
    rc, msg = tool("words", shot, "--match", "jane.roe@example.com")
    first = [l for l in msg.splitlines() if "\t" in l]
    if rc != 0 or not first:
        bad("check edges: words finds the address", msg)
        return
    x1, y1, x2, y2 = (int(v) for v in first[0].split("\t")[0].split(","))
    half = x1 + (x2 - x1) * 4 // 10   # about "jane.roe"
    out = path("partial-out.png")
    rc, msg = tool("redact", shot, out, "%d,%d,%d,%d" % (max(0, x1 - 2), max(0, y1 - 2), half, y2 + 2))
    rc, msg = tool("check", out, "jane.roe@example.com")
    check("check edges: a partly covered address is PARTLY, exit 1", rc == 1 and "PARTLY" in msg, msg)

    # White text on a see-through ground shows on a dark page: read it.
    clear = path("clear.png")
    magick("-size", "500x80", "xc:none", *FONT_ARGS, "-fill", "white", "-pointsize", "22",
           "-annotate", "+20+50", "Order 55-0192 for Quillfeather", "PNG32:" + clear)
    rc, msg = tool("check", clear, "Quillfeather")
    check("check edges: white text on a clear ground is READABLE", rc == 1 and "READABLE" in msg, msg)

    # An accented name is matched without its accents.
    acc = path("accents.png")
    magick("-size", "500x80", "xc:white", *FONT_ARGS, "-fill", "#222", "-pointsize", "22",
           "-annotate", "+20+50", "Invoice for José Núñez", acc)
    rc, msg = tool("check", acc, "José Núñez")
    check("check edges: an accented name is READABLE or PARTLY, not 'not read'",
          rc == 1 and ("READABLE" in msg or "PARTLY" in msg), msg)

    # An image with no text: OCR read nothing, which proves nothing.
    blank = path("blank.png")
    magick("-size", "300x200", "xc:#f4f5f7", blank)
    rc, msg = tool("check", blank, "anything")
    check("check edges: no text read at all exits 3, never a clean 0", rc == 3 and "proves nothing" in msg, msg)
    rc, msg = tool("ocr", blank)
    check("check edges: ocr on an image with no text exits 3", rc == 3, msg)


def run_with_path(folder, *args):
    p = subprocess.run([sys.executable, "-I", "-B", TOOL] + list(args),
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env={"PATH": folder})
    return p.returncode, p.stdout.decode()


def test_tools_missing():
    # A missing tool stops OCR commands with exit 3 and the install line;
    # they never print an empty "clean" result.
    only_im = path("only-imagemagick")
    os.makedirs(only_im, exist_ok=True)
    os.symlink(IM.convert[0], os.path.join(only_im, os.path.basename(IM.convert[0])))
    img = make_noise("missing.png")
    rc, msg = run_with_path(only_im, "check", img, "x")
    check("no tesseract: check exits 3, not 0", rc == 3, msg)
    check("no tesseract: the message names Tesseract", "Tesseract is missing" in msg, msg)
    rc, msg = run_with_path(only_im, "words", img)
    check("no tesseract: words exits 3", rc == 3, msg)
    rc, msg = run_with_path(only_im, "redact", img, path("missing-out.png"), "1,1,5,5")
    check("no tesseract: redact still works", rc == 0, msg)
    empty = path("empty-path")
    os.makedirs(empty, exist_ok=True)
    rc, msg = run_with_path(empty, "check", img, "x")
    check("no tools: check exits 3, naming ImageMagick", rc == 3 and "ImageMagick is missing" in msg, msg)
    p = subprocess.run([sys.executable, "-I", "-B", TOOL, "doctor"],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env={"PATH": empty})
    msg = p.stdout.decode()
    check("missing tools: doctor exits 1 and lists both", p.returncode == 1
          and "missing  imagemagick" in msg and "missing  tesseract" in msg and "install:" in msg, msg)


def main():
    for fn in (test_parse_box, test_fold_and_match, test_sniff, test_png_orientation_chunk):
        run_test(fn)
    if IM is None:
        skip("redact, crop and end to end", "ImageMagick is not installed")
    else:
        for fn in (test_redact_pixels, test_redact_alpha, test_redact_hidden_layer,
                   test_redact_strips_metadata, test_redact_refusals,
                   test_redact_odd_names_and_passes, test_page_offset,
                   test_orientation_and_jpeg_metadata, test_file_errors, test_crop,
                   test_info_and_jpeg, test_tools_missing):
            run_test(fn)
        if HAVE_TESSERACT:
            run_test(test_end_to_end)
            run_test(test_check_edges)
        else:
            skip("end to end", "Tesseract is not installed")
    shutil.rmtree(WORK, ignore_errors=True)
    print()
    print("%d passed, %d failed" % (PASSED, FAILED))
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
