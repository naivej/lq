export interface Citation {
  key: string;
  title?: string;
  author?: string;
  year?: string;
}

export function parseBibtex(content: string): Citation[] {
  const citations: Citation[] = [];
  
  // Simple regex to find entries: @TYPE{KEY, \n fields \n}
  // This uses a non-greedy match to find the body of the entry
  const entryRegex = /@([a-zA-Z]+)\s*\{\s*([^,]+),([\s\S]*?)\n\}/g;
  
  let match;
  while ((match = entryRegex.exec(content)) !== null) {
    const key = match[2].trim();
    const body = match[3];
    
    const cit: Citation = { key };
    
    // Extract fields (handle multiline with balanced-ish matching or simple heuristic)
    // We match title = { ... }, handling potential nested braces loosely by matching until we hit '},' or '}' at end of line.
    const titleMatch = body.match(/title\s*=\s*(?:\{|\")([\s\S]*?)(?:\}(?:\s*,|\s*$)|"(?:\s*,|\s*$))/i);
    if (titleMatch) cit.title = titleMatch[1].replace(/\s+/g, ' ').replace(/[{}]/g, '').trim();
    
    const authorMatch = body.match(/author\s*=\s*(?:\{|\")([\s\S]*?)(?:\}(?:\s*,|\s*$)|"(?:\s*,|\s*$))/i);
    if (authorMatch) cit.author = authorMatch[1].replace(/\s+/g, ' ').replace(/[{}]/g, '').trim();
    
    const yearMatch = body.match(/year\s*=\s*(?:\{|\")?(\d{4})(?:\}|\")?/i);
    if (yearMatch) cit.year = yearMatch[1];
    
    citations.push(cit);
  }
  
  return citations;
}
