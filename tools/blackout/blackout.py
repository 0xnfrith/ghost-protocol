#!/usr/bin/env python3
"""blackout: cover parts of a screenshot with solid black boxes, and check
that nothing sensitive in it can still be read.

Usage:
  blackout.py doctor [--pins FILE]
  blackout.py info <image>
  blackout.py redact <input> <output.png> [BOX ...]
  blackout.py crop <input> <output.png> BOX [--scale N]
  blackout.py ocr <image>
  blackout.py words <image> [--match TEXT ...]
  blackout.py check <image> TEXT [TEXT ...]

A BOX is "x1,y1,x2,y2" in the image's own pixels. The origin is the top-left
corner; x1,y1 is the box's first pixel and x2,y2 is just past its last one,
so the box is x2-x1 pixels wide. Every command reads the image the way it is
displayed (EXIF orientation applied), and every coordinate refers to that.

  redact  Writes <output.png> with each box filled solid black. The output is
          opaque (see-through parts become white, so nothing can hide under
          them) and has no metadata (text chunks, EXIF, times, colour
          profiles). With no boxes it writes a clean copy to work from. It
          then checks its own output: the same size as the input, every
          pixel opaque, every box pixel black, no metadata left. A malformed
          box, or one that reaches outside the image, stops it before
          anything is written.
  crop    Writes the part of the image inside BOX, enlarged N times (default
          1, pixels kept sharp), to look at small text at full resolution.
          Like redact's output, it is opaque, with no metadata.
  ocr     Prints every line of text Tesseract reads, pooled from several
          passes: the whole image, twice the size, inverted (light text on a
          dark background), and a 3x3 grid of overlapping tiles at twice the
          size. An image with see-through parts is read on white and on
          black. Reading no text at all is an error (exit 3): it proves
          nothing.
  words   Prints each word OCR finds as "x1,y1,x2,y2<TAB>confidence<TAB>word",
          in the image's pixels. --match (repeatable) keeps only the words of
          a text, for example --match "Jane Doe", and names any of its words
          that was not read.
  check   Runs the same OCR passes as ocr, and says which TEXTs can still be
          read: READABLE (all of it), PARTLY (six letters in a row of it are
          read within one line; it prints the part and the line) or "not
          read". A text of six letters or fewer must be read whole.
          Exit 1 when any is READABLE or PARTLY. It compares letters and
          digits only, ignoring case, accents, spaces and punctuation, and
          counts i, l, 1 and | as one letter, and o and 0 as one, because
          OCR confuses them. Reading no text at all is an error (exit 3).
  doctor  Checks for Python, ImageMagick and Tesseract at the minimum
          versions in install/pins.env, and prints how to install what is
          missing.

Inputs: PNG, JPEG, GIF, WebP, TIFF, BMP or HEIC, one frame. Outputs are PNG.

Exit codes: 0 ok; 1 check found readable text, or doctor found something
missing; 2 usage, or an input, output or box refused; 3 a tool is missing
or failed, or OCR read nothing.

OCR is a floor, not a ceiling: it misses text a person can read. Look at the
result as well.
"""
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import unicodedata
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.realpath(__file__))
DEFAULT_PINS = os.path.join(os.path.dirname(os.path.dirname(HERE)), "install", "pins.env")

# The OCR passes enlarge the whole image only up to this many pixels; the
# tiles still cover every part of a larger one.
MAX_UPSCALED_PIXELS = 100 * 1000 * 1000
TILE_GRID = 3
UPSCALE = 2

# PNG chunks an output may hold: the image itself and how to show its colours.
# Anything else (text, EXIF, times, profiles, transparency, unknown chunks)
# is refused. orNT (orientation; ImageMagick 7.1.2 writes it) is allowed only
# as 1, top-left: any other value would turn the image away from its boxes.
ALLOWED_CHUNKS = {b"IHDR", b"IDAT", b"IEND", b"gAMA", b"cHRM", b"sRGB", b"bKGD", b"pHYs", b"orNT"}

BLACK = b"\x00\x00\x00\xff"

