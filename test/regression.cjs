const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const citations = require('../out/citations');
const bibliography = require('../out/bibliography');
const pickerModule = require('../out/picker');
const { insertCitations } = require('../out/extension');

const root = process.env.ZOTERO_TEST_WORKSPACE;
const bibEntry = (key) => `@article{${key},\n  title = {Title ${key}}\n}\n`;
const ok = (result) => ({ ok: true, json: async () => ({ result }), text: async () => result });
const cursor = (document, offset = document.getText().length) => {
  const position = document.positionAt(offset);
  return [new vscode.Selection(position, position)];
};
async function file(name, content) {
  const filename = path.join(root, name);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, content);
  return vscode.workspace.openTextDocument(vscode.Uri.file(filename));
}
async function append(document, text) {
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, document.positionAt(document.getText().length), text);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}
async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('Timed out waiting for the QuickPick');
}

exports.run = async function () {
  let passed = 0;
  const originalFetch = global.fetch;
  const originalQuickPick = vscode.window.showQuickPick;
  const originalOpenDialog = vscode.window.showOpenDialog;
  const unexpectedDialog = async () => assert.fail('Unexpected root selection dialog');
  vscode.window.showQuickPick = unexpectedDialog;
  vscode.window.showOpenDialog = unexpectedDialog;
  const check = async (name, run) => {
    await run();
    console.log(`PASS: ${name}`);
    passed++;
  };
  try {
    await check('LaTeX groups, page notes, comments and duplicate keys', async () => {
      assert.deepEqual(citations.extractCitationKeys('\\cite{A,B}\\citep[see][p. 3]{C}\\citeyear{A}\n% \\cite{ignored}', 'latex'), ['A', 'B', 'C']);
      const source = '\\citep*[see][p. 2]{A,B}';
      const offset = source.indexOf('A,B') + 1;
      const edits = citations.citationEdits(source, [{ start: offset, end: offset }, { start: offset + 1, end: offset + 1 }], { citekeys: ['B', 'C'] }, 'latex');
      assert.equal(edits.length, 1);
      const [edit] = edits;
      assert.equal(source.slice(0, edit.start) + edit.text + source.slice(edit.end), '\\citep*[see][p. 2]{A,B,C}');
      assert.throws(() => citations.citationEdits(source, [{ start: offset, end: offset }], { citekeys: ['C'], text: '\\cite[p. 3]{C}' }, 'latex'), /preserve/);
      assert.equal(citations.formatCitation(['A', 'B'], 'quarto'), '[@A; @B]');
      assert.equal(citations.formatCitation(['A', 'B'], 'typst'), '@A @B');
    });

    await check('CAYW preserves formatted text and exports all keys', async () => {
      const text = '\\cite[see][p. 3]{A,B}\\citeyear{C}';
      global.fetch = async (url) => {
        assert.equal(new URL(url).searchParams.get('format'), 'latex');
        return ok(text);
      };
      assert.deepEqual(await pickerModule.showZoteroPicker('http://localhost:23119/better-bibtex/cayw', 'latex'), { citekeys: ['A', 'B', 'C'], text });
      global.fetch = async () => ok('');
      assert.equal(await pickerModule.showZoteroPicker('http://localhost/cayw', 'latex'), undefined);
    });

    let section;
    let bib;
    await check('Section root, unsaved root declaration, batch export and dirty bibliography', async () => {
      const main = await file('paper/main.tex', '\\documentclass{article}\n');
      await append(main, '\\bibliography{main}\n');
      section = await file('paper/sec/intro.tex', '% !TeX root = ../main.tex\nText ');
      bib = await file('paper/main.bib', bibEntry('A'));
      await append(bib, bibEntry('Pending'));
      assert.equal((await bibliography.resolveBibliographyUri(section)).toString(), bib.uri.toString());
      const requests = [];
      global.fetch = async (_url, request) => {
        requests.push(JSON.parse(request.body));
        return ok(bibEntry('B') + bibEntry('C'));
      };
      await insertCitations(section, cursor(section), section.version, { citekeys: ['A', 'B', 'C', 'B'] });
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].params, [['B', 'C'], 'Better BibTeX']);
      assert.ok(section.getText().endsWith('\\cite{A,B,C}'));
      assert.equal(bib.getText(), ['A', 'Pending', 'B', 'C'].map(bibEntry).join(''));
      assert.equal(await fs.readFile(bib.uri.fsPath, 'utf8'), bibEntry('A'));
      assert.equal(bib.isDirty, true);
    });

    await check('Existing citation merge and existing bibliography keys need no export', async () => {
      global.fetch = async () => assert.fail('Existing keys should not be exported');
      const offset = section.getText().lastIndexOf('A,B');
      await insertCitations(section, cursor(section, offset), section.version, { citekeys: ['A', 'B', 'C'] });
      assert.ok(section.getText().endsWith('\\cite{A,B,C}'));
    });

    await check('Failed or incomplete exports leave both documents untouched', async () => {
      const before = section.getText();
      const beforeBib = bib.getText();
      global.fetch = async () => ({ ok: true, json: async () => ({ error: { message: 'Export failed' } }) });
      await assert.rejects(insertCitations(section, cursor(section), section.version, { citekeys: ['D'] }), /Export failed/);
      global.fetch = async () => ok(bibEntry('D'));
      await assert.rejects(insertCitations(section, cursor(section), section.version, { citekeys: ['D', 'E'] }), /E/);
      assert.equal(section.getText(), before);
      assert.equal(bib.getText(), beforeBib);
    });

    await check('Changes during export invalidate the captured insertion position', async () => {
      global.fetch = async () => { await append(section, 'manual edit'); return ok(bibEntry('D')); };
      const beforeBib = bib.getText();
      await assert.rejects(insertCitations(section, cursor(section), section.version, { citekeys: ['D'] }), /document changed/);
      assert.ok(section.getText().endsWith('manual edit'));
      assert.equal(bib.getText(), beforeBib);
    });

    await check('Clean bibliography is saved and missing bibliography can be created', async () => {
      await bib.save();
      global.fetch = async () => ok(bibEntry('D'));
      await insertCitations(section, cursor(section), section.version, { citekeys: ['D'] });
      assert.ok((await fs.readFile(bib.uri.fsPath, 'utf8')).includes(bibEntry('D')));
      const main = await file('new/main.tex', '\\addbibresource[encoding=utf8]{refs.bib}\n');
      await insertCitations(main, cursor(main), main.version, { citekeys: ['D'] });
      assert.equal(await fs.readFile(path.join(root, 'new/refs.bib'), 'utf8'), bibEntry('D'));
    });

    await check('Missing or circular root fails before editing', async () => {
      const bad = await file('invalid/section.tex', '% !TeX root = missing.tex\nText');
      const before = bad.getText();
      await assert.rejects(insertCitations(bad, cursor(bad), bad.version, { citekeys: ['D'] }), /Cannot open LaTeX root/);
      assert.equal(bad.getText(), before);
      const circular = await file('invalid/self.tex', '% !TeX root = self.tex');
      await assert.rejects(bibliography.resolveBibliographyUri(circular), /Circular/);
      const plain = await file('invalid/plain.tex', '\\documentclass{article}\n\\section{Introduction}');
      await assert.rejects(bibliography.resolveBibliographyUri(plain), /No bibliography declaration/);
    });

    await check('Discover a unique root through nested includes and unsaved main-file changes', async () => {
      const main = await file('automatic/paper.tex', '\\documentclass{article}\n\\bibliography{refs}\n');
      await file('automatic/sec/outline.tex', '\\include{sec/intro}\n');
      await append(main, '\\input{sec/outline}\n');
      await file('automatic/other.tex', '\\documentclass{article}\n% \\input{sec/intro}\n\\input{not-created-yet}\n\\bibliography{other}\n');
      const section = await file('automatic/sec/intro.tex', '\\section{Introduction}\nText ');
      const bib = await file('automatic/refs.bib', '');
      assert.equal((await bibliography.resolveBibliographyUri(section)).toString(), bib.uri.toString());
      global.fetch = async (_url, request) => {
        assert.deepEqual(JSON.parse(request.body).params, [['Auto'], 'Better BibTeX']);
        return ok(bibEntry('Auto'));
      };
      await insertCitations(section, cursor(section), section.version, { citekeys: ['Auto'] });
      assert.ok(section.getText().endsWith('\\cite{Auto}'));
      assert.equal(await fs.readFile(bib.uri.fsPath, 'utf8'), bibEntry('Auto'));
      await assert.rejects(fs.stat(path.join(root, 'automatic/sec/refs.bib')), { code: 'ENOENT' });
    });

    await check('Choose between containing roots, cancel safely, and prefer explicit root comments', async () => {
      const main = await file('shared/main.tex', '\\documentclass{article}\n\\input{sec/shared}\n\\bibliography{main}\n');
      const supplement = await file('shared/supplement.tex', '\\documentclass{article}\n\\input sec/shared.tex\n\\bibliography{supplement}\n');
      const shared = await file('shared/sec/shared.tex', 'Shared text ');
      let prompts = 0;
      try {
        vscode.window.showQuickPick = async (items) => {
          prompts++;
          assert.deepEqual(items.map((item) => item.document.uri.toString()).sort(), [main.uri.toString(), supplement.uri.toString()].sort());
          return items.find((item) => item.document === supplement);
        };
        assert.equal((await bibliography.resolveBibliographyUri(shared)).fsPath, path.join(root, 'shared/supplement.bib'));
        assert.equal(prompts, 1);
        vscode.window.showQuickPick = async () => undefined;
        global.fetch = async () => assert.fail('Cancelled root selection must not export citations');
        const before = shared.getText();
        await insertCitations(shared, cursor(shared), shared.version, { citekeys: ['A'] });
        assert.equal(shared.getText(), before);
        await append(shared, '\n% !TeX root = ../main.tex\n');
        vscode.window.showQuickPick = unexpectedDialog;
        assert.equal((await bibliography.resolveBibliographyUri(shared)).fsPath, path.join(root, 'shared/main.bib'));
      } finally {
        vscode.window.showQuickPick = unexpectedDialog;
      }
    });

    await check('Choose a main file manually when inclusion cannot be inferred', async () => {
      const manualRoot = await file('manual/main.tex', '\\documentclass{article}\n\\input{\\chapterPath}\n\\bibliography{refs}\n');
      const orphan = await file('manual/sec/orphan.tex', 'Text ');
      try {
        vscode.window.showOpenDialog = async (options) => {
          assert.deepEqual(options.filters, { LaTeX: ['tex'] });
          return [manualRoot.uri];
        };
        assert.equal((await bibliography.resolveBibliographyUri(orphan)).fsPath, path.join(root, 'manual/refs.bib'));
        vscode.window.showOpenDialog = async () => undefined;
        const before = orphan.getText();
        await insertCitations(orphan, cursor(orphan), orphan.version, { citekeys: ['A'] });
        assert.equal(orphan.getText(), before);
      } finally {
        vscode.window.showOpenDialog = unexpectedDialog;
      }
    });

    await check('Markdown multi-footnotes at end of document and Quarto CSL JSON', async () => {
      const markdown = await file('notes.md', 'Text ');
      const results = ['A', 'B'].map((citekey) => ({ citekey, title: citekey, type: 'article' }));
      await insertCitations(markdown, cursor(markdown), markdown.version, { citekeys: ['A', 'B'], results });
      assert.ok(markdown.getText().startsWith('Text [^A][^B]\n\n[^A]:'));
      assert.ok(markdown.getText().includes('\n[^B]:'));
      const quarto = await file('quarto/test.qmd', '---\nbibliography: refs.json\n---\nText ');
      const jsonBib = await file('quarto/refs.json', '[]');
      global.fetch = async () => ok(JSON.stringify([{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }]));
      await insertCitations(quarto, cursor(quarto), quarto.version, { citekeys: ['A', 'B'], results });
      assert.ok(quarto.getText().endsWith('[@A; @B]'));
      assert.equal(JSON.parse(jsonBib.getText()).length, 2);
      assert.deepEqual([...bibliography.bibliographyKeys('---\nreferences:\n- id: A\n- id: "B"\n...\n', '.yaml')], ['A', 'B']);
      assert.equal(bibliography.mergeBibliography('- id: A\n', '---\nreferences:\n- id: B\n...\n', '.yaml'), '- id: A\n- id: B\n');
    });

    await check('Native QuickPick keeps selections across searches, supports deselection and cancellation', async () => {
      const createQuickPick = vscode.window.createQuickPick;
      let picker;
      vscode.window.createQuickPick = (...args) => (picker = createQuickPick(...args));
      try {
        global.fetch = async (_url, request) => {
          const { params } = JSON.parse(request.body);
          const citekey = params[0][0][2];
          return ok([{ citekey, title: citekey, type: 'article' }]);
        };
        const chosen = pickerModule.showVSCodePicker();
        assert.equal(picker.canSelectMany, true);
        picker.value = 'A';
        await waitFor(() => picker.items.some((item) => item.detail === 'A'));
        picker.selectedItems = [picker.items.find((item) => item.detail === 'A')];
        await waitFor(() => picker.title === 'Zotero — 1 selected');
        picker.value = 'B';
        await waitFor(() => picker.items.some((item) => item.detail === 'B'));
        assert.deepEqual(picker.selectedItems.map((item) => item.detail), ['A']);
        picker.selectedItems = picker.items.filter((item) => ['A', 'B'].includes(item.detail));
        await waitFor(() => picker.title === 'Zotero — 2 selected');
        picker.selectedItems = picker.items.filter((item) => item.detail === 'B');
        await waitFor(() => picker.title === 'Zotero — 1 selected');
        picker.selectedItems = picker.items.filter((item) => ['A', 'B'].includes(item.detail));
        await waitFor(() => picker.title === 'Zotero — 2 selected');
        picker.value = '';
        await waitFor(() => picker.items[0]?.detail === 'B' && picker.selectedItems.length === 2);
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        assert.deepEqual((await chosen).citekeys, ['B', 'A']);

        const cancelled = pickerModule.showVSCodePicker();
        picker.hide();
        assert.equal(await cancelled, undefined);
      } finally {
        picker?.dispose();
        vscode.window.createQuickPick = createQuickPick;
      }
    });

    await check('Command keeps its original document when CAYW changes editor focus', async () => {
      const document = await file('focus/main.tex', '\\bibliography{refs}\nText ');
      await file('focus/refs.bib', bibEntry('A'));
      const other = await file('focus/other.tex', 'Other document');
      await vscode.window.showTextDocument(document);
      vscode.window.activeTextEditor.selections = cursor(document);
      await vscode.workspace.getConfiguration('zotero-citation-picker').update('citeMethod', 'zotero', vscode.ConfigurationTarget.Workspace);
      global.fetch = async () => {
        await vscode.window.showTextDocument(other);
        return ok('\\cite{A}');
      };
      await vscode.commands.executeCommand('extension.zoteroCitationPicker');
      assert.ok(document.getText().endsWith('\\cite{A}'));
      assert.equal(other.getText(), 'Other document');
    });

    console.log(`${passed} regression checks passed in VS Code ${vscode.version}`);
  } finally {
    global.fetch = originalFetch;
    vscode.window.showQuickPick = originalQuickPick;
    vscode.window.showOpenDialog = originalOpenDialog;
  }
};
