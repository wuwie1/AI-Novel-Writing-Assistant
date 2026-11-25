import {
  EMPTY_STYLE_EXEMPLAR_SET,
  STYLE_EXEMPLAR_OVERLAP_MIN_CHARS,
  WRITER_STYLE_EXEMPLAR_CHAR_BUDGET,
  parseStyleExemplarSet,
  type RuntimeStyleExemplar,
  type StyleBinding,
  type StyleExemplarSet,
} from "@ai-novel/shared/types/styleEngine";

const PLACEHOLDER_LABELS = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥";
const PLACEHOLDER_PATTERN = /〔[^〔〕]{1,6}〕/gu;
const NON_CONTENT_PATTERN = /[\s\p{P}\p{S}_]+/gu;
/** Labels, fences and separators the writer block puts around one exemplar. */
const EXEMPLAR_FRAME_CHARS = 48;
/** The instructions that open the writer block. */
const EXEMPLAR_BLOCK_INTRO_CHARS = 240;
// A copied passage usually has its names swapped, which breaks one long run into several short
// ones. Runs this long are chained across the places where the exemplar had a name.
const OVERLAP_SEED_CHARS = 4;
const MAX_NAME_CHARS = 12;

export interface StyleExemplarOverlap {
  exemplarId: string;
  sharedChars: number;
  /** The shared run as it reads in the candidate, punctuation removed. */
  shared: string;
}

export function parseStoredStyleExemplars(value?: string | null): StyleExemplarSet {
  if (!value) {
    return EMPTY_STYLE_EXEMPLAR_SET;
  }
  try {
    return parseStyleExemplarSet(JSON.parse(value));
  } catch {
    return EMPTY_STYLE_EXEMPLAR_SET;
  }
}

/** Source names become neutral placeholders, lettered in the order they first appear. */
export function maskSourceEntities(text: string, sourceEntities: string[]): string {
  const present = sourceEntities
    .filter((entity) => entity && text.includes(entity))
    .sort((left, right) => text.indexOf(left) - text.indexOf(right));
  const placeholders = new Map(present.map((entity, index) => [
    entity,
    `〔${PLACEHOLDER_LABELS[index] ?? `人物${index + 1}`}〕`,
  ]));
  return [...present]
    .sort((left, right) => right.length - left.length)
    .reduce((current, entity) => current.split(entity).join(placeholders.get(entity) ?? ""), text);
}

export function collectStyleSourceEntities(bindings: StyleBinding[]): string[] {
  return Array.from(new Set(bindings.flatMap((binding) => binding.styleProfile?.styleExemplars?.sourceEntities ?? [])));
}

/**
 * Exemplars come from one profile only: the most specific binding that has enabled exemplars.
 * Mixing passages from several profiles would give the writer two voices to imitate.
 */
export function resolveWriterStyleExemplars(bindingsMostSpecificFirst: StyleBinding[]): RuntimeStyleExemplar[] {
  for (const binding of bindingsMostSpecificFirst) {
    const set = binding.styleProfile?.styleExemplars;
    const enabled = set?.exemplars.filter((exemplar) => exemplar.enabled) ?? [];
    if (!set || enabled.length === 0) {
      continue;
    }
    const selected: RuntimeStyleExemplar[] = [];
    let usedChars = EXEMPLAR_BLOCK_INTRO_CHARS;
    for (const exemplar of enabled) {
      const candidate: RuntimeStyleExemplar = {
        id: exemplar.id,
        sceneFunction: exemplar.sceneFunction,
        text: maskSourceEntities(exemplar.text, set.sourceEntities),
        learn: exemplar.learn,
        doNotCarry: exemplar.doNotCarry,
      };
      const chars = promptChars(candidate);
      if (usedChars + chars > WRITER_STYLE_EXEMPLAR_CHAR_BUDGET) {
        continue;
      }
      usedChars += chars;
      selected.push(candidate);
    }
    return selected;
  }
  return [];
}

