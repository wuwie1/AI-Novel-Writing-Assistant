import { z } from "zod";

/** A profile keeps a short reading list, not a corpus. */
export const STYLE_EXEMPLAR_MAX_COUNT = 12;
export const STYLE_EXEMPLAR_MIN_TEXT_LENGTH = 80;
export const STYLE_EXEMPLAR_MAX_TEXT_LENGTH = 1200;
/** A scene function or a learn / do-not-carry note is one short sentence. */
export const STYLE_EXEMPLAR_NOTE_MAX_LENGTH = 80;
export const STYLE_EXEMPLAR_NOTE_MAX_COUNT = 4;
/**
 * Characters the whole exemplar block may add to a chapter prompt: instructions, passages and
 * their notes. About a quarter of the writer's context budget; the block is required, so
 * anything above this would push optional chapter context out.
 */
export const WRITER_STYLE_EXEMPLAR_CHAR_BUDGET = 4200;
/** Shared run of content characters that counts as reusing an exemplar. */
export const STYLE_EXEMPLAR_OVERLAP_MIN_CHARS = 14;

const exemplarNoteSchema = z.string().trim().min(1).max(STYLE_EXEMPLAR_NOTE_MAX_LENGTH);
const exemplarNoteListSchema = z.array(exemplarNoteSchema).max(STYLE_EXEMPLAR_NOTE_MAX_COUNT).default([]);

export const styleExemplarSchema = z.object({
  id: z.string().trim().min(1).max(40),
  sceneFunction: exemplarNoteSchema,
  text: z.string().trim().min(STYLE_EXEMPLAR_MIN_TEXT_LENGTH).max(STYLE_EXEMPLAR_MAX_TEXT_LENGTH),
  learn: exemplarNoteListSchema,
  doNotCarry: exemplarNoteListSchema,
  sourceRef: z.string().trim().max(300).nullable().optional(),
  enabled: z.boolean().default(true),
});

export const styleExemplarSetSchema = z.object({
  exemplars: z.array(styleExemplarSchema).max(STYLE_EXEMPLAR_MAX_COUNT).default([]),
  /** Names from the source work. They are masked for the writer and must not appear in new prose. */
  sourceEntities: z.array(z.string().trim().min(2).max(12)).max(60).default([]),
}).superRefine((value, context) => {
  const ids = value.exemplars.map((exemplar) => exemplar.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "文笔样例编号不能重复。", path: ["exemplars"] });
  }
});

export type StyleExemplar = z.infer<typeof styleExemplarSchema>;
export type StyleExemplarSet = z.infer<typeof styleExemplarSetSchema>;

export const EMPTY_STYLE_EXEMPLAR_SET: StyleExemplarSet = { exemplars: [], sourceEntities: [] };

/** What the chapter writer receives: source names already masked, bookkeeping fields removed. */
export const runtimeStyleExemplarSchema = z.object({
  id: z.string(),
  sceneFunction: z.string(),
  text: z.string(),
  learn: z.array(z.string()).default([]),
  doNotCarry: z.array(z.string()).default([]),
});

export type RuntimeStyleExemplar = z.infer<typeof runtimeStyleExemplarSchema>;

/** Stored values may predate a limit change; anything invalid reads as no exemplars. */
export function parseStyleExemplarSet(value: unknown): StyleExemplarSet {
  const parsed = styleExemplarSetSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : EMPTY_STYLE_EXEMPLAR_SET;
}
