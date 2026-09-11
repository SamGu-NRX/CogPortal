import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";

type Lang = "bash" | "toml" | "python";

/** Ink-on-paper syntax theme — same palette as the rest of the interface. */
const PAPER_THEME = {
  name: "cogportal-paper",
  type: "light" as const,
  colors: {
    "editor.background": "#00000000",
    "editor.foreground": "#1c2637",
  },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#8b93a3", fontStyle: "italic" } },
    { scope: ["string", "string.quoted", "punctuation.definition.string"], settings: { foreground: "#2e6b4f" } },
    { scope: ["keyword", "storage.type", "storage.modifier", "keyword.operator.assignment"], settings: { foreground: "#c63d2f" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call.generic"], settings: { foreground: "#2b54c0" } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "#a12e22" } },
    { scope: ["entity.name.tag", "support.type.property-name", "entity.name.section", "keyword.key.toml", "variable.other"], settings: { foreground: "#2b54c0" } },
    { scope: ["punctuation"], settings: { foreground: "#4b566b" } },
  ],
};

type Highlight = (code: string, lang: Lang) => string;
let highlighterPromise: Promise<Highlight> | null = null;

function loadHighlighter(): Promise<Highlight> {
  highlighterPromise ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("@shikijs/langs/bash"),
    import("@shikijs/langs/toml"),
    import("@shikijs/langs/python"),
  ]).then(async ([{ createHighlighterCore }, { createJavaScriptRegexEngine }, bash, toml, python]) => {
    const h = await createHighlighterCore({
      themes: [PAPER_THEME],
      langs: [bash.default, toml.default, python.default],
      engine: createJavaScriptRegexEngine(),
    });
    return (code, lang) => h.codeToHtml(code, { lang, theme: "cogportal-paper" });
  });
  return highlighterPromise;
}

export function Code({
  code,
  lang,
  wrap = false,
}: {
  code: string;
  lang: Lang;
  /** Let a long line wrap instead of scrolling out of view. `.code-block pre`
   *  scrolls by default, which suits a short snippet; the setup page's pinned
   *  install is 189 characters and ends in the commit it pins, so scrolling
   *  would hide the part that identifies it. */
  wrap?: boolean;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    void loadHighlighter().then((highlight) => {
      if (alive) setHtml(highlight(code, lang));
    });
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [code, lang]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      className={`code-block group relative border border-rule bg-paper-sunken px-3.5 py-3 font-mono ${
        wrap ? "is-wrapped" : ""
      }`}
    >
      {html ? (
        // Shiki output is generated locally from the literal snippet above.
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        // Shown until the highlighter resolves. Same metrics, so the block does
        // not resize under the reader when it does.
        <pre className="text-[12.5px] leading-[1.65] text-ink">{code}</pre>
      )}
      {/* The icon is the control, the way the join code's copy is on the admin
          page. Colour carries the confirmation; the accessible name carries it
          for anyone not looking at the colour. */}
      <button
        type="button"
        onClick={copy}
        title={copied ? "Copied" : "Copy command"}
        className="u-pressable u-hit-44 absolute top-1.5 right-1.5 flex min-h-7 min-w-7 items-center justify-center border border-transparent bg-paper-sunken/90 transition-colors duration-150 hover:border-rule"
      >
        <HugeiconsIcon
          icon={copied ? Tick02Icon : Copy01Icon}
          size={13}
          strokeWidth={1.8}
          className={copied ? "text-verify" : "text-ink-faint"}
          aria-hidden="true"
        />
        <span className="sr-only">{copied ? "Copied" : "Copy command"}</span>
      </button>
    </div>
  );
}
