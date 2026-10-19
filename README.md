# Epicycles

**Draw any shape with spinning circles.** Epicycles takes a drawing, breaks it into
harmonics with the Fast Fourier Transform and rebuilds it as two chains of rotating
circles, live, in your browser.

One HTML file. Pure JavaScript and canvas. Zero dependencies, no build, no server.

## Quick start

Clone the repository and open `index.html` in a browser. It works straight from
`file://`: the built-in owl starts drawing right away. Or host the repository on
GitHub Pages and share the link: `index.html` is the page.

## What you can do

- **Watch the owl draw itself.** Two chains of circles, one on top for x and one on
  the left for y, steer the pen that traces the drawing.
- **Explore N.** The N slider (log₂ scale, 1–8192 harmonics) shows the curve getting
  sharper as harmonics are added. The live *approximation error* tells you how close
  the result is.
- **Load your own SVG.** Logos, lettering and outlines made of many pieces are
  stitched into one closed path and drawn. Real Inkscape and Illustrator exports
  (groups, transforms, clip paths, hidden layers) load as they look.
- **Compare with the original.** *Show original* lays the source outline under the
  trail. At high N they coincide.
- **Slow it down.** Pause, or choose a speed from 0.05× to 5×, to see how the
  circles add up. *Fade* lets the trail dissolve just before the pen comes back.
- **Light or dark.** A theme switch in the menu header. Your choice is remembered.
- **Any screen.** On a narrow window the side menu turns into a top bar with a
  sheet.

## How it works

1. **Path.** The SVG is parsed (paths, lines, polylines, circles, with transforms).
   Its fragments are joined into one closed loop: nearest neighbour first, then
   2-opt to untangle crossings. The loop is resampled to 2ⁿ evenly spaced points
   (8192 by default).
2. **Two real FFTs.** The x and y coordinates are transformed separately. Each gives
   its own set of harmonics:

   ```
   x(t) = Σ rₖ cos(kt + φₖ)        y(t) = Σ r'ₖ cos(kt + φ'ₖ)
   ```

   Each harmonic is one circle of radius rₖ turning at k revolutions per lap.
3. **Two chains.** Within each chain the circles are sorted from largest to
   smallest. The x chain runs along the top and the y chain down the left, turned
   by 90°. The pen sits where their tips meet.
4. **Honest drawing.** All N harmonics are summed, but only circles larger than
   half a pixel are drawn. The pen keeps the same pace relative to the shape's size
   for every drawing, so a dense SVG does not dot or rush.
5. **Error.** The RMS distance between the approximation and the original, divided
   by the diagonal of the original's bounding box, in percent. It is computed with
   an inverse FFT, so it keeps up while you drag the slider.

## Sample drawings

`src/patterns/` holds SVGs to try with *Load SVG*: an owl and a pine tree, plus ten
presets in `src/patterns/presets/` (infinity, trefoil, Lissajous curve, rose,
spiral, pentagram, T. rex, fox, letter A, yin-yang). All are public domain or CC0.
Each `SOURCES.md` lists the author, source page and licence of every file.

## Project layout

```
index.html              the whole application
src/patterns/           sample SVGs and their sources
  presets/              ten more presets
tests/fourier.test.js   test suite
```

## Tests

```sh
node --test tests/fourier.test.js
```

The tests use only Node's built-in runner. They load the real script from
`index.html` into `node:vm` with small hand-written DOM and canvas stubs, so
they exercise the shipped file and nothing else. They cover the FFT, the chains,
SVG parsing and stitching, the error, the trail and the controls.

## Credits

The sample drawings come from [Openclipart](https://openclipart.org) and
[Wikimedia Commons](https://commons.wikimedia.org). Their authors are listed in
`src/patterns/SOURCES.md` and `src/patterns/presets/SOURCES.md`.

## License

The code is released under the [MIT License](LICENSE). The sample drawings keep
their own licences (CC0 or public domain), listed in the `SOURCES.md` files.