/** What one exemplar adds to the writer prompt: the passage as shown, its notes and their framing. */
function promptChars(exemplar: RuntimeStyleExemplar): number {
  return [exemplar.text, exemplar.sceneFunction, ...exemplar.learn, ...exemplar.doNotCarry]
    .reduce((total, part) => total + part.length, EXEMPLAR_FRAME_CHARS);
}

/** Source names that appear in the text. A name inside a longer leaked name is reported once. */
export function findLeakedSourceEntities(content: string, entities: string[]): string[] {
  if (!content.trim()) {
    return [];
  }
  const leaked = Array.from(new Set(entities)).filter((entity) => entity && content.includes(entity));
  return leaked.filter((entity) => !leaked.some((other) => other !== entity && other.includes(entity)));
}

/** Text with punctuation, symbols and spacing removed, the form overlaps are compared in. */
export function contentOnly(text: string): string {
  return text.replace(NON_CONTENT_PATTERN, "");
}

/** Content of an exemplar with name placeholders taken out, and the offsets where one stood. */
function withoutPlaceholders(text: string): { content: string; joints: Set<number> } {
  const joints = new Set<number>();
  let content = "";
  text.split(PLACEHOLDER_PATTERN).forEach((part, index) => {
    if (index > 0) {
      joints.add(content.length);
    }
    content += contentOnly(part);
  });
  return { content, joints };
}

function continuesAcrossName(source: string, joints: Set<number>, head: string, tail: string): boolean {
  for (let position = source.indexOf(head + tail); position !== -1; position = source.indexOf(head + tail, position + 1)) {
    if (joints.has(position + head.length)) {
      return true;
    }
  }
  return false;
}

/**
 * Passages the candidate shares with an exemplar: at least minChars content characters in a row,
 * or in pieces interrupted only where the exemplar shows a name placeholder. The writer sees
 * placeholders and puts the book's own names there, so a copied passage rarely stays in one run.
 * Punctuation and spacing are ignored; pieces are joined with "…" in the result.
 */
export function findStyleExemplarOverlaps(
  content: string,
  exemplars: Array<Pick<RuntimeStyleExemplar, "id" | "text">>,
  minChars: number = STYLE_EXEMPLAR_OVERLAP_MIN_CHARS,
): StyleExemplarOverlap[] {
  const candidate = contentOnly(content);
  const overlaps: StyleExemplarOverlap[] = [];
  for (const exemplar of exemplars) {
    const { content: source, joints } = withoutPlaceholders(exemplar.text);
    const grams = new Set<string>();
    for (let index = 0; index + OVERLAP_SEED_CHARS <= source.length; index += 1) {
      grams.add(source.slice(index, index + OVERLAP_SEED_CHARS));
    }
    let pieces: string[] = [];
    let lastEnd = 0;
    const close = () => {
      const sharedChars = pieces.reduce((total, piece) => total + piece.length, 0);
      if (sharedChars >= minChars) {
        overlaps.push({ exemplarId: exemplar.id, sharedChars, shared: pieces.join("…") });
      }
      pieces = [];
    };
    let index = 0;
    while (index + OVERLAP_SEED_CHARS <= candidate.length) {
      if (!grams.has(candidate.slice(index, index + OVERLAP_SEED_CHARS))) {
        index += 1;
        continue;
      }
      let end = index + OVERLAP_SEED_CHARS;
      while (end < candidate.length && source.includes(candidate.slice(index, end + 1))) {
        end += 1;
      }
      const piece = candidate.slice(index, end);
      const chained = pieces.length > 0
        && index - lastEnd <= MAX_NAME_CHARS
        && continuesAcrossName(source, joints, pieces.join(""), piece);
      if (!chained) {
        close();
      }
      pieces.push(piece);
      index = end;
      lastEnd = end;
    }
    close();
  }
  return overlaps;
}
