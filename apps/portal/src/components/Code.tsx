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

export function Code({ code, lang }: { code: string; lang: Lang }) {
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
    <div className="code-block group relative border border-rule bg-paper-sunken px-3.5 py-3 font-mono">
      {html ? (
        // Shiki output is generated locally from the literal snippet above.
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="text-[12.5px] leading-[1.65] text-ink">{code}</pre>
      )}
      <button
        type="button"
        onClick={copy}
        className="u-pressable absolute top-1.5 right-1.5 min-h-7 border border-transparent bg-paper-sunken/90 px-2 font-mono text-[10px] tracking-[0.08em] text-ink-faint uppercase transition-colors duration-150 hover:border-rule hover:text-ink"
      >
        {copied ? "copied" : "copy"}
        <span className="sr-only">Copy code</span>
      </button>
    </div>
  );
}
