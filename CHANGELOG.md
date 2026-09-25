# Change Log

## 0.5.3

- Discover the main LaTeX document through recursive `\input` and `\include` relationships when a section has no root comment.
- Ask which main document to use when several include the section, and allow manual selection when none can be inferred.

## 0.5.2

- Select multiple citations across searches and insert them together; merge keys into existing LaTeX citations.
- Follow `% !TeX root` comments and resolve bibliography paths relative to the main document.
- Batch-export missing bibliography entries, preserve unsaved changes, and stop insertion when export fails.
- Preserve multi-citation CAYW output and add isolated VS Code extension-host regression checks.

## 0.3.0

- Remove unused functions "openInZotero" and "openPDFZotero"
- Update metadata with new maintainer info

## 0.2.1

- When no bibliography is specified in the document YAML front matter, the extension now checks for a bibliography file in `_quarto.yml` at the workspace root.

## 0.2.0

- Inserting a citation now updates the .bib file if one is specified in the YAML front matter (`bibliography: <filename>.bib`)
- Default citation picker is now the VS Code picker but can be changed to Zotero's Cite as you Write popup

## 0.1.11

- Migrated to TypeScript

## 0.1.9

- Added option to customise the port/URL

## 0.1.0

- Initial release
