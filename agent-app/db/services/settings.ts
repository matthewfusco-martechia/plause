import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import { db, settings } from "@db";
import { directOpenAIPolicy, openAIModelIdSchema } from "@shared/models/openai";

const openAIModelKey = "openai_model";

async function readOpenAIModel(scope: AccessScope) {
  const rows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(
      and(
        eq(settings.workspaceId, scope.workspaceId),
        eq(settings.key, openAIModelKey)
      )
    )
    .limit(1);
  return rows[0]?.value;
}

export async function getOpenAIModel(scope: AccessScope) {
  return openAIModelIdSchema.parse(
    (await readOpenAIModel(scope)) ?? directOpenAIPolicy().model
  );
}

export async function selectOpenAIModel(scope: AccessScope, modelId: string) {
  const selected = openAIModelIdSchema.parse(modelId);
  await db
    .insert(settings)
    .values({
      key: openAIModelKey,
      value: selected,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoUpdate({
      target: [settings.workspaceId, settings.key],
      set: { value: selected },
    });
}
