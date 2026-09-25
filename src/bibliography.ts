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

async function findLatexRoot(document: vscode.TextDocument): Promise<vscode.TextDocument | undefined> {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const documents = new Map<string, vscode.TextDocument>([[document.uri.toString(), document]]);
  const candidates: vscode.TextDocument[] = [];
  if (folder) {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, "**/*.tex"), "**/{.git,node_modules}/**",
    );
    for (const uri of files) {
      const file = await vscode.workspace.openTextDocument(uri);
      documents.set(uri.toString(), file);
      if (/\\documentclass\b/.test(withoutLatexComments(file.getText()))) {
        candidates.push(file);
      }
    }
  }

  // ponytail: literal input/include paths only; macro-based paths need an explicit root.
  const includesDocument = async (
    file: vscode.TextDocument,
    root: vscode.Uri,
    visited: Set<string>,
  ): Promise<boolean> => {
    const id = file.uri.toString();
    if (visited.has(id)) {
      return false;
    }
    visited.add(id);
    const source = withoutLatexComments(file.getText());
    for (const match of source.matchAll(/\\(?:input|include)\b\s*(?:\{([^{}]+)\}|([^\s{}]+))/g)) {
      const filename = (match[1] ?? match[2]).trim();
      if (filename.includes("\\") || filename.includes("#")) {
        continue;
      }
      const names = path.extname(filename) ? [filename] : [`${filename}.tex`, filename];
      for (const name of names) {
        // TeX resolves ordinary input/include paths from the compilation root.
        const uri = relativeToDocument(root, name);
        if (uri.toString() === document.uri.toString()) {
          return true;
        }
        let child = documents.get(uri.toString());
        if (!child && await fileExists(uri)) {
          child = await vscode.workspace.openTextDocument(uri);
          documents.set(uri.toString(), child);
        }
        if (child) {
          if (await includesDocument(child, root, visited)) {
            return true;
          }
          break;
        }
      }
    }
    return false;
  };

  const roots: vscode.TextDocument[] = [];
  for (const candidate of candidates) {
    if (await includesDocument(candidate, candidate.uri, new Set())) {
      roots.push(candidate);
    }
  }
  if (roots.length === 1) {
    return roots[0];
  }
  if (roots.length > 1) {
    const picked = await vscode.window.showQuickPick(roots.map((root) => ({
      label: vscode.workspace.asRelativePath(root.uri), document: root,
    })), { placeHolder: "Several main documents include this file. Choose the LaTeX root." });
    return picked?.document;
  }
  const picked = await vscode.window.showOpenDialog({
    title: "No LaTeX root found. Select the main document.",
    openLabel: "Use main document",
    canSelectMany: false,
    filters: { LaTeX: ["tex"] },
    defaultUri: folder?.uri ?? vscode.Uri.joinPath(document.uri, ".."),
  });
  return picked?.[0] ? vscode.workspace.openTextDocument(picked[0]) : undefined;
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

    if (visited.size === 1 && !/\\(?:documentclass|bibliography|addbibresource)\b/.test(withoutLatexComments(document.getText()))) {
      const root = await findLatexRoot(document);
      if (!root) {
        return undefined;
      }
      document = root;
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
