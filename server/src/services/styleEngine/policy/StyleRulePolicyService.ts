import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../../../db/prisma";

export const styleRulePolicySchema = z.object({
  rules: z.array(z.object({
    ruleId: z.string().trim().min(1),
    mode: z.enum(["inherit", "enabled", "disabled"]),
  })).max(200),
}).refine(input => new Set(input.rules.map(rule => rule.ruleId)).size === input.rules.length,
  "同一规则只能指定一次选择。");

/** Explicit author/AI configuration, not keyword-based semantic conflict resolution. */
export class StyleRulePolicyService {
  constructor(private readonly db: PrismaClient = prisma) {}

  async read(styleProfileId: string) {
    const profile = await this.db.styleProfile.findUnique({where: {id: styleProfileId}, select: {id: true}});
    if (!profile) throw new Error("写法资产不存在。");
    const rows = await this.db.styleProfileAntiAiRule.findMany({where: {styleProfileId},
      include: {antiAiRule: {select: {name: true}}}, orderBy: {antiAiRuleId: "asc"}});
    return {styleProfileId, rules: rows.map(row => ({ruleId: row.antiAiRuleId,
      name: row.antiAiRule.name, mode: row.enabled ? "enabled" as const : "disabled" as const}))};
  }

  async update(styleProfileId: string, input: z.infer<typeof styleRulePolicySchema>) {
    const parsed = styleRulePolicySchema.parse(input);
    await this.db.$transaction(async tx => {
      if (!await tx.styleProfile.findUnique({where: {id: styleProfileId}, select: {id: true}})) throw new Error("写法资产不存在。");
      const ids = parsed.rules.map(rule => rule.ruleId);
      const found = await tx.antiAiRule.count({where: {id: {in: ids}}});
      if (found !== ids.length) throw new Error("存在无法识别的反 AI 规则，请刷新后重试。");
      for (const choice of parsed.rules) {
        if (choice.mode === "inherit") {
          await tx.styleProfileAntiAiRule.deleteMany({where: {styleProfileId, antiAiRuleId: choice.ruleId}});
        } else {
          await tx.styleProfileAntiAiRule.upsert({where: {styleProfileId_antiAiRuleId: {styleProfileId, antiAiRuleId: choice.ruleId}},
            create: {styleProfileId, antiAiRuleId: choice.ruleId, enabled: choice.mode === "enabled"},
            update: {enabled: choice.mode === "enabled"}});
        }
      }
      await tx.styleProfile.update({where: {id: styleProfileId}, data: {updatedAt: new Date()}});
    });
    return this.read(styleProfileId);
  }
}
export const styleRulePolicyService = new StyleRulePolicyService();
