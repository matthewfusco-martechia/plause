import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const applicationEnvironment = [
  "BETTER_AUTH_*",
  "BROWSER_ACTIONS_ENABLED",
  "DATABASE_URL",
  "GOOGLE_CLIENT_*",
  "GOOGLE_WORKSPACE_WRITES_ENABLED",
  "INTERNAL_SERVICE_SECRET",
  "INKBOX_*",
  "KERNEL_*",
  "LINQ_*",
  "LINK_*",
  "MESSAGING_PROVIDER",
  "LIVE_MODEL_ENABLED",
  "SCHEDULED_TASKS_ENABLED",
  "WEB_RESEARCH_ENABLED",
  "TAVILY_*",
  "MODEL_*",
  "OPENAI_*",
  "R2_*",
  "PRIVATE_ALLOWED_PHONE_NUMBERS",
  "PLAUSE_WORKFLOW_BACKEND",
  "WORKFLOW_*",
  "PLAUSE_EDGE_INTERNAL_TOKEN",
  "STRIPE_PUBLISHABLE_KEY",
  "NODE_ENV",
  "SECRET_ENCRYPTION_KEY",
  "VERCEL_ENV",
  "EVE_TELEMETRY_DISABLED",
  "NEXT_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
];
const runtimeEnvironment = applicationEnvironment;

describe("Turbo configuration", () => {
  it("scopes application environment variables to their owning tasks", async () => {
    const turbo = z
      .object({
        tasks: z.object({
          "build:app": z.object({ env: z.array(z.string()) }),
          "dev:app": z.object({ passThroughEnv: z.array(z.string()) }),
          "start:app": z.object({ passThroughEnv: z.array(z.string()) }),
        }),
      })
      .loose()
      .parse(
        JSON.parse(
          await readFile(new URL("../turbo.json", import.meta.url), "utf8")
        )
      );

    expect(turbo).not.toHaveProperty("globalEnv");
    expect(turbo.tasks["build:app"].env).toEqual(
      expect.arrayContaining([...applicationEnvironment, "EVE_NEXT_*"])
    );
    expect(turbo.tasks["build:app"].env).toHaveLength(
      applicationEnvironment.length + 1
    );
    expect(turbo.tasks["dev:app"].passThroughEnv).toEqual(runtimeEnvironment);
    expect(turbo.tasks["start:app"].passThroughEnv).toEqual(runtimeEnvironment);
  });

  it("documents direct providers without a Vercel deployment action", async () => {
    const readme = await readFile(
      new URL("../README.md", import.meta.url),
      "utf8"
    );
    expect(readme).toContain("Cloudflare R2");
    expect(readme).toContain("OpenAI");
    expect(readme).toContain("Linq");
    expect(readme).not.toContain("vercel.com/new/clone");
  });
});
