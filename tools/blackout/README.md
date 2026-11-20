# blackout

`blackout.py` covers parts of a screenshot with solid black boxes and checks that nothing sensitive in it can still be read. The [blackout agent](../../agents/blackout.md) uses it. The agent starts with no context, plans what to redact, applies the boxes, then checks its own work with full-resolution crops and OCR until nothing sensitive is legible. You can also run the tool by hand.

It runs on Linux and macOS. Windows is not supported yet.

## What it needs

| Tool | Minimum | Used for | Install |
|---|---|---|---|
| Python 3 | 3.9 | the tool itself (standard library only) | Linux: usually present. macOS: the Command Line Tools (`xcode-select --install`). |
| ImageMagick | 6.9.10 | reading images, drawing boxes, crops, OCR preparation | Debian or Ubuntu: `sudo apt-get install imagemagick`. macOS with Homebrew: `brew install imagemagick`. |
| Tesseract | 4.1.0, with English | the OCR leak check | Debian or Ubuntu: `sudo apt-get install tesseract-ocr`. macOS with Homebrew: `brew install tesseract`. |

The minimum versions live in [`install/pins.env`](../../install/pins.env) (`BLACKOUT_*_MIN_VERSION`). They are checked and never downloaded. `python3 tools/blackout/blackout.py doctor` checks all three and prints the install line for what is missing. The installer's step 17 runs the same check and records it. A missing tool is a SKIP there, and never stops the install.

Without Tesseract you can still redact, but the OCR check cannot run. The agent then says so at the top of its report.

## Commands

```sh
B="python3 tools/blackout/blackout.py"
$B doctor                                       # what is installed, and what is missing
$B info shot.png                                # size in pixels
$B redact shot.png work.png                     # a clean PNG copy to work from (no boxes)
$B redact work.png out.png "40,70,172,84" ...   # black boxes
$B crop out.png zoom.png "30,60,300,120" --scale 3
$B words shot.png --match "Jane Doe"            # word boxes from OCR
$B ocr out.png                                  # all the text OCR reads
$B check out.png "Jane Doe" "API_KEY"           # exit 1 if any is still readable
```

- **Boxes** are `x1,y1,x2,y2` in the image's own pixels. The origin is the top-left corner, and x2,y2 is just past the box's last pixel.
- **Orientation:** every command reads the image as it is displayed, with EXIF orientation applied.
- **Inputs:** PNG, JPEG, GIF, WebP, TIFF, BMP or HEIC, one frame each. HEIC needs ImageMagick built with HEIC support.
- **Outputs** are always opaque PNG. See-through parts become white (see below).
- `blackout.py --help` has the details and the exit codes.

## What it guarantees

**`redact`**
- It refuses a malformed box, an empty box, or one that reaches outside the image, before it writes anything.
- The output is opaque. A see-through pixel still stores a colour, invisible until someone drops the alpha channel, so see-through parts are laid on white first and nothing can hide under them.
- After drawing, it reads its own output back. Otherwise nothing is written. It checks that:
  - the output is the input's size;
  - every pixel is opaque, and every pixel inside every box is black;
  - no metadata chunk remains: no text, EXIF, time, transparency or colour profile.
- Dropping the colour profile can shift colours slightly in a wide-gamut screenshot (Display P3, for example). That is the price of not carrying a profile's name.
- The output appears in one step (a temporary file beside it, then a rename), with the usual mode for a new file.

**`ocr`, `words` and `check`** pool several Tesseract passes, because OCR misses small text in a large frame:
- the whole image;
- the whole image at twice the size;
- twice the size inverted, for light text on dark;
- a 3x3 grid of overlapping tiles at twice the size.

An image with see-through parts gets every pass twice, laid on white and on black, because white text on a clear ground shows only on a dark page.

`check` says READABLE (all of a text is read), PARTLY (six letters in a row of it are read within one line, which catches a partial cover; it prints the part and the line) or "not read", and exits 1 for either of the first two. It compares letters and digits only. It ignores case, accents, spaces and punctuation, and counts i, l, 1 and | as one letter, and o and 0 as one, because OCR confuses them.

Silence is never a clean result. A tool that is missing or fails is an error (exit 3), and so is OCR that reads no text at all.

**ImageMagick never sees a file name.** The tool reads the image itself, names its format from the first bytes (only the formats listed above), and sends the bytes on stdin. ImageMagick treats some file names as instructions (`x:`, `name[1]`, `%d`), and some contents as scripts (MVG, SVG, MSL). Both are kept out this way.

**OCR is a floor, not a ceiling.** It misses text a person can read: faces, handwriting, stylised or partial text. The agent's crops are the real check, and a person should look at the result before it is shared.

## Tests

`python3 tools/blackout/test/test_blackout.py`, which [`install/test/run.sh`](../../install/test/run.sh) also runs as `blackout`. It needs no real screenshot: every image is generated by the test, with invented text such as `API_KEY=sk-test-000`. Each group skips when what it needs is missing.

- **Pure Python:** box parsing, OCR folding and format sniffing.
- **ImageMagick:** redact and crop, checked pixel by pixel; metadata stripping; refusals; odd file names.
- **ImageMagick and Tesseract, end to end:**
  - The planted secrets must be readable before redaction (the negative control).
  - The boxes from `words` must cover every pixel of each secret's ink.
  - OCR must no longer read any of the secrets afterwards.
  - The text meant to stay must still be read, which proves OCR ran.

`install/test/tools.test.sh` tests the installer's step 17 with stand-ins for `magick` and `tesseract`.

In CI, the `blackout-test` workflow installs ImageMagick and Tesseract on Linux (its macOS run is paused) and runs the tests with `BLACKOUT_TEST_REQUIRE=1`, which turns a skipped group into a failure.
