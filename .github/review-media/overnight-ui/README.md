# Review media: run console focus and findings link

Captured from a local dev server running the fixture execution provider with
synthetic users and runs. The pixels are unedited; the clip is only trimmed at the start.

## escape-focus-before.png / escape-focus-after.png

The `/__gallery` fixture "A result that can be published", in headless WebKit
1280×900 (Playwright 1.63.0), cropped to the console element. The steps are
identical in both: click Publish result with the pointer, then press Escape.
WebKit, like Safari, doesn't focus a button on click.

- Before, RunConsole from 17d26d9: `document.activeElement` after Escape is
  `<body>`, so no control carries the focus ring.
- After, RunConsole from 3689ac5: focus is back on Publish result.

The header differs because the after revision also stops naming the person
who started the run (`@ada` is the gallery's synthetic actor).

## console-keyboard-after.mp4

11.5 s, headless Chromium 1100×720 at 3689ac5, keyboard only, on the live
console of a synthetic official run (`run_9603c0b753`). Tab to Publish result,
Enter opens the confirm, Escape returns to Publish result, Enter and Tab to
Publish, then Enter. The action shows its pending pulse, then focus moves to
the heading once the published result removes it. Tab to "Read what it
found", then Enter opens the run's page.

Limits: there are no Safari, Firefox or real-device captures, and the Discord
Activity tile isn't shown.
