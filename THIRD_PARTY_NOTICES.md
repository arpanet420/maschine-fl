# Third-party notices

maschine-fl contains no source files from the projects below, but some protocol facts and one
table were taken from them, and their authors are credited here. See also the Acknowledgements in `README.md`.

## cabl (MIT)

The Maschine LED colour palette (the 16 colours and their hue angles in `src/hw/palette.ts`, and the
indexed LED mapping that `ni-controllers-lib` carries over from cabl) comes from
[cabl](https://github.com/shaduzlabs/cabl) by Vincenzo Pacella.

```
The MIT License (MIT)

Copyright (c) 2015 Vincenzo Pacella

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ni-controllers-lib (ISC)

The first map of the MK3's HID reports (button bits, knob and touch-strip offsets, LED addresses and
the display frame format) was read from
[ni-controllers-lib](https://github.com/asutherland/ni-controllers-lib) by Andrew Sutherland (ISC
licence), itself a fork of [node-traktor-f1](https://github.com/met5678/node-traktor-f1). mk3d does
not include its code; every offset was re-checked on a real device, and the places where it differed
are written down in `docs/protocol.md`.

## Projects that were only read

These were studied for how they work. Nothing was copied from them.

- [Aftalyfe/MaschineMK3FLStudioScript](https://github.com/Aftalyfe/MaschineMK3FLStudioScript):
  an FL Studio script for the MK3 that works through NI's Controller Editor (no licence file).
- [terminar/rebellion](https://github.com/terminar/rebellion) (LGPL-3.0): an approach that talks to
  NI's own agents instead of the USB device.
- [IL-Group/FL-Studio-API-Stubs](https://github.com/IL-Group/FL-Studio-API-Stubs) (LGPL-3.0): Image-Line's
  type stubs and documentation of FL Studio's MIDI scripting API, used to check names, arguments and
  versions.
