import * as vscode from 'vscode';
import requestPromise from 'request-promise';
import * as fs from 'fs';
import * as path from 'path';

interface ZoteroConfig {
  port: number;
  citeMethod?: 'zotero' | 'vscode';
}

// Better BibTeX search result interface
interface SearchResult {
  type: string;
  citekey: string;
  title: string;
  author?: [{ family: string, given: string }];
  [field: string]: any;
}

// QuickPick item for bibliography entries
class EntryItem implements vscode.QuickPickItem {
  label: string;
  detail?: string;
  description?: string;
  alwaysShow?: boolean;

  constructor(public result: SearchResult) {
    this.label = result.title || 'Untitled';
    this.detail = result.citekey || '';
    this.alwaysShow = true; // Prevent VS Code from filtering this item

    if (result.author && result.author.length > 0) {
      const names = result.author.map(a => `${a.given || ''} ${a.family || ''}`.trim());

      if (names.length === 1) {
        this.description = names[0];
      } else if (names.length === 2) {
        this.description = names.join(' and ');
      } else if (names.length > 2) {
        this.description = names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
      }
    } else {
      this.description = '';
    }
  }
}

// QuickPick item for error messages
class ErrorItem implements vscode.QuickPickItem {
  label: string;
  alwaysShow?: boolean;

  constructor(public message: string) {
    this.label = message.replace(/\r?\n/g, ' ');
    this.alwaysShow = true; // Prevent VS Code from filtering this item
  }
}

// Extract bibliography file path from YAML front matter or _quarto.yaml
async function extractBibliographyFile(
  document: vscode.TextDocument
): Promise<{ bibFile: string; isFromQuartoYaml: boolean } | null> {
  // First, check document's YAML front matter
  const documentText = document.getText();
  const yamlMatch = documentText.match(/^---\s*\n([\s\S]*?)\n---/);

  if (yamlMatch) {
    const yamlContent = yamlMatch[1];
    const bibliographyMatch = yamlContent.match(/bibliography:\s*([^\s\n]+)/);

    if (bibliographyMatch) {
      return {
        bibFile: bibliographyMatch[1].replace(/["']/g, ''),
        isFromQuartoYaml: false
      };
    }
  }

  // If not found, check for _quarto.yml or _quarto.yaml in workspace
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    return null;
  }

  for (const quartoFile of ['_quarto.yml', '_quarto.yaml']) {
    const quartoPath = path.join(workspaceFolder.uri.fsPath, quartoFile);

    if (fs.existsSync(quartoPath)) {
      const quartoContent = fs.readFileSync(quartoPath, 'utf8');
      const bibliographyMatch = quartoContent.match(/bibliography:\s*([^\s\n]+)/);

      if (bibliographyMatch) {
        return {
          bibFile: bibliographyMatch[1].replace(/["']/g, ''),
          isFromQuartoYaml: true
        };
      }
    }
  }

  return null;
}

// Extract citation key from citation text (e.g., @key or [@key] -> key)
function extractCitationKey(citationText: string): string | null {
  // Try @key format first (what Zotero actually returns)
  let match = citationText.match(/@([a-zA-Z0-9_-]+)/);
  if (match) {
    return match[1];
  }

  // Fallback to [@key] format
  match = citationText.match(/\[@([^\]]+)\]/);
  return match ? match[1] : null;
}

// Get Bib entry from Zotero for a given citation key
async function getBibEntry(citeKey: string, translator: string = 'Better BibTeX'): Promise<string | null> {
  const options = {
    method: 'POST',
    uri: 'http://localhost:23119/better-bibtex/json-rpc',
    body: {
      'jsonrpc': '2.0',
      'method': 'item.export',
      'params': [[citeKey], translator]
    },
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Request-Promise'
    },
    json: true
  };

  try {
    const response: any = await requestPromise(options);
    let result = response.result || null;

    // Strip YAML front matter wrapper for Better CSL YAML exports
    if (result && translator === 'Better CSL YAML') {
      result = result.split('\n').slice(2, -2).join('\n');
    }

    // Strip array brackets for Better CSL JSON exports
    if (result && translator === 'Better CSL JSON') {
      result = result.split('\n').slice(1, -2).join('\n');
    }

    return result;
  } catch (err) {
    console.log('Failed to fetch bibliography entry:', err);
    return null;
  }
}

// Parse advanced search query into Better BibTeX search format
function parseSearchQuery(query: string): string | Array<Array<string>> {
  const trimmedQuery = query.trim();

  // Map common field names to Better BibTeX search fields
  const fieldMapping: { [key: string]: string } = {
    'author': 'creator',
    'creator': 'creator',
    'title': 'title',
    'year': 'date',
    'date': 'date',
    'journal': 'publicationTitle',
    'publication': 'publicationTitle',
    'tag': 'tag',
    'note': 'note',
    'doi': 'DOI',
    'isbn': 'ISBN',
    'type': 'itemType'
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
        const searchValue = value.replace(/^["']|["']$/g, '').trim(); // Remove quotes

        searchConditions.push([searchField, 'contains', searchValue]);
      }
    }

    // Extract any remaining text that's not in field:value format
    let remainingText = trimmedQuery;
    for (const pattern of advancedSearchPatterns) {
      remainingText = remainingText.replace(pattern, '').trim();
    }

    // If there's remaining text, add it as a general search
    if (remainingText) {
      searchConditions.push(['quicksearch-titleCreatorYear', 'contains', remainingText]);
    }

    return searchConditions;
  }

  // For simple queries without field specifiers, use quicksearch-titleCreatorYear
  return [['quicksearch-titleCreatorYear', 'contains', trimmedQuery]];
}

// Search Zotero database using Better BibTeX JSON-RPC
async function searchZotero(query: string): Promise<SearchResult[]> {
  const searchTerms = parseSearchQuery(query);

  const options = {
    method: 'POST',
    uri: 'http://localhost:23119/better-bibtex/json-rpc',
    body: {
      'jsonrpc': '2.0',
      'method': 'item.search',
      'params': [searchTerms]
    },
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Request-Promise'
    },
    json: true,
    timeout: 5000
  };

  try {
    const response: any = await requestPromise(options);
    const results = response.result || [];
    return results;
  } catch (err) {
    console.log('Failed to search Zotero:', err);
    throw new Error('Could not connect to Zotero. Is Zotero running with Better BibTeX?');
  }
}

