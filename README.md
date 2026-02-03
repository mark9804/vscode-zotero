# Zotero Citation Picker

[Positron](https://positron.posit.co/) (and other VS Code IDE) extension to insert citations from [Zotero](https://www.zotero.org/) to your document and its associated `.bib` file. Requires the [Better BibTeX](https://retorque.re/zotero-better-bibtex/) Zotero plugin.

Fork of <https://github.com/mblode/vscode-zotero>, which appears no longer maintained.

## Features

Executing 'Zotero Citation Picker' will call up a citation picker. Use this to find your citation, and insert it into your document and its associated `.bib` file.

- Activate via keyboard shortcut (<kbd>Option + Shift + Z</kbd>)
- Activate via Command Palette (<kbd>Command + Shift + P</kbd>): Type "Zotero Citation Picker" and press enter.

### Two citation picker modes

- Native VS Code picker (default): Search and select citations within VS Code using a QuickPick interface
- Zotero picker: Use Zotero's built-in "Cite as you Write" popup window

You can configure the citation picker behavior in VS Code settings:

- `zotero-citation-picker.citeMethod`: Choose between "vscode" (native VS Code picker) or "zotero" (Zotero's CAYW popup)
- `zotero-citation-picker.port`: Customize the Zotero Better BibTeX URL (only used for Zotero picker mode)

### Native VS Code Citation Picker Features

- Simple search: Type any text to search across titles, authors, and other fields
- Advanced search: Use field-specific searches like:
  - `author:vuorre` - Search by author name
  - `title:climate` - Search in title field
  - `year:2023` - Search by publication year
  - `journal:nature` - Search by journal/publication
  - `tag:statistics` - Search by tags
  - `doi:10.1000` - Search by DOI
  - Multiple fields: `author:smith title:climate` - Search multiple fields simultaneously

## Development

Test files are in `playground/` (test.md, test.qmd). Press F5 to launch extension in debug mode with test.md open.
