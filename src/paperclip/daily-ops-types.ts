import { z } from "zod";

const RoutinePrioritySchema = z.enum(["critical", "high", "medium", "low"]);

export const DailyOpsGoalSpecSchema = z.object({
  key: z.string().min(1),
  level: z.enum(["company", "team", "agent", "task"]),
  parentKey: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().min(1),
  ownerAgentName: z.string().min(1),
});
export type DailyOpsGoalSpec = z.infer<typeof DailyOpsGoalSpecSchema>;

export const DailyOpsSkillSpecSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  tagline: z.string().max(120),
  description: z.string().min(1),
  categories: z.array(z.string().min(1)).readonly(),
  markdown: z.string().min(1),
});
export type DailyOpsSkillSpec = z.infer<typeof DailyOpsSkillSpecSchema>;

export const DailyOpsRoutineSpecSchema = z.object({
  orgCode: z.enum(["FLE", "PEN", "ENT", "AIV", "CLO", "RES"]),
  title: z.string().min(1).max(200),
  cron: z.string().min(1),
  label: z.string().min(1).max(120),
  priority: RoutinePrioritySchema,
  assigneeAgentName: z.string().min(1),
  projectName: z.string().min(1).nullable(),
  goalKey: z.string().min(1),
  description: z.string().min(1),
});
export type DailyOpsRoutineSpec = z.infer<typeof DailyOpsRoutineSpecSchema>;

export const DailyOpsSpecSchema = z.object({
  timezone: z.string().min(1).default("Europe/Bucharest"),
  allowedAdapters: z.array(z.string().min(1)).readonly(),
  companySidebarOrder: z.array(z.enum(["FLE", "PEN", "ENT", "AIV", "CLO", "RES"])).readonly(),
  preferredProjectOrder: z.record(z.string(), z.array(z.string().min(1)).readonly()),
  projectLeadAgentOverrides: z.record(z.string(), z.string().min(1)).optional(),
  goalsByOrg: z.record(z.string(), z.array(DailyOpsGoalSpecSchema).readonly()),
  commonSkills: z.array(DailyOpsSkillSpecSchema).readonly(),
  skillsByOrg: z.record(z.string(), z.array(DailyOpsSkillSpecSchema).readonly()),
  routines: z.array(DailyOpsRoutineSpecSchema).readonly(),
});
export type DailyOpsSpec = z.infer<typeof DailyOpsSpecSchema>;
