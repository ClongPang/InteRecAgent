const ASCII_TOKEN = /[a-z0-9]+/giu;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu;

function uniqueBounded(values: Iterable<string>, limit: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

/** Deterministic Unicode-normalized lexical tokens using ASCII words and CJK bigrams. */
export function tokenizeSearchText(value: string, limit = 128): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) throw new Error("INVALID_SEARCH_TOKEN_LIMIT");
  const normalized = value.normalize("NFKC").toLocaleLowerCase("en-US");
  const tokens: string[] = [];
  for (const match of normalized.matchAll(ASCII_TOKEN)) {
    const token = match[0];
    if (token.length <= 40) tokens.push(token);
  }
  for (const match of normalized.matchAll(CJK_RUN)) {
    const characters = [...match[0]];
    if (characters.length === 1) tokens.push(characters[0]!);
    else for (let index = 0; index < characters.length - 1; index += 1) tokens.push(`${characters[index]}${characters[index + 1]}`);
  }
  return uniqueBounded(tokens, limit);
}

export interface SearchTokenMatch {
  matchedTokens: string[];
  coverage: number;
}

export function matchSearchTokens(candidateTokens: readonly string[], queryTokens: readonly string[]): SearchTokenMatch {
  const query = uniqueBounded(queryTokens, 128);
  if (query.length === 0) return { matchedTokens: [], coverage: 0 };
  const candidate = new Set(candidateTokens);
  const matchedTokens = query.filter((token) => candidate.has(token));
  return { matchedTokens, coverage: matchedTokens.length / query.length };
}
