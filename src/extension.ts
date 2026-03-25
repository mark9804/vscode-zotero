import * as vscode from "vscode";
import * as path from "path";

interface ZoteroConfig {
  port: number;
  citeMethod?: "zotero" | "vscode";
}

// Better BibTeX search result interface
interface SearchResult {
  type: string;
  citekey: string;
  title: string;
  author?: [{ family: string; given: string }];
  [field: string]: any;
}

// QuickPick item for bibliography entries
class EntryItem implements vscode.QuickPickItem {
  label: string;
  detail?: string;
  description?: string;
  alwaysShow?: boolean;

  constructor(public result: SearchResult) {
    this.label = result.title || "Untitled";
    this.detail = result.citekey || "";
    this.alwaysShow = true; // Prevent VS Code from filtering this item

    if (result.author && result.author.length > 0) {
      const names = result.author.map((a) =>
        `${a.given || ""} ${a.family || ""}`.trim(),
      );

      if (names.length === 1) {
        this.description = names[0];
      } else if (names.length === 2) {
        this.description = names.join(" and ");
      } else if (names.length > 2) {
        this.description =
          names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
      }
    } else {
      this.description = "";
    }
  }
}

// QuickPick item for error messages
class ErrorItem implements vscode.QuickPickItem {
  label: string;
  alwaysShow?: boolean;

  constructor(public message: string) {
    this.label = message.replace(/\r?\n/g, " ");
    this.alwaysShow = true; // Prevent VS Code from filtering this item
  }
}

const textDecoder = new TextDecoder("utf-8");
const textEncoder = new TextEncoder();

// Read a file via vscode.workspace.fs (works across remote boundaries)
async function readWorkspaceFile(uri: vscode.Uri): Promise<string> {
  const data = await vscode.workspace.fs.readFile(uri);
  return textDecoder.decode(data);
}

// Write a file via vscode.workspace.fs (works across remote boundaries)
async function writeWorkspaceFile(
  uri: vscode.Uri,
  content: string,
): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, textEncoder.encode(content));
}

// Check if a file exists via vscode.workspace.fs
async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

// Make a JSON-RPC request to Zotero Better BibTeX
async function zoteroJsonRpc(method: string, params: any[]): Promise<any> {
  const response = await fetch(
    "http://127.0.0.1:23119/better-bibtex/json-rpc",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal: AbortSignal.timeout(5000),
    },
  );

  if (!response.ok) {
    throw new Error(`Zotero HTTP error: ${response.status}`);
  }

  const data = (await response.json()) as any;
  return data.result;
}

// Extract bibliography file path from LaTeX commands, YAML front matter, or _quarto.yaml
async function extractBibliographyFile(
  document: vscode.TextDocument,
): Promise<{ bibFile: string; isFromQuartoYaml: boolean } | null> {
  const documentText = document.getText();

  // For LaTeX files, check \bibliography{} and \addbibresource{} commands
  if (document.languageId === "latex") {
    // \addbibresource{file.bib} (biblatex, usually includes extension)
    let match = documentText.match(/\\addbibresource\{([^}]+)\}/);
    if (match) {
      return { bibFile: match[1], isFromQuartoYaml: false };
    }
    // \bibliography{name} (bibtex, no extension - defaults to .bib)
    match = documentText.match(/\\bibliography\{([^}]+)\}/);
    if (match) {
      let bibFile = match[1];
      if (!path.extname(bibFile)) {
        bibFile += ".bib";
      }
      return { bibFile, isFromQuartoYaml: false };
    }
  }

  // Check document's YAML front matter
  const yamlMatch = documentText.match(/^---\s*\n([\s\S]*?)\n---/);

  if (yamlMatch) {
    const yamlContent = yamlMatch[1];
    const bibliographyMatch = yamlContent.match(/bibliography:\s*([^\s\n]+)/);

    if (bibliographyMatch) {
      return {
        bibFile: bibliographyMatch[1].replace(/["']/g, ""),
        isFromQuartoYaml: false,
      };
    }
  }

  // If not found, check for _quarto.yml or _quarto.yaml in workspace
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    return null;
  }

  for (const quartoFile of ["_quarto.yml", "_quarto.yaml"]) {
    const quartoUri = vscode.Uri.joinPath(workspaceFolder.uri, quartoFile);

    if (await fileExists(quartoUri)) {
      const quartoContent = await readWorkspaceFile(quartoUri);
      const bibliographyMatch = quartoContent.match(
        /bibliography:\s*([^\s\n]+)/,
      );

      if (bibliographyMatch) {
        return {
          bibFile: bibliographyMatch[1].replace(/["']/g, ""),
          isFromQuartoYaml: true,
        };
      }
    }
  }

  return null;
}

// Extract citation key from citation text (e.g., @key, [@key], \cite{key}, or [^key] -> key)
function extractCitationKey(citationText: string): string | null {
  // Try \cite{key} format (LaTeX)
  let match = citationText.match(/\\cite\{([^}]+)\}/);
  if (match) {
    return match[1];
  }

  // Try [^key] format (Markdown footnote)
  match = citationText.match(/\[\^([^\]]+)\]/);
  if (match) {
    return match[1];
  }

  // Try @key format (what Zotero actually returns)
  match = citationText.match(/@([a-zA-Z0-9_-]+)/);
  if (match) {
    return match[1];
  }

  // Fallback to [@key] format
  match = citationText.match(/\[@([^\]]+)\]/);
  return match ? match[1] : null;
}