# check's PARTLY: this many letters in a row of a text, read anywhere.
PART = 6


class Refused(Exception):
    """A usage error, or an input or box blackout will not work on (exit 2)."""


class ToolError(Exception):
    """A tool is missing, or a tool it ran failed (exit 3)."""


# ------------------------------------------------------------------ helpers

def version_tuple(text):
    return tuple(int(n) for n in re.findall(r"\d+", text)[:3])


def read_pins(path):
    pins = {}
    with open(path) as f:
        for line in f:
            m = re.match(r'^([A-Z0-9_]+)="([^"]*)"\s*$', line)
            if m:
                pins[m.group(1)] = m.group(2)
    return pins


def install_hint(names):
    """The command that installs these packages here (names: imagemagick, tesseract)."""
    if sys.platform == "darwin":
        pkgs = {"imagemagick": "imagemagick", "tesseract": "tesseract"}
        return "with Homebrew: brew install " + " ".join(pkgs[n] for n in names)
    if sys.platform.startswith("linux"):
        if shutil.which("apt-get"):
            pkgs = {"imagemagick": "imagemagick", "tesseract": "tesseract-ocr"}
            return "sudo apt-get install " + " ".join(pkgs[n] for n in names)
        if shutil.which("dnf"):
            pkgs = {"imagemagick": "ImageMagick", "tesseract": "tesseract tesseract-langpack-eng"}
            return "sudo dnf install " + " ".join(pkgs[n] for n in names)
        return "install " + " and ".join(names) + " with your package manager"
    return "install " + " and ".join(names) + " (Windows is not supported yet)"


def run(argv, what, stdin=None, env=None):
    try:
        p = subprocess.run(argv, input=stdin, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, env=env)
    except OSError as e:
        raise ToolError("%s could not start: %s" % (what, e))
    if p.returncode != 0:
        err = p.stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
        raise ToolError("%s failed (exit %d): %s" % (what, p.returncode, " | ".join(err) or "no message"))
    return p.stdout


class ImageMagick(object):
    """ImageMagick 7 (magick) or 6 (convert)."""

    def __init__(self):
        # On Windows, convert.exe is a system tool, not ImageMagick: Windows
        # support, when it comes, must use magick only.
        magick = shutil.which("magick")
        if magick:
            self.convert = [magick]
        else:
            convert = shutil.which("convert")
            if not convert:
                raise ToolError("ImageMagick is missing; " + install_hint(["imagemagick"]))
            self.convert = [convert]
        out = run(self.convert + ["-version"], "ImageMagick").decode("utf-8", "replace")
        m = re.search(r"ImageMagick (\d+(?:\.\d+)+(?:-\d+)?)", out)
        if not m:
            raise ToolError("%s is not ImageMagick" % self.convert[0])
        self.version = m.group(1)

    def __call__(self, args, stdin=None):
        return run(self.convert + args, "ImageMagick", stdin=stdin)


def tesseract():
    path = shutil.which("tesseract")
    if not path:
        raise ToolError("Tesseract is missing, so OCR cannot run; " + install_hint(["tesseract"]))
    return path


