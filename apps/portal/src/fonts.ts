// Shared by the portal and the Discord Activity so both entry points set type
// the same way.
//
// Source Serif 4 with its optical-size axis: headings are set large, and the
// display cut keeps them from looking like body text scaled up. The italic
// carries the margin notes (components/Note.tsx).
//
// Atkinson Hyperlegible was drawn for the Braille Institute to keep similar
// letters (l, I, 1; 0, O) distinct for low-vision readers. A student copying a
// SHA, a join code or a branch name off this page needs exactly that.
//
// The faces live in ./styles/fonts.css rather than the @fontsource-variable
// css files: same families, files, weight ranges and unicode ranges, but
// font-display: optional instead of swap, so a cold load never re-lays-out
// the page when the webfont arrives (the entry's step section measurably
// shifted 3-4px under swap). See that file for the trade.
import "./styles/fonts.css";