// Format inline citation reference based on document language
function formatCitation(citekey: string, languageId: string): string {
  if (languageId === "latex") {
    return `\\cite{${citekey}}`;
  }
  if (languageId === "markdown") {
    return `[^${citekey}]`;
  }
  return `@${citekey}`;
}

// Build a human-readable citation string from CSL-JSON search result
function formatCitationText(result: SearchResult): string {
  const parts: string[] = [];

  // Authors: "Family, G., Family, G., & Family, G."
  if (result.author && result.author.length > 0) {
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
      parts.push(names.join(" & "));
    } else {
      parts.push(names.slice(0, -1).join(", ") + ", & " + names[names.length - 1]);
    }
  }

  // Year
  const issued = (result as any).issued;
  if (issued?.["date-parts"]?.[0]?.[0]) {
    parts.push(`(${issued["date-parts"][0][0]})`);
  }

  // Title
  if (result.title) {
    parts.push(result.title);
  }

  // Container (journal/conference)
  const container = (result as any)["container-title"];
  if (container) {
    let containerStr = container;
    const vol = (result as any).volume;
    const issue = (result as any).issue;
    const page = (result as any).page;
    if (vol) {
      containerStr += `, ${vol}`;
      if (issue) {
        containerStr += `(${issue})`;
      }
    }
    if (page) {
      containerStr += `, ${page}`;
    }
    parts.push(containerStr);
  }

  return parts.join(". ") + ".";
}

// Get Bib entry from Zotero for a given citation key
async function getBibEntry(
  citeKey: string,
  translator: string = "Better BibTeX",
): Promise<string | null> {
  try {
    let result: string | null = await zoteroJsonRpc("item.export", [
      [citeKey],
      translator,
    ]);

    // Strip YAML front matter wrapper for Better CSL YAML exports
    if (result && translator === "Better CSL YAML") {
      result = result.split("\n").slice(2, -2).join("\n");
    }

    // Strip array brackets for Better CSL JSON exports
    if (result && translator === "Better CSL JSON") {
      result = result.split("\n").slice(1, -2).join("\n");
    }

    return result;
  } catch (err) {
    console.log("Failed to fetch bibliography entry:", err);
    return null;
  }
}

