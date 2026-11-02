import { z } from "zod";
import {
  betterAuthSecretSchema,
  env,
  secretEncryptionKeySchema,
} from "@shared/environment";

const installationSecretsSchema = z.object({
  betterAuthSecret: betterAuthSecretSchema,
  secretEncryptionKey: secretEncryptionKeySchema,
  version: z.literal(1),
});

export type InstallationSecrets = z.infer<typeof installationSecretsSchema>;

export async function getInstallationSecrets(): Promise<InstallationSecrets> {
  if (!env.BETTER_AUTH_SECRET || !env.SECRET_ENCRYPTION_KEY) {
    throw new Error(
      "Set both BETTER_AUTH_SECRET and SECRET_ENCRYPTION_KEY in the deployment secret keyring. Installation keys are never provisioned automatically."
    );
  }
  return installationSecretsSchema.parse({
    betterAuthSecret: env.BETTER_AUTH_SECRET,
    secretEncryptionKey: env.SECRET_ENCRYPTION_KEY,
    version: 1,
  });
}
