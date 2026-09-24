import * as vscode from "vscode";
import { CitationSelection, extractCitationKeys } from "./citations";
import { SearchResult, searchZotero } from "./zotero";

class EntryItem implements vscode.QuickPickItem {
  label: string;
  detail: string;
  description: string;
  alwaysShow = true;

  constructor(public result: SearchResult) {
    this.label = result.title || "Untitled";
    this.detail = result.citekey;
    const names = (result.author ?? []).map((author) => `${author.given || ""} ${author.family || ""}`.trim());
    this.description = names.length > 2
      ? names.slice(0, -1).join(", ") + ", and " + names[names.length - 1]
      : names.join(" and ");
  }
}

export function showVSCodePicker(): Promise<CitationSelection | undefined> {
  const picker = vscode.window.createQuickPick<vscode.QuickPickItem>();
  picker.placeholder = 'Search, check citations, then press Enter (try "author:lastname")';
  picker.canSelectMany = true;
  picker.matchOnDescription = false;
  picker.matchOnDetail = false;

  return new Promise((resolve) => {
    const selected = new Map<string, EntryItem>();
    let searchTimeout: NodeJS.Timeout | undefined;
    let searchId = 0;
    let closed = false;
    let updating = false;

    const display = (results: SearchResult[], error?: string) => {
      const items = new Map(selected);
      for (const result of results) {
        if (result.citekey && !items.has(result.citekey)) {
          items.set(result.citekey, new EntryItem(result));
        }
      }
      updating = true;
      picker.busy = false;
      picker.items = [...items.values(), ...(error ? [{ label: error, alwaysShow: true }] : [])];
      picker.selectedItems = [...selected.values()];
      updating = false;
    };

    const search = async (value: string, id: number) => {
      try {
        const results = value.trim() ? await searchZotero(value) : [];
        if (!closed && id === searchId) {
          display(results);
        }
      } catch (error) {
        if (!closed && id === searchId) {
          display([], error instanceof Error ? error.message : String(error));
        }
      }
    };

    picker.onDidChangeSelection((items) => {
      if (updating) {
        return;
      }
      const keys = new Set(items.filter((item): item is EntryItem => item instanceof EntryItem).map((item) => item.result.citekey));
      for (const key of selected.keys()) {
        if (!keys.has(key)) {
          selected.delete(key);
        }
      }
      for (const item of items) {
        if (item instanceof EntryItem) {
          selected.set(item.result.citekey, item);
        }
      }
      picker.title = `Zotero — ${selected.size} selected`;
    });

    picker.onDidChangeValue((value) => {
      clearTimeout(searchTimeout);
      const id = ++searchId;
      picker.busy = !!value.trim();
      searchTimeout = setTimeout(() => void search(value, id), 300);
    });

    picker.onDidAccept(() => {
      const items = selected.size ? [...selected.values()]
        : picker.activeItems.filter((item): item is EntryItem => item instanceof EntryItem);
      if (!items.length) {
        return;
      }
      resolve({ citekeys: items.map((item) => item.result.citekey), results: items.map((item) => item.result) });
      picker.hide();
    });

    picker.onDidHide(() => {
      closed = true;
      clearTimeout(searchTimeout);
      resolve(undefined);
      picker.dispose();
    });
    picker.title = "Zotero — select citations";
    picker.show();
  });
}

export async function showZoteroPicker(
  endpoint: string,
  languageId: string,
): Promise<CitationSelection | undefined> {
  const url = new URL(endpoint);
  if (languageId === "latex") {
    url.searchParams.set("format", "latex");
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Zotero picker HTTP error: ${response.status}`);
  }
  const text = await response.text();
  if (!text.trim()) {
    return undefined;
  }
  const citekeys = extractCitationKeys(text, languageId);
  if (!citekeys.length) {
    throw new Error("Zotero returned a citation whose keys could not be read. Choose a citation-key output format.");
  }
  return { citekeys, text };
}
