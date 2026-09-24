import type { SearchResult } from "./zotero";

export interface CitationSelection {
  citekeys: string[];
  results?: SearchResult[];
  text?: string;
}

export function uniqueKeys(keys: string[]): string[] {
  return [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
}

export function withoutLatexComments(text: string): string {
  return text.replace(/(?<!\\)%[^\r\n]*/g, (comment) => " ".repeat(comment.length));
}

// ponytail: standard citation commands only; TeX macro expansion needs a TeX parser.
function latexCitations(text: string) {
  return withoutLatexComments(text).matchAll(
    /\\[a-z]*cite[a-z]*\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)\}/gi,
  );
}

export function extractCitationKeys(text: string, languageId: string): string[] {
  if (languageId === "latex") {
    return uniqueKeys([...latexCitations(text)].flatMap((match) => match[1].split(",")));
  }
  const footnotes = [...text.matchAll(/\[\^([^\]]+)\]/g)].map((match) => match[1]);
  const atKeys = [...text.matchAll(/@([^\s;,\[\]{}]+)/g)].map((match) => match[1]);
  return uniqueKeys([...footnotes, ...atKeys]);
}

export function formatCitation(keys: string[], languageId: string): string {
  keys = uniqueKeys(keys);
  switch (languageId) {
    case "latex":
      return `\\cite{${keys.join(",")}}`;
    case "markdown":
      return keys.map((key) => `[^${key}]`).join("");
    case "typst":
      return keys.map((key) => `@${key}`).join(" ");
    default:
      return keys.length === 1 ? `@${keys[0]}` : `[${keys.map((key) => `@${key}`).join("; ")}]`;
  }
}

export interface CitationEdit {
  start: number;
  end: number;
  text: string;
}

export function citationEdits(
  source: string,
  ranges: { start: number; end: number }[],
  selection: CitationSelection,
  languageId: string,
): CitationEdit[] {
  const text = selection.text ?? formatCitation(selection.citekeys, languageId);
  const edits = new Map<string, CitationEdit>();
  for (const range of ranges) {
    let edit = { ...range, text };
    if (languageId === "latex") {
      for (const match of latexCitations(source)) {
        const start = match.index! + match[0].lastIndexOf("{") + 1;
        const end = start + match[1].length;
        if (range.start >= start && range.end <= end) {
          if (selection.text && !/^\\cite\s*\{[^{}]*\}\s*$/.test(selection.text)) {
            throw new Error("Insert this Zotero citation outside the existing citation to preserve its command and page notes.");
          }
          edit = { start, end, text: uniqueKeys([...match[1].split(","), ...selection.citekeys]).join(",") };
          break;
        }
      }
    }
    edits.set(`${edit.start}:${edit.end}`, edit);
  }
  return [...edits.values()];
}

// Format author list from CSL-JSON: "Family, G., Family, G., & Family, G."
function formatAuthors(result: SearchResult): string {
  if (!result.author || result.author.length === 0) {
    return "";
  }
  const names = result.author.map((a) => {
    const family = a.family || "";
    const given = a.given
      ? a.given
        .split(/\s+/)
        .map((n) => n[0] + ".")
        .join(" ")
      : "";
    return given ? `${family}, ${given}` : family;
  });
  if (names.length <= 2) {
    return names.join(" & ");
  }
  return names.slice(0, -1).join(", ") + ", & " + names[names.length - 1];
}

// Format container (journal/conference) with volume, issue, and page
function formatContainer(result: SearchResult): string {
  const container = (result as any)["container-title"];
  if (!container) {
    return "";
  }
  let str = container;
  const vol = (result as any).volume;
  const issue = (result as any).issue;
  const page = (result as any).page;
  if (vol) {
    str += `, ${vol}`;
    if (issue) {
      str += `(${issue})`;
    }
  }
  if (page) {
    str += `, ${page}`;
  }
  return str;
}

// Build a human-readable citation string from CSL-JSON search result using a configurable template
export function formatCitationText(
  result: SearchResult,
  template: string,
): string {

  const authors = formatAuthors(result);
  const issued = (result as any).issued;
  const year = issued?.["date-parts"]?.[0]?.[0]?.toString() || "";
  const title = result.title || "";
  const container = formatContainer(result);

  let text = template
    .replace(/\{\{authors\}\}/g, authors)
    .replace(/\{\{year\}\}/g, year)
    .replace(/\{\{title\}\}/g, title)
    .replace(/\{\{container\}\}/g, container);

  // Cleanup artifacts from empty fields
  text = text.replace(/\(\)/g, ""); // remove empty parens
  text = text.replace(/\.(\s*\.)+/g, "."); // collapse consecutive dots
  text = text.replace(/\s{2,}/g, " "); // collapse whitespace
  text = text.trim();

  return text;
}