def sniff(data):
    """ImageMagick's name for the image format, from the file's first bytes."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff"
    if data[:2] == b"BM":
        return "bmp"
    if data[4:8] == b"ftyp" and data[8:12] in (b"heic", b"heix", b"mif1", b"msf1", b"heim", b"heis"):
        return "heic"
    return None


class Source(object):
    """An input image. Its bytes go to ImageMagick on stdin, with the format
    named, so neither the file's name nor its contents can choose another
    reader (ImageMagick treats some names, like "x:" or "a[1]", as commands)."""

    def __init__(self, path, im):
        try:
            with open(path, "rb") as f:
                self.data = f.read()
        except OSError as e:
            raise Refused("cannot read %s: %s" % (path, e.strerror))
        self.fmt = sniff(self.data)
        if not self.fmt:
            raise Refused("%s is not a PNG, JPEG, GIF, WebP, TIFF, BMP or HEIC image" % path)
        self.path = path
        self.im = im
        out = self.magick(["-format", "%w %h %[opaque]\n", "info:"]).decode().split()
        frames = len(out) // 3
        if frames != 1:
            raise Refused("%s has %d frames; save the one to redact as a PNG first" % (path, frames))
        self.width, self.height = int(out[0]), int(out[1])
        self.opaque = out[2].lower() == "true"

    def magick(self, args):
        """Run ImageMagick on this image, displayed the right way up, and
        with any page offset dropped, so every pixel is where a box says."""
        return self.im([self.fmt + ":-", "-auto-orient", "+repage"] + args, stdin=self.data)


def parse_box(text, width, height):
    m = re.match(r"^\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*$", text)
    if not m:
        raise Refused('box "%s" is not x1,y1,x2,y2 (four whole numbers)' % text)
    x1, y1, x2, y2 = (int(g) for g in m.groups())
    if x2 <= x1 or y2 <= y1:
        raise Refused('box "%s" is empty: x2 must be more than x1, and y2 more than y1' % text)
    if x1 < 0 or y1 < 0 or x2 > width or y2 > height:
        raise Refused('box "%s" reaches outside the image, which is %dx%d '
                      "(x 0 to %d, y 0 to %d); check that it uses this image's pixels"
                      % (text, width, height, width, height))
    return x1, y1, x2, y2


def png_info(path):
    """(width, height, colour type, chunk types, orNT value or None) of a PNG file."""
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ToolError("ImageMagick did not write a PNG")
    chunks, i, width, height, colour, orient = [], 8, None, None, None, None
    while i + 8 <= len(data):
        n = struct.unpack(">I", data[i:i + 4])[0]
        kind = data[i + 4:i + 8]
        if kind == b"IHDR":
            width, height = struct.unpack(">II", data[i + 8:i + 16])
            colour = data[i + 17]
        elif kind == b"orNT" and n >= 1:
            orient = data[i + 8]
        chunks.append(kind)
        i += 12 + n
    return width, height, colour, chunks, orient


def write_png(src, args, dest):
    """Render src through ImageMagick args into an opaque RGB PNG with no
    metadata. See-through pixels are laid on white first: the colour stored
    under a transparent pixel is invisible, but anyone can read it back by
    dropping the alpha channel. ImageMagick writes into a private folder;
    the file reaches dest only after the caller's checks pass (finish_png)."""
    work = tempfile.mkdtemp(prefix="blackout-")
    out = os.path.join(work, "out.png")
    try:
        src.magick(["-background", "white", "-alpha", "remove", "-alpha", "off"] + args
                   + ["-strip", "-define", "png:exclude-chunks=date,time", "PNG24:" + out])
    except Exception:
        shutil.rmtree(work, ignore_errors=True)
        raise
    return work, out


def finish_png(work, out, dest):
    """Move a checked PNG to dest in one step (a temp file beside dest, then
    a rename), so dest is never half written. Its mode follows the umask,
    like any new file."""
    try:
        d = os.path.dirname(os.path.abspath(dest))
        fd, tmp = tempfile.mkstemp(prefix=".blackout-", suffix=".png", dir=d)
        os.close(fd)
        try:
            shutil.copyfile(out, tmp)
            mask = os.umask(0)
            os.umask(mask)
            os.chmod(tmp, 0o666 & ~mask)
            os.replace(tmp, dest)
        except Exception:
            os.unlink(tmp)
            raise
    except OSError as e:
        raise Refused("cannot write %s: %s" % (dest, e.strerror or e))
    finally:
        shutil.rmtree(work, ignore_errors=True)


def check_png_output(dest):
    if not dest.lower().endswith(".png"):
        raise Refused("the output must be a .png file: %s" % dest)
    if os.path.isdir(dest):
        raise Refused("the output is a folder, not a file: %s" % dest)
    if not os.path.isdir(os.path.dirname(os.path.abspath(dest))):
        raise Refused("the output's folder does not exist: %s" % dest)


# ------------------------------------------------------------------ OCR

