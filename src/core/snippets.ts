/**
 * Locates the snippets of free-text (`*_text`) values in the report text.
 *
 * The dictionary asks for the shortest exact contiguous source snippets, joined
 * in source order with ' || ', with source whitespace collapsed. A few values
 * use documented constructed forms ("X primary in Y", "SITE :: DIAGNOSIS",
 * "Site not stated: X", "X - Histology not stated", elided "A ... B"); those are
 * located part by part.
 */

export const TEXT_SENTINEL = 'Not identified';
export const SNIPPET_SEPARATOR = ' || ';

export interface SnippetMatch {
  /** Offsets into the original report text, [start, end). */
  start: number;
  end: number;
  /** The snippet (or part of a constructed snippet) that matched. */
  text: string;
  /** True when the whole snippet matched verbatim (modulo whitespace). */
  exact: boolean;
  /** True when it matched only ignoring letter case. */
  caseInsensitive: boolean;
}

export interface LocatedValue {
  snippets: string[];
  matches: SnippetMatch[];
  /** Snippets (or constructed parts) not found in the report. */
  unlocated: string[];
}

/** Snippets of a text value ('Not identified' and empty parts excluded). */
export function splitSnippets(value: string | null | undefined): string[] {
  if (!value || value === TEXT_SENTINEL) return [];
  return value
    .split(SNIPPET_SEPARATOR)
    .map((s) => s.trim())
    .filter((s) => s && s !== TEXT_SENTINEL);
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Phrases the constructed forms add that are not report text. */
const CONSTRUCTED = /^(?:histology not stated|site not stated|secondary site not stated|unknown primary(?: site)?|unknown|primary|not stated)$/i;
const PART_SPLIT = /\s+::\s+|\s*\.\.\.\s*|\s*…\s*|\s+primary in\s+|\s+in\s+(?=[A-Z])|:\s+|\s+-\s+/;

export class ReportIndex {
  readonly text: string;
  private readonly norm: string;
  private readonly lower: string | null;
  /** Original offset of each normalized character. */
  private readonly map: Int32Array;

  constructor(text: string) {
    this.text = text;
    let norm = '';
    const map: number[] = [];
    let inSpace = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;
      if (/\s/.test(ch)) {
        if (!inSpace) {
          norm += ' ';
          map.push(i);
        }
        inSpace = true;
      } else {
        norm += ch;
        map.push(i);
        inSpace = false;
      }
    }
    this.norm = norm;
    this.map = Int32Array.from(map);
    const lower = norm.toLowerCase();
    this.lower = lower.length === norm.length ? lower : null;
  }

  /** Find `needle` (already whitespace-collapsed) at or after `from`, else anywhere. */
  private find(needle: string, from: number): { idx: number; ci: boolean } | null {
    if (!needle) return null;
    let idx = this.norm.indexOf(needle, from);
    if (idx < 0) idx = this.norm.indexOf(needle);
    if (idx >= 0) return { idx, ci: false };
    if (this.lower) {
      const n = needle.toLowerCase();
      if (n.length === needle.length) {
        idx = this.lower.indexOf(n, from);
        if (idx < 0) idx = this.lower.indexOf(n);
        if (idx >= 0) return { idx, ci: true };
      }
    }
    return null;
  }

  private span(idx: number, length: number): [number, number] {
    return [this.map[idx]!, this.map[idx + length - 1]! + 1];
  }

  locate(value: string | null | undefined): LocatedValue {
    const snippets = splitSnippets(value);
    const matches: SnippetMatch[] = [];
    const unlocated: string[] = [];
    let cursor = 0;
    for (const raw of snippets) {
      const s = collapse(raw);
      const hit = this.find(s, cursor);
      if (hit) {
        const [start, end] = this.span(hit.idx, s.length);
        matches.push({ start, end, text: raw, exact: true, caseInsensitive: hit.ci });
        cursor = hit.idx + 1;
        continue;
      }
      const parts = s
        .split(PART_SPLIT)
        .map((p) => p.trim())
        .filter((p) => p.length >= 3 && !CONSTRUCTED.test(p));
      let any = false;
      for (const part of parts) {
        const ph = this.find(part, cursor);
        if (ph) {
          const [start, end] = this.span(ph.idx, part.length);
          matches.push({ start, end, text: part, exact: false, caseInsensitive: ph.ci });
          any = true;
        }
      }
      if (!any) unlocated.push(raw);
    }
    return { snippets, matches, unlocated };
  }
}
