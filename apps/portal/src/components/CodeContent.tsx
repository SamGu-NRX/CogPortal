import { useEffect, useState } from "react";

/** `text` skips grammar loading for opaque tokens. */
export type CodeLang = "bash" | "toml" | "python" | "text";

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

type Highlight = (code: string, lang: Exclude<CodeLang, "text">, focusable: boolean) => string;
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
    return (code, lang, focusable) =>
      h.codeToHtml(code, { lang, theme: "cogportal-paper", tabindex: focusable ? "0" : false });
  });
  return highlighterPromise;
}

/** Syntax only. Callers own layout and copying. */
export function CodeContent({
  code,
  lang,
  className = "",
  plainAs = "pre",
  focusable = true,
}: {
  code: string;
  lang: CodeLang;
  /** Disable Shiki's default tab stop when the caller already owns scrolling. */
  focusable?: boolean;
  /** Fallback styling; highlighted markup inherits the caller's layout. */
  className?: string;
  plainAs?: "pre" | "code";
}) {
  // Never display an async result beside a different command's copy control.
  const [rendered, setRendered] = useState<{
    code: string; lang: CodeLang; focusable: boolean; html: string;
  } | null>(null);

  useEffect(() => {
    if (lang === "text") return;
    let alive = true;
    void loadHighlighter().then((highlight) => {
      if (alive) setRendered({ code, lang, focusable, html: highlight(code, lang, focusable) });
    });
    return () => {
      alive = false;
    };
  }, [code, lang, focusable]);

  const html = rendered?.code === code && rendered.lang === lang && rendered.focusable === focusable
    ? rendered.html
    : null;
  if (html === null) {
    const Plain = plainAs;
    return <Plain className={className}>{code}</Plain>;
  }
  // Generated locally by Shiki, which escapes the literal code string.
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