def fold(text):
    """Lower case, letters and digits only (accents dropped: José is jose),
    with OCR's usual confusions merged."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch)).lower()
    for a, b in (("l", "i"), ("1", "i"), ("|", "i"), ("0", "o")):
        text = text.replace(a, b)
    return re.sub(r"[^a-z0-9]", "", text)


def readable_part(text, lines):
    """What OCR read of text: (part, line). part is all of text (folded),
    matched across the lines OCR read, or a run of PART letters found within
    one line, which is then given; ("", "") when none of it was read."""
    t = fold(text)
    if t in fold(" ".join(lines)):
        return t, ""
    if len(t) > PART:
        for line in lines:
            fl = fold(line)
            for i in range(len(t) - PART + 1):
                if t[i:i + PART] in fl:
                    return t[i:i + PART], line
    return "", ""


def ocr_passes(src, work):
    """Prepare the OCR passes' images in work. Returns a list of
    (path, scale, x offset, y offset, page segmentation mode)."""
    w, h = src.width, src.height
    big = w * h * UPSCALE * UPSCALE <= MAX_UPSCALED_PIXELS
    scale = UPSCALE if big else 1
    tw, th = int(math.ceil(w / float(TILE_GRID))), int(math.ceil(h / float(TILE_GRID)))
    pad = max(30, min(tw, th) // 10)
    passes = []
    # See-through parts are laid on white, and also on black when there are
    # any (white text on a clear ground shows only on a dark one). Colour is
    # dropped: Tesseract reads grey text on a plain ground best.
    for ground in ("white",) if src.opaque else ("white", "black"):
        base = os.path.join(work, "%s-base.png" % ground)
        src.magick(["-background", ground, "-alpha", "remove", "-alpha", "off",
                    "-colorspace", "Gray", base])
        passes.append((base, 1, 0, 0, 3))
        if big:
            up = os.path.join(work, "%s-up.png" % ground)
            src.im([base, "-resize", "%d%%" % (100 * UPSCALE), up])
            passes.append((up, UPSCALE, 0, 0, 3))
        inv = os.path.join(work, "%s-inverted.png" % ground)
        src.im([base, "-resize", "%d%%" % (100 * scale), "-negate", inv])
        passes.append((inv, scale, 0, 0, 3))
        for r in range(TILE_GRID):
            for c in range(TILE_GRID):
                x, y = max(0, c * tw - pad), max(0, r * th - pad)
                cw, ch = min(tw + 2 * pad, w - x), min(th + 2 * pad, h - y)
                if cw <= 0 or ch <= 0:
                    continue
                tile = os.path.join(work, "%s-tile-%d-%d.png" % (ground, r, c))
                src.im([base, "-crop", "%dx%d+%d+%d" % (cw, ch, x, y), "+repage",
                        "-resize", "%d%%" % (100 * UPSCALE), tile])
                passes.append((tile, UPSCALE, x, y, 11))
    return passes


def run_tesseract(passes, tsv):
    tess = tesseract()
    env = dict(os.environ)
    env["OMP_THREAD_LIMIT"] = "1"   # one thread each; the passes run side by side

    def one(p):
        path, _, _, _, psm = p
        argv = [tess, path, "stdout", "-l", "eng", "--psm", str(psm)]
        if tsv:
            argv.append("tsv")
        return run(argv, "Tesseract", env=env).decode("utf-8", "replace")

    workers = max(1, min(8, os.cpu_count() or 1))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(one, passes))


def ocr_lines(src):
    work = tempfile.mkdtemp(prefix="blackout-")
    try:
        texts = run_tesseract(ocr_passes(src, work), tsv=False)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    seen, lines = set(), []
    for text in texts:
        for line in text.splitlines():
            line = " ".join(line.split())
            if line and line not in seen:
                seen.add(line)
                lines.append(line)
    if not any(fold(line) for line in lines):
        # Silence is not a clean result: OCR that reads nothing proves nothing.
        raise ToolError("OCR read no text at all in %s, so this proves nothing; check it by eye"
                        % src.path)
    return lines


def ocr_words(src):
    """Every word any pass found: (x1, y1, x2, y2, confidence, text), in the
    image's pixels, with each pass's duplicates merged."""
    work = tempfile.mkdtemp(prefix="blackout-")
    try:
        passes = ocr_passes(src, work)
        tsvs = run_tesseract(passes, tsv=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    found = []
    for (_, scale, ox, oy, _), tsv in zip(passes, tsvs):
        for row in tsv.splitlines()[1:]:
            f = row.split("\t")
            if len(f) < 12 or f[0] != "5" or not f[11].strip():
                continue
            left, top, wd, ht = (int(v) for v in f[6:10])
            conf = float(f[10])
            x1 = max(0, ox + left // scale)
            y1 = max(0, oy + top // scale)
            x2 = min(src.width, ox + -(-(left + wd) // scale))
            y2 = min(src.height, oy + -(-(top + ht) // scale))
            if x2 > x1 and y2 > y1:
                found.append([x1, y1, x2, y2, conf, f[11].strip(), scale])
    # The same word from several passes: an enlarged pass places it more
    # precisely, so its box wins; boxes from equally enlarged passes join.
    merged = []
    for wd in sorted(found, key=lambda v: (-v[6], -v[4])):
        for m in merged:
            if fold(m[5]) == fold(wd[5]) and overlap(m, wd) > 0.3:
                if wd[6] == m[6]:
                    m[0], m[1] = min(m[0], wd[0]), min(m[1], wd[1])
                    m[2], m[3] = max(m[2], wd[2]), max(m[3], wd[3])
                break
        else:
            merged.append(wd)
    merged.sort(key=lambda v: (v[1], v[0]))
    return [m[:6] for m in merged]


def overlap(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    small = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return inter / float(small) if small else 0.0


def word_matches(word, pattern):
    """A word is part of a pattern ("Jane Doe") when one of the pattern's
    words is in it, or it (three letters or more) is in one of them."""
    fw = fold(word)
    if not fw:
        return False
    for token in pattern.split():
        ft = fold(token)
        if ft and (ft in fw or (len(fw) >= 3 and fw in ft)):
            return True
    return False


# ------------------------------------------------------------------ commands

def cmd_doctor(args):
    pins_path = DEFAULT_PINS
    if args[:1] == ["--pins"] and len(args) == 2:
        pins_path = args[1]
    elif args:
        raise Refused("usage: blackout.py doctor [--pins FILE]")
    try:
        pins = read_pins(pins_path)
        need = {k: pins["BLACKOUT_%s_MIN_VERSION" % k.upper()]
                for k in ("python", "imagemagick", "tesseract")}
    except (OSError, KeyError) as e:
        raise ToolError("cannot read the minimum versions from %s (%s)" % (pins_path, e))
    bad = []

    def line(state, name, detail):
        print("%-9s%s: %s" % (state, name, detail))

    py = "%d.%d.%d" % sys.version_info[:3]
    if version_tuple(py) >= version_tuple(need["python"]):
        line("ok", "python", "%s (needs %s or newer)" % (py, need["python"]))
    else:
        line("too-old", "python", "%s; needs %s or newer" % (py, need["python"]))
        bad.append("python")

    try:
        im = ImageMagick()
        if version_tuple(im.version) >= version_tuple(need["imagemagick"]):
            line("ok", "imagemagick", "%s (needs %s or newer)" % (im.version, need["imagemagick"]))
        else:
            line("too-old", "imagemagick", "%s; needs %s or newer" % (im.version, need["imagemagick"]))
            bad.append("imagemagick")
    except ToolError:
        line("missing", "imagemagick", "redact, crop and the OCR passes need it (%s or newer)" % need["imagemagick"])
        bad.append("imagemagick")

    tess = shutil.which("tesseract")
    if not tess:
        line("missing", "tesseract", "the OCR leak check needs it (%s or newer, with English)" % need["tesseract"])
        bad.append("tesseract")
    else:
        try:
            out = run([tess, "--version"], "Tesseract").decode("utf-8", "replace")
        except ToolError:
            out = ""
        m = re.search(r"tesseract v?(\d+(?:\.\d+)+)", out)
        ver = m.group(1) if m else "unknown"
        langs = []
        try:
            langs = run([tess, "--list-langs"], "Tesseract").decode("utf-8", "replace").split()
        except ToolError:
            pass
        if not m or version_tuple(ver) < version_tuple(need["tesseract"]):
            line("too-old", "tesseract", "%s; needs %s or newer" % (ver, need["tesseract"]))
            bad.append("tesseract")
        elif "eng" not in langs:
            line("missing", "tesseract", "%s has no English data (eng)" % ver)
            bad.append("tesseract")
        else:
            line("ok", "tesseract", "%s with English (needs %s or newer)" % (ver, need["tesseract"]))

    if bad:
        pkgs = [b for b in bad if b != "python"]
        if pkgs:
            print("install: " + install_hint(pkgs))
        if "python" in bad:
            print("install: Python %s or newer" % need["python"])
        return 1
    return 0


def cmd_info(args):
    if len(args) != 1:
        raise Refused("usage: blackout.py info <image>")
    src = Source(args[0], ImageMagick())
    print("size    %d x %d pixels (width x height, as displayed)" % (src.width, src.height))
    print("format  %s" % src.fmt.upper())
    return 0


def cmd_redact(args):
    if len(args) < 2:
        raise Refused("usage: blackout.py redact <input> <output.png> [x1,y1,x2,y2 ...]")
    inp, dest, raw = args[0], args[1], args[2:]
    check_png_output(dest)
    src = Source(inp, ImageMagick())
    boxes = [parse_box(b, src.width, src.height) for b in raw]
    draw = []
    if boxes:
        # ImageMagick's rectangle includes both corners; a box's x2,y2 do not.
        prims = " ".join("rectangle %d,%d %d,%d" % (x1, y1, x2 - 1, y2 - 1) for x1, y1, x2, y2 in boxes)
        draw = ["+antialias", "-fill", "black", "-stroke", "none", "-draw", prims]
    work, out = write_png(src, draw, dest)
    try:
        w, h, colour, chunks, orient = png_info(out)
        if (w, h) != (src.width, src.height):
            raise ToolError("the output is %sx%s, not %dx%d as the input" % (w, h, src.width, src.height))
        if colour != 2:
            raise ToolError("the output is not an opaque RGB PNG (colour type %s)" % colour)
        extra = sorted(set(c.decode("latin-1") for c in chunks) - set(c.decode() for c in ALLOWED_CHUNKS))
        if extra:
            raise ToolError("the output still holds metadata or transparency chunks: " + ", ".join(extra))
        if orient not in (None, 1):
            raise ToolError("the output says to turn the image (orientation %d)" % orient)
        rgba = src.im([out, "-depth", "8", "rgba:-"])
        if len(rgba) != w * h * 4:
            raise ToolError("could not read the output's pixels back")
        if rgba[3::4] != b"\xff" * (w * h):
            raise ToolError("the output has see-through pixels")
        for x1, y1, x2, y2 in boxes:
            want = BLACK * (x2 - x1)
            for y in range(y1, y2):
                i = (y * w + x1) * 4
                if rgba[i:i + len(want)] != want:
                    raise ToolError("box %d,%d,%d,%d is not solid black in the output" % (x1, y1, x2, y2))
    except Exception:
        shutil.rmtree(work, ignore_errors=True)
        raise
    finish_png(work, out, dest)
    print("wrote %s (%dx%d, %d box%s)" % (dest, w, h, len(boxes), "" if len(boxes) == 1 else "es"))
    return 0


def cmd_crop(args):
    scale = 1
    if "--scale" in args:
        i = args.index("--scale")
        try:
            scale = int(args[i + 1])
        except (IndexError, ValueError):
            raise Refused("--scale needs a whole number from 1 to 8")
        if not 1 <= scale <= 8:
            raise Refused("--scale needs a whole number from 1 to 8")
        args = args[:i] + args[i + 2:]
    if len(args) != 3:
        raise Refused("usage: blackout.py crop <input> <output.png> x1,y1,x2,y2 [--scale N]")
    inp, dest, box = args
    check_png_output(dest)
    src = Source(inp, ImageMagick())
    x1, y1, x2, y2 = parse_box(box, src.width, src.height)
    ops = ["-crop", "%dx%d+%d+%d" % (x2 - x1, y2 - y1, x1, y1), "+repage"]
    if scale > 1:
        ops += ["-filter", "point", "-resize", "%d%%" % (100 * scale)]
    work, out = write_png(src, ops, dest)
    finish_png(work, out, dest)
    print("wrote %s (%dx%d at %dx)" % (dest, (x2 - x1) * scale, (y2 - y1) * scale, scale))
    return 0


def cmd_ocr(args):
    if len(args) != 1:
        raise Refused("usage: blackout.py ocr <image>")
    src = Source(args[0], ImageMagick())
    tesseract()
    for line in ocr_lines(src):
        print(line)
    return 0


def cmd_words(args):
    patterns = []
    rest = []
    i = 0
    while i < len(args):
        if args[i] == "--match":
            if i + 1 >= len(args) or not fold(args[i + 1]):
                raise Refused("--match needs a text with letters or digits")
            patterns.append(args[i + 1])
            i += 2
        else:
            rest.append(args[i])
            i += 1
    if len(rest) != 1:
        raise Refused("usage: blackout.py words <image> [--match TEXT ...]")
    src = Source(rest[0], ImageMagick())
    tesseract()
    words = ocr_words(src)
    for x1, y1, x2, y2, conf, text in words:
        if patterns and not any(word_matches(text, p) for p in patterns):
            continue
        print("%d,%d,%d,%d\t%.0f\t%s" % (x1, y1, x2, y2, conf, text))
    # Name each word of a pattern that no word read matches, so a phrase
    # found only in part does not pass for found.
    for p in patterns:
        for token in p.split():
            if fold(token) and not any(word_matches(text, token) for _, _, _, _, _, text in words):
                print("blackout: %r (of %r) was not read; find it by eye" % (token, p), file=sys.stderr)
    return 0


def cmd_check(args):
    if len(args) < 2:
        raise Refused("usage: blackout.py check <image> TEXT [TEXT ...]")
    texts = args[1:]
    for t in texts:
        if not fold(t):
            raise Refused("%r has no letters or digits to look for" % t)
    src = Source(args[0], ImageMagick())
    tesseract()
    lines = ocr_lines(src)
    found = 0
    for t in texts:
        part, line = readable_part(t, lines)
        if not part:
            print("%-10s %s" % ("not read", t))
            continue
        found += 1
        if part == fold(t):
            print("%-10s %s" % ("READABLE", t))
        else:
            print('%-10s %s (read: %s, in the line "%s")' % ("PARTLY", t, part, line))
        if len(fold(t)) < 4:
            print("           (a short text can match another word by chance)")
    print("check: %d of %d still readable in whole or part (OCR read %d lines)"
          % (found, len(texts), len(lines)))
    return 1 if found else 0


COMMANDS = {"doctor": cmd_doctor, "info": cmd_info, "redact": cmd_redact, "crop": cmd_crop,
            "ocr": cmd_ocr, "words": cmd_words, "check": cmd_check}


def main(argv):
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__.strip())
        return 0 if argv else 2
    cmd = COMMANDS.get(argv[0])
    if not cmd:
        print("blackout: unknown command %r; try --help" % argv[0], file=sys.stderr)
        return 2
    try:
        return cmd(argv[1:])
    except Refused as e:
        print("blackout: " + str(e), file=sys.stderr)
        return 2
    except ToolError as e:
        print("blackout: " + str(e), file=sys.stderr)
        return 3
    except OSError as e:
        # A file that cannot be read or written: refused (exit 1 means text).
        print("blackout: %s: %s" % (e.filename or "file", e.strerror or e), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
