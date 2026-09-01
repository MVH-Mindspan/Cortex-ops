// Sniff-and-retry guard for the fp8 generation model. About 1% of calls to
// @cf/meta/llama-3.3-70b-instruct-fp8-fast collapse from the first token into
// repeated high-frequency function words ("the a of the the a of..."). This is
// a serving-side quantization instability, not a prompt problem, so the fix is
// to look at the first few hundred characters before anything reaches the UI
// and regenerate when the sample reads as soup. Pure module: no imports.

export const DEGEN_SNIFF_CHARS = 240;

const SAMPLE_WORDS = 60;
// Below this many words there is not enough signal to call an answer garbled
// (a short legitimate answer must never be thrown away).
const MIN_WORDS = 10;
const STOP_RATIO_MAX = 0.85;
const UNIQUE_RATIO_MIN = 0.2;

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "in",
  "and",
  "or",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "for",
  "on",
  "at",
  "by",
  "with",
  "as",
  "from",
  "but",
  "not",
  "no",
  "if",
  "then",
  "so",
  "than",
  "too",
  "very",
  "can",
  "will",
  "do",
  "does",
  "did",
  "has",
  "have",
  "had",
  "he",
  "she",
  "they",
  "we",
  "you",
  "i",
  "me",
  "my",
  "your",
  "our",
  "their",
  "his",
  "her",
  "them",
  "us",
  "what",
  "which",
  "who",
  "when",
  "where",
  "how"
]);

const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

// True when the opening words are almost all function words, or almost all
// the same word: the two shapes the collapse takes.
export function looksDegenerate(text: string): boolean {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(EDGE_PUNCTUATION, ""))
    .filter((word) => word.length > 0)
    .slice(0, SAMPLE_WORDS);
  if (words.length < MIN_WORDS) return false;
  const stopRatio =
    words.filter((word) => STOPWORDS.has(word)).length / words.length;
  const uniqueRatio = new Set(words).size / words.length;
  return stopRatio > STOP_RATIO_MAX || uniqueRatio < UNIQUE_RATIO_MIN;
}