// Parse advanced search query into Better BibTeX search format
function parseSearchQuery(query: string): string | Array<Array<string>> {
  const trimmedQuery = query.trim();

  // Map common field names to Better BibTeX search fields
  const fieldMapping: { [key: string]: string } = {
    author: "creator",
    creator: "creator",
    title: "title",
    year: "date",
    date: "date",
    journal: "publicationTitle",
    publication: "publicationTitle",
    tag: "tag",
    note: "note",
    doi: "DOI",
    isbn: "ISBN",
    type: "itemType",
  };

  // Check for field:value patterns
  const advancedSearchPatterns = trimmedQuery.match(/(\w+):("[^"]+"|[^\s]+)/g);

  if (advancedSearchPatterns && advancedSearchPatterns.length > 0) {
    const searchConditions: Array<Array<string>> = [];

    // Add field-specific searches
    for (const pattern of advancedSearchPatterns) {
      const match = pattern.match(/^(\w+):(.+)$/);
      if (match) {
        const [, field, value] = match;
        const searchField = fieldMapping[field.toLowerCase()] || field;
        const searchValue = value.replace(/^["']|["']$/g, "").trim(); // Remove quotes

        searchConditions.push([searchField, "contains", searchValue]);
      }
    }

    // Extract any remaining text that's not in field:value format
    let remainingText = trimmedQuery;
    for (const pattern of advancedSearchPatterns) {
      remainingText = remainingText.replace(pattern, "").trim();
    }

    // If there's remaining text, add it as a general search
    if (remainingText) {
      searchConditions.push([
        "quicksearch-titleCreatorYear",
        "contains",
        remainingText,
      ]);
    }

    return searchConditions;
  }

  // For simple queries without field specifiers, use quicksearch-titleCreatorYear
  return [["quicksearch-titleCreatorYear", "contains", trimmedQuery]];
}

// Search Zotero database using Better BibTeX JSON-RPC
async function searchZotero(query: string): Promise<SearchResult[]> {
  const searchTerms = parseSearchQuery(query);

  try {
    const results = await zoteroJsonRpc("item.search", [searchTerms]);
    return results || [];
  } catch (err) {
    console.log("Failed to search Zotero:", err);
    throw new Error(
      "Could not connect to Zotero. Is Zotero running with Better BibTeX?",
    );
  }
}

// Update .bib file with new entry (uses vscode.workspace.fs for remote support)
async function updateBibFile(
  bibFileUri: vscode.Uri,
  bibEntry: string,
  citeKey: string,
): Promise<void> {
  try {
    let bibContent = "";
    const fileExtension = path.extname(bibFileUri.fsPath).toLowerCase();

    // Read existing bibliography file if it exists
    if (await fileExists(bibFileUri)) {
      bibContent = await readWorkspaceFile(bibFileUri);

      // Check if the citation key already exists (format depends on file type)
      let keyExists = false;

      if (fileExtension === ".yml" || fileExtension === ".yaml") {
        // CSL YAML format: "- id: citekey"
        keyExists = new RegExp(
          `^\\s*-?\\s*id:\\s*['"]?${citeKey}['"]?\\s*$`,
          "m",
        ).test(bibContent);
      } else if (fileExtension === ".json") {
        // CSL JSON format: "id": "citekey" or 'id': 'citekey'
        keyExists = new RegExp(
          `["']id["']\\s*:\\s*["']${citeKey}["']`,
          "m",
        ).test(bibContent);
      } else {
        // BibTeX format: @type{citekey, or @type{citekey }
        keyExists =
          bibContent.includes(`{${citeKey},`) ||
          bibContent.includes(`{${citeKey} `);
      }

      if (keyExists) {
        console.log(
          `Citation key ${citeKey} already exists in bibliography file`,
        );
        return;
      }
    }

    // Append new entry
    let newContent: string;

    if (fileExtension === ".json") {
      // For JSON CSL formats, insert bibEntry into the array
      if (bibContent === "") {
        // Initialize new json array
        newContent = `[\n${bibEntry}\n]`;
      } else {
        // Insert at end of json array
        const lastBracket = bibContent.lastIndexOf("]");
        const beforeBracket = bibContent.substring(0, lastBracket).trimEnd();
        const needsComma = beforeBracket && !beforeBracket.endsWith(",");
        newContent =
          beforeBracket + (needsComma ? "," : "") + "\n" + bibEntry + "\n]";
      }
    } else {
      // For other formats, append to end
      newContent =
        bibContent +
        (bibContent && !bibContent.endsWith("\n") ? "\n" : "") +
        bibEntry +
        "\n";
    }

    await writeWorkspaceFile(bibFileUri, newContent);

    console.log(`Added citation ${citeKey} to ${bibFileUri.fsPath}`);
  } catch (err) {
    console.log("Failed to update bibliography file:", err);
    vscode.window.showWarningMessage(
      `Failed to update bibliography file: ${err}`,
    );
  }
}

// Native VS Code citation picker using QuickPick
async function showVSCodePicker(): Promise<void> {
  const picker = vscode.window.createQuickPick();
  picker.placeholder =
    'Search for citations... (try "author:lastname" for advanced search)';
  picker.canSelectMany = false;

  // Disable QuickPick's built-in filtering since we do our own search
  picker.matchOnDescription = false;
  picker.matchOnDetail = false;

  let searchTimeout: NodeJS.Timeout | undefined;
  let currentSearchId = 0;

  const performSearch = async (query: string, searchId: number) => {
    if (!query.trim()) {
      picker.busy = false;
      picker.items = [];
      return;
    }

    picker.busy = true;

    try {
      const results = await searchZotero(query);

      // Check if this search is still the current one (not superseded by a newer search)
      if (searchId === currentSearchId) {
        const items: EntryItem[] = results.map(
          (result) => new EntryItem(result),
        );

        // IMPORTANT: Set busy = false BEFORE setting items so they can be displayed
        picker.busy = false;

        picker.items = items;
      } else {
        // Discard outdated search results
      }
    } catch (err: any) {
      if (searchId === currentSearchId) {
        picker.busy = false; // Set busy = false BEFORE setting error items
        picker.items = [new ErrorItem(err.message)];
      }
    }
  };

  picker.onDidChangeValue((value) => {
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }

    // Increment search ID to track the latest search
    currentSearchId++;
    const thisSearchId = currentSearchId;

    searchTimeout = setTimeout(() => {
      performSearch(value, thisSearchId);
    }, 300); // Debounce search by 300ms
  });

  picker.onDidAccept(() => {
    const selection = picker.activeItems[0];
    if (selection && selection instanceof EntryItem) {
      const editor = vscode.window.activeTextEditor;
      const langId = editor?.document.languageId || "";
      insertCitation(
        formatCitation(selection.result.citekey, langId),
        selection.result,
      );
    }
    picker.hide();
  });

  picker.onDidHide(() => {
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }
    picker.dispose();
  });

  // Start with empty items
  picker.items = [];

  picker.show();
}

// Use Zotero's built-in CAYW picker
async function showZoteroPicker(): Promise<void> {
  const config: ZoteroConfig = vscode.workspace.getConfiguration(
    "zotero-citation-picker",
  ) as any;

  try {
    const editor = vscode.window.activeTextEditor;
    const langId = editor?.document.languageId || "";

    // Use latex format for CAYW when editing LaTeX files
    let url = String(config.port);
    if (langId === "latex") {
      url = url.replace(/format=\w+/, "format=latex");
    }

    const response = await fetch(url);
    const result = await response.text();
    if (result) {
      await insertCitation(result);
    }
  } catch (err: any) {
    console.log("Failed to fetch citation: %j", err.message);
    vscode.window.showErrorMessage(
      "Zotero Citations: could not connect to Zotero. Are you sure it is running?",
    );
  }
}

// Insert citation and update bibliography / footnote
async function insertCitation(
  citation: string,
  searchResult?: SearchResult,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active text editor found");
    return;
  }

  // Insert citation into document
  await editor.edit((editBuilder) => {
    editor.selections.forEach((selection) => {
      editBuilder.delete(selection);
      editBuilder.insert(selection.start, citation);
    });
  });

  // For markdown: append footnote definition to document
  if (editor.document.languageId === "markdown" && searchResult) {
    const citeKey = searchResult.citekey;
    const docText = editor.document.getText();
    const footnoteTag = `[^${citeKey}]:`;

    // Skip if footnote definition already exists
    if (docText.includes(footnoteTag)) {
      return;
    }

    const footnoteLine = `[^${citeKey}]: ${formatCitationText(searchResult)}`;
    const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
    const endPos = lastLine.range.end;

    await editor.edit((editBuilder) => {
      // Ensure there's a trailing newline before appending
      const prefix = lastLine.text === "" ? "" : "\n";
      editBuilder.insert(endPos, `${prefix}${footnoteLine}\n`);
    });
    return;
  }

  // For LaTeX / Quarto: update .bib file
  const bibInfo = await extractBibliographyFile(editor.document);

  if (bibInfo) {
    const citeKey = extractCitationKey(citation);

    if (citeKey) {
      // Determine translator based on file extension
      const fileExtension = path.extname(bibInfo.bibFile).toLowerCase();

      const translator =
        fileExtension === ".yml" || fileExtension === ".yaml"
          ? "Better CSL YAML"
          : fileExtension === ".json"
            ? "Better CSL JSON"
            : "Better BibTeX";

      const bibEntry = await getBibEntry(citeKey, translator);

      if (bibEntry) {
        // Determine base URI based on where bibliography is defined
        let baseUri: vscode.Uri;

        if (bibInfo.isFromQuartoYaml) {
          // Bibliography from _quarto.yaml, use workspace root
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(
            editor.document.uri,
          );
          baseUri = workspaceFolder
            ? workspaceFolder.uri
            : vscode.Uri.joinPath(editor.document.uri, "..");
        } else {
          // Bibliography from document's YAML front matter, use document's directory
          baseUri = vscode.Uri.joinPath(editor.document.uri, "..");
        }

        const bibFileUri = vscode.Uri.joinPath(baseUri, bibInfo.bibFile);

        await updateBibFile(bibFileUri, bibEntry, citeKey);
      }
    }
  }
}

// Main citation picker function that chooses between methods
async function showCitationPicker(): Promise<void> {
  const config: ZoteroConfig = vscode.workspace.getConfiguration(
    "zotero-citation-picker",
  ) as any;
  const citeMethod = config.citeMethod || "zotero";

  if (citeMethod === "vscode") {
    await showVSCodePicker();
  } else {
    await showZoteroPicker();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  console.log(
    'Congratulations, your extension "zotero citation picker" is now active!',
  );

  let disposable = vscode.commands.registerCommand(
    "extension.zoteroCitationPicker",
    () => {
      showCitationPicker();
    },
  );

  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  // This function is called when the extension is deactivated
}
