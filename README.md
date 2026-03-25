# Zotero Citation Picker

> [!WARNING]
> 
> Breaking changes introduced since 0.3.0:
>
> - Markdown documents will no longer support frontmatter .bib file. Instead, formatted reference items will be attached to the end of the document.
> - Quarto Markdown documents will still respect to frontmatter .bib file.

VS Code-like editor extension to insert citations from [Zotero](https://www.zotero.org/) to your:

- (Quarto) markdown document(s);
- $\LaTeX$ document and its associated `.bib` file.

Requires the [Better BibTeX](https://retorque.re/zotero-better-bibtex/) Zotero plugin.

Fork of <https://github.com/mblode/vscode-zotero>, which appears no longer maintained; and <https://github.com/mvuorre/vscode-zotero>, with basic Quarto Markdown support.

## Installation

0. Install [Zotero](https://www.zotero.org/) and [Better BibTeX](https://retorque.re/zotero-better-bibtex/) Zotero plugin.
1. Install from the IDE extension market, or download from either [Open VSX registry](https://open-vsx.org/extension/mark9804/zotero-latex-cite), or build from source.
2. If you choose to install from outside the IDE extension market, run `<your-ide-cli-name> --install-extension "/path/to/extension.vsix"` to install the extension.

## Usage

You can activate the citation picker either by:

- Keyboard shortcut <kbd>Option + Shift + Z</kbd> (can be customized in VS Code settings)
- Command Palette (<kbd>Command + Shift + P</kbd>): Type "Zotero Citation Picker" and press enter.

## Extension settings

- `zotero-citation-picker.citeMethod`: Choose between "vscode" (native VS Code picker) or "zotero" (Zotero's CAYW popup)
  - Native VS Code picker (default): Search and select citations within VS Code using a QuickPick interface
  - Zotero picker: Use Zotero's built-in "Cite as you Write" popup window
- `zotero-citation-picker.port`: Customize the Zotero Better BibTeX URL (only used for Zotero picker mode)
- `zotero-citation-picker.markdownCitationTemplate`: Customize the Markdown citation text. Available variables: `{{authors}}`, `{{year}}`, `{{title}}`, `{{container}}`. Default to APA style `{{authors}}. ({{year}}). {{title}}. {{container}}.`

## Native VS Code Citation Picker Behavior

- Simple search: Type any text to search across titles, authors, and other fields
- Advanced search: Use field-specific searches like:
  - `author:vuorre` - Search by author name
  - `title:climate` - Search in title field
  - `year:2023` - Search by publication year
  - `journal:nature` - Search by journal/publication
  - `tag:statistics` - Search by tags
  - `doi:10.1000` - Search by DOI
  - Multiple fields: `author:smith title:climate` - Search multiple fields simultaneously

## Contributing

Feel free to fire off an issue or PR at <https://github.com/mark9804/vscode-zotero/issues>. Please note that the code has been heavily modified compared to the original repository, so an issue mistakenly created in the original repository may introduce confusion.

## Development

Test files are in `playground/` (test.md, test.qmd, main.tex). Press F5 to launch extension in debug mode with test.md open. Default files to open can be changed in `.vscode/launch.json`.
