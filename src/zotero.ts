// Better BibTeX search result interface
export interface SearchResult {
  type: string;
  citekey: string;
  title: string;
  author?: { family: string; given: string }[];
  [field: string]: any;
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
  if (data.error) {
    throw new Error(data.error.message || "Zotero JSON-RPC request failed");
  }
  if (!("result" in data)) {
    throw new Error("Zotero returned an invalid JSON-RPC response");
  }
  return data.result;
}

export async function exportBibliography(
  citekeys: string[],
  translator: string,
): Promise<string> {
  const result = await zoteroJsonRpc("item.export", [citekeys, translator]);
  if (typeof result !== "string" || !result.trim()) {
    throw new Error("Zotero returned an empty bibliography export");
  }
  return result;
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
export async function searchZotero(query: string): Promise<SearchResult[]> {
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