// Update .bib file with new entry
async function updateBibFile(bibFilePath: string, bibEntry: string, citeKey: string): Promise<void> {
  try {
    let bibContent = '';
    const fileExtension = path.extname(bibFilePath).toLowerCase();

    // Read existing bibliography file if it exists
    if (fs.existsSync(bibFilePath)) {
      bibContent = fs.readFileSync(bibFilePath, 'utf8');

      // Check if the citation key already exists (format depends on file type)
      let keyExists = false;

      if (fileExtension === '.yml' || fileExtension === '.yaml') {
        // CSL YAML format: "- id: citekey"
        keyExists = new RegExp(`^\\s*-?\\s*id:\\s*['"]?${citeKey}['"]?\\s*$`, 'm').test(bibContent);
      } else if (fileExtension === '.json') {
        // CSL JSON format: "id": "citekey" or 'id': 'citekey'
        keyExists = new RegExp(`["']id["']\\s*:\\s*["']${citeKey}["']`, 'm').test(bibContent);
      } else {
        // BibTeX format: @type{citekey, or @type{citekey }
        keyExists = bibContent.includes(`{${citeKey},`) ||
                    bibContent.includes(`{${citeKey} `);
      }

      if (keyExists) {
        console.log(`Citation key ${citeKey} already exists in bibliography file`);
        return;
      }
    }

    // Append new entry
    let newContent: string;

    if (fileExtension === '.json') {
      // For JSON CSL formats, insert bibEntry into the array
      if (bibContent === '') {
        // Initialize new json array
        newContent = `[\n${bibEntry}\n]`;
      } else {
        // Insert at end of json array
        const lastBracket = bibContent.lastIndexOf(']');
        const beforeBracket = bibContent.substring(0, lastBracket).trimEnd();
        const needsComma = beforeBracket && !beforeBracket.endsWith(',');
        newContent = beforeBracket + (needsComma ? ',' : '') + '\n' + bibEntry + '\n]';
      }
    } else {
      // For other formats, append to end
      newContent = bibContent + (bibContent && !bibContent.endsWith('\n') ? '\n' : '') + bibEntry + '\n';
    }

    fs.writeFileSync(bibFilePath, newContent, 'utf8');

    console.log(`Added citation ${citeKey} to ${bibFilePath}`);
  } catch (err) {
    console.log('Failed to update bibliography file:', err);
    vscode.window.showWarningMessage(`Failed to update bibliography file: ${err}`);
  }
}

