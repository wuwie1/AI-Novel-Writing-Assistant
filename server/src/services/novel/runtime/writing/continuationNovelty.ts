/** Validate append-only model output against already saved prose; never edit the source. */
export function validateContinuationNovelty(content: string, continuation: string): {
  accepted: boolean;
  repeatedCharacters: number;
} {
  const source = content.replace(/\s/gu, "");
  const addition = continuation.replace(/\s/gu, "");
  // Short repeated words/dialogue can be intentional. Long verbatim replay is not new prose.
  const minimumReplay = 80;
  for (let offset = 0; offset <= addition.length - minimumReplay; offset++) {
    const cursor = source.indexOf(addition.slice(offset, offset + minimumReplay));
    if (cursor < 0) continue;
    let length = minimumReplay;
    while (offset + length < addition.length && source[cursor + length] === addition[offset + length]) length++;
    return { accepted: false, repeatedCharacters: length };
  }
  return { accepted: true, repeatedCharacters: 0 };
}
