import * as vscode from "vscode";
import { prepareBibliographyUpdate, resolveBibliographyUri } from "./bibliography";
import { CitationSelection, citationEdits, formatCitationText } from "./citations";
import { showVSCodePicker, showZoteroPicker } from "./picker";

function citationLanguage(document: vscode.TextDocument): string {
  return document.uri.path.endsWith(".qmd") ? "quarto" : document.languageId;
}

export async function insertCitations(
  document: vscode.TextDocument,
  selections: readonly vscode.Selection[],
  version: number,
  selection: CitationSelection,
): Promise<void> {
  const languageId = citationLanguage(document);
  const source = document.getText();
  const replacements = citationEdits(source, selections.map((range) => ({
    start: document.offsetAt(range.start), end: document.offsetAt(range.end),
  })), selection, languageId);
  const footnotes = languageId === "markdown" && selection.results;
  const uri = footnotes ? undefined : await resolveBibliographyUri(document);
  if (languageId === "latex" && !uri) {
    return; // The user cancelled bibliography selection.
  }
  const bibliography = uri ? await prepareBibliographyUpdate(uri, selection.citekeys) : undefined;

  if (document.isClosed || document.version !== version) {
    throw new Error("The document changed while choosing citations. Run the picker again at the desired position.");
  }
  if (bibliography?.document && (bibliography.document.isClosed || bibliography.document.version !== bibliography.version)) {
    throw new Error("The bibliography changed while exporting citations. Run the picker again.");
  }

  const edit = new vscode.WorkspaceEdit();
  if (bibliography) {
    const bibDocument = bibliography.document;
    if (!bibDocument) {
      edit.createFile(bibliography.uri, { overwrite: false });
      edit.insert(bibliography.uri, new vscode.Position(0, 0), bibliography.text);
    } else {
      const content = bibDocument.getText();
      const end = bibDocument.positionAt(content.length);
      if (bibliography.text.startsWith(content)) {
        edit.insert(bibliography.uri, end, bibliography.text.slice(content.length));
      } else {
        edit.replace(bibliography.uri, new vscode.Range(new vscode.Position(0, 0), end), bibliography.text);
      }
    }
  }
  for (const replacement of replacements) {
    edit.replace(document.uri, new vscode.Range(document.positionAt(replacement.start), document.positionAt(replacement.end)), replacement.text);
  }
  if (footnotes) {
    const template = vscode.workspace.getConfiguration("zotero-citation-picker", document.uri).get<string>(
      "markdownCitationTemplate", "{{authors}}. ({{year}}). {{title}}. {{container}}.",
    );
    const definitions = footnotes
      .filter((result) => !source.includes(`[^${result.citekey}]:`))
      .map((result) => `[^${result.citekey}]: ${formatCitationText(result, template)}`);
    if (definitions.length) {
      edit.insert(document.uri, document.positionAt(source.length), `\n\n${definitions.join("\n")}\n`);
    }
  }

  // Existing documents use one text-only edit, which VS Code applies all-or-nothing.
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error("VS Code could not apply the citation edits");
  }
  // Preserve pending user edits; only automatically save previously clean bibliographies.
  if (bibliography?.save) {
    try {
      const bibDocument = bibliography.document ?? await vscode.workspace.openTextDocument(bibliography.uri);
      if (!(await bibDocument.save())) {
        throw new Error("Save returned false");
      }
    } catch {
      void vscode.window.showWarningMessage(`Citations were inserted, but ${bibliography.uri.fsPath} could not be saved. Save the bibliography manually.`);
    }
  }
}

async function showCitationPicker(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("No active text editor found");
    return;
  }
  const { document } = editor;
  const selections = [...editor.selections];
  const version = document.version;
  const config = vscode.workspace.getConfiguration("zotero-citation-picker", document.uri);
  try {
    const selection = config.get<string>("citeMethod", "vscode") === "vscode"
      ? await showVSCodePicker()
      : await showZoteroPicker(config.get<string>("port", "http://127.0.0.1:23119/better-bibtex/cayw?format=pandoc"), citationLanguage(document));
    if (selection) {
      await insertCitations(document, selections, version, selection);
    }
  } catch (error) {
    void vscode.window.showErrorMessage(`Zotero Citations: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.commands.registerCommand("extension.zoteroCitationPicker", showCitationPicker));
}