// Native VS Code citation picker using QuickPick
async function showVSCodePicker(): Promise<void> {
  const picker = vscode.window.createQuickPick();
  picker.placeholder = 'Search for citations... (try "author:lastname" for advanced search)';
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
        const items: EntryItem[] = results.map(result => new EntryItem(result));

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

  picker.onDidChangeValue(value => {
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
      insertCitation(`@${selection.result.citekey}`);
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
  const config: ZoteroConfig = vscode.workspace.getConfiguration('zotero-citation-picker') as any;

  try {
    const result: string = await requestPromise(String(config.port));
    if (result) {
      await insertCitation(result);
    }
  } catch (err: any) {
    console.log('Failed to fetch citation: %j', err.message);
    vscode.window.showErrorMessage('Zotero Citations: could not connect to Zotero. Are you sure it is running?');
  }
}

// Insert citation and update bibliography file
async function insertCitation(citation: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('No active text editor found');
    return;
  }

  // Insert citation into document
  await editor.edit(editBuilder => {
    editor.selections.forEach(selection => {
      editBuilder.delete(selection);
      editBuilder.insert(selection.start, citation);
    });
  });

  // Update .bib file
  const bibInfo = await extractBibliographyFile(editor.document);

  if (bibInfo) {
    const citeKey = extractCitationKey(citation);

    if (citeKey) {
      // Determine translator based on file extension
      const fileExtension = path.extname(bibInfo.bibFile).toLowerCase();

      const translator =
        fileExtension === '.yml' || fileExtension === '.yaml'
          ? 'Better CSL YAML'
          : fileExtension === '.json'
          ? 'Better CSL JSON'
          : 'Better BibTeX';

      const bibEntry = await getBibEntry(citeKey, translator);

      if (bibEntry) {
        // Determine base path based on where bibliography is defined
        let basePath: string;

        if (bibInfo.isFromQuartoYaml) {
          // Bibliography from _quarto.yaml, use workspace root
          const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
          basePath = workspaceFolder ? workspaceFolder.uri.fsPath : path.dirname(editor.document.uri.fsPath);
        } else {
          // Bibliography from document's YAML front matter, use document's directory
          basePath = path.dirname(editor.document.uri.fsPath);
        }

        const bibFilePath = path.resolve(basePath, bibInfo.bibFile);

        await updateBibFile(bibFilePath, bibEntry, citeKey);
      }
    }
  }
}

// Main citation picker function that chooses between methods
async function showCitationPicker(): Promise<void> {
  const config: ZoteroConfig = vscode.workspace.getConfiguration('zotero-citation-picker') as any;
  const citeMethod = config.citeMethod || 'zotero';

  if (citeMethod === 'vscode') {
    await showVSCodePicker();
  } else {
    await showZoteroPicker();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  console.log('Congratulations, your extension "zotero citation picker" is now active!');

  let disposable = vscode.commands.registerCommand('extension.zoteroCitationPicker', () => {
    showCitationPicker();
  });

  context.subscriptions.push(disposable);
}

export function deactivate(): void {
  // This function is called when the extension is deactivated
}
