import * as path from "path";
import * as vscode from "vscode";
import { uniqueKeys, withoutLatexComments } from "./citations";
import { exportBibliography } from "./zotero";

function relativeToDocument(uri: vscode.Uri, filename: string): vscode.Uri {
  return path.isAbsolute(filename)
    ? uri.with({ path: vscode.Uri.file(filename).path })
    : vscode.Uri.joinPath(uri, "..", filename);
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "FileNotFound") {
      return false;
    }
    throw error;
  }
}

function yamlBibliography(text: string): string | undefined {
  return text.match(/^\s*bibliography:\s*["']?([^\r\n"']+?)["']?\s*$/m)?.[1].trim();
}

export async function resolveBibliographyUri(
  document: vscode.TextDocument,
): Promise<vscode.Uri | undefined> {
  if (document.languageId === "latex") {
    const visited = new Set<string>();
    while (true) {
      if (visited.has(document.uri.toString())) {
        throw new Error(`Circular % !TeX root directive at ${document.uri.fsPath}`);
      }
      visited.add(document.uri.toString());
      const root = document.getText().match(/^\s*%\s*!\s*tex\s+root\s*=\s*(.+?)\s*$/im)?.[1];
      if (!root) {
        break;
      }
      const rootUri = relativeToDocument(document.uri, root.replace(/^(["'])(.*)\1$/, "$2"));
      try {
        document = await vscode.workspace.openTextDocument(rootUri);
      } catch {
        throw new Error(`Cannot open LaTeX root ${rootUri.fsPath}. Check the % !TeX root directive.`);
      }
    }

    const source = withoutLatexComments(document.getText());
    const filenames = uniqueKeys([
      ...[...source.matchAll(/\\addbibresource\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g)].map((match) => match[1]),
      ...[...source.matchAll(/\\bibliography\s*\{([^}]+)\}/g)].flatMap((match) =>
        match[1].split(",").map((name) => path.extname(name.trim()) ? name.trim() : `${name.trim()}.bib`),
      ),
    ]);
    if (!filenames.length) {
      throw new Error(`No bibliography declaration found in ${document.uri.fsPath}. Add % !TeX root = path/to/main.tex to the section file, or declare a bibliography in the root file.`);
    }
    const filename = filenames.length === 1 ? filenames[0] : await vscode.window.showQuickPick(filenames, {
      placeHolder: "Choose the bibliography file to update",
    });
    return filename ? relativeToDocument(document.uri, filename) : undefined;
  }

  const source = document.getText();
  if (document.languageId === "typst") {
    const filename = source.match(/#bibliography\s*\(\s*\(?\s*"([^"]+)"/)?.[1];
    if (filename) {
      return relativeToDocument(document.uri, filename);
    }
  }
  const frontMatter = source.match(/^---\s*\n([\s\S]*?)\n---/);
  const filename = frontMatter && yamlBibliography(frontMatter[1]);
  if (filename) {
    return relativeToDocument(document.uri, filename);
  }
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (folder) {
    for (const name of ["_quarto.yml", "_quarto.yaml"]) {
      const uri = vscode.Uri.joinPath(folder.uri, name);
      if (await fileExists(uri)) {
        const config = await vscode.workspace.openTextDocument(uri);
        const bib = yamlBibliography(config.getText());
        if (bib) {
          return relativeToDocument(uri, bib);
        }
      }
    }
  }
  return undefined;
}

export function bibliographyKeys(content: string, extension: string): Set<string> {
  if (extension === ".json") {
    const entries = content.trim() ? JSON.parse(content) : [];
    if (!Array.isArray(entries)) {
      throw new Error("A CSL JSON bibliography must contain an array of entries");
    }
    return new Set(entries.map((entry: { id: string }) => String(entry.id)));
  }
  if (extension === ".yml" || extension === ".yaml") {
    return new Set([...content.matchAll(/^\s*-?\s*id:\s*([^\r\n]+)/gm)].map((match) =>
      match[1].trim().replace(/^(["'])(.*)\1$/, "$2"),
    ));
  }
  return new Set([...content.matchAll(/^\s*@(?!string\b|comment\b|preamble\b)[a-z]+\s*[{(]\s*([^,\s]+)\s*,/gim)].map((match) => match[1]));
}

function yamlEntries(content: string): string {
  return content.trim()
    .replace(/^---\s*\r?\n/, "")
    .replace(/^references:\s*\r?\n/, "")
    .replace(/\r?\n(?:---|\.\.\.)\s*$/, "")
    .trimEnd();
}

export function mergeBibliography(content: string, exported: string, extension: string): string {
  if (extension === ".json") {
    const entries = JSON.parse(exported);
    if (!Array.isArray(entries)) {
      throw new Error("Zotero returned invalid CSL JSON");
    }
    return JSON.stringify([...(content.trim() ? JSON.parse(content) : []), ...entries], null, 2) + "\n";
  }
  if (extension === ".yml" || extension === ".yaml") {
    exported = yamlEntries(exported);
    content = content.replace(/(?:\r?\n)?(?:---|\.\.\.)\s*$/, "");
  }
  return content + (content && !content.endsWith("\n") ? "\n" : "") + exported.trimEnd() + "\n";
}

export interface BibliographyUpdate {
  uri: vscode.Uri;
  document?: vscode.TextDocument;
  version?: number;
  text: string;
  save: boolean;
}

export async function prepareBibliographyUpdate(
  uri: vscode.Uri,
  citekeys: string[],
): Promise<BibliographyUpdate | undefined> {
  const document = await fileExists(uri) ? await vscode.workspace.openTextDocument(uri) : undefined;
  const content = document?.getText() ?? "";
  const version = document?.version;
  const extension = path.extname(uri.path).toLowerCase();
  const existing = bibliographyKeys(content, extension);
  const missing = uniqueKeys(citekeys).filter((key) => !existing.has(key));
  if (!missing.length) {
    return undefined;
  }
  const translator = extension === ".json" ? "Better CSL JSON"
    : extension === ".yml" || extension === ".yaml" ? "Better CSL YAML" : "Better BibTeX";
  const exported = await exportBibliography(missing, translator);
  const returned = bibliographyKeys(exported, extension);
  const absent = missing.filter((key) => !returned.has(key));
  if (absent.length) {
    throw new Error(`Zotero did not export these citation keys: ${absent.join(", ")}`);
  }
  return { uri, document, version, text: mergeBibliography(content, exported, extension), save: !document?.isDirty };
}
