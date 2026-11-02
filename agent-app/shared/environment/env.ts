import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";
import { isE164PhoneNumber } from "@shared/identity/phone-number";
import { databaseUrlSchema } from "@shared/environment/database-url";

export const betterAuthSecretSchema = z
  .string()
  .refine(
    (value) => value.trim().length >= 32,
    "BETTER_AUTH_SECRET must contain at least 32 characters."
  );

export const secretEncryptionKeySchema = z
  .string()
  .refine(
    (value) => Buffer.from(value, "base64").length === 32,
    "SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key."
  );

const developmentInstallation =
  process.env.NODE_ENV === "development" &&
  process.env.VERCEL_ENV === undefined;
const localDevelopment =
  developmentInstallation &&
  isLoopbackDevelopmentOrigin(process.env.BETTER_AUTH_URL);
const explicitBetterAuthSecret = hasValue(process.env.BETTER_AUTH_SECRET);
const explicitSecretEncryptionKey = hasValue(process.env.SECRET_ENCRYPTION_KEY);

if (
  developmentInstallation &&
  explicitBetterAuthSecret !== explicitSecretEncryptionKey
) {
  throw new Error(
    "Set both BETTER_AUTH_SECRET and SECRET_ENCRYPTION_KEY, or leave both unset for local defaults."
  );
}

const useLocalInstallationDefaults =
  localDevelopment && !explicitBetterAuthSecret && !explicitSecretEncryptionKey;

const requiredValue = z
  .string()
  .refine((value) => value.trim().length > 0, "Required");

const betterAuthUrlSchema = requiredValue.refine(
  (value) => URL.canParse(value),
  "BETTER_AUTH_URL must be an absolute URL"
);

function optionalValueWithLocalDefault<T extends z.ZodType<string, string>>(
  schema: T,
  localDefault: z.util.NoUndefined<z.output<T>>
) {
  return localDevelopment ? schema.default(localDefault) : schema.optional();
}

function installationSecretWithLocalDefault<
  T extends z.ZodType<string, string>,
>(schema: T, localDefault: z.util.NoUndefined<z.output<T>>) {
  return useLocalInstallationDefaults
    ? schema.default(localDefault)
    : schema.optional();
}

export const env = createEnv({
  server: {
    // Required
    DATABASE_URL: databaseUrlSchema,
    KERNEL_API_KEY: requiredValue,

    // Explicit installation secrets are required on hosted installations.
    // Loopback development alone can use the stable local defaults.
    BETTER_AUTH_SECRET: installationSecretWithLocalDefault(
      betterAuthSecretSchema,
      "openinstinct-local-auth-development-secret"
    ),
    BETTER_AUTH_URL: optionalValueWithLocalDefault(
      betterAuthUrlSchema,
      "http://localhost:3000"
    ),
    SECRET_ENCRYPTION_KEY: installationSecretWithLocalDefault(
      secretEncryptionKeySchema,
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    ),

    // Direct providers remain disabled until explicitly configured.
    R2_ACCOUNT_ID: z
      .string()
      .regex(/^[a-f0-9]{32}$/u)
      .optional(),
    R2_ACCESS_KEY_ID: requiredValue.optional(),
    R2_SECRET_ACCESS_KEY: requiredValue.optional(),
    R2_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u)
      .optional(),
    OPENAI_API_KEY: requiredValue.optional(),
    OPENAI_MODEL: z.literal("gpt-6-luna").default("gpt-6-luna"),
    OPENAI_BROWSER_MODEL: z.literal("gpt-6-luna").default("gpt-6-luna"),
    LIVE_MODEL_ENABLED: z.enum(["false", "true"]).default("false"),
    WEB_RESEARCH_ENABLED: z.enum(["false", "true"]).default("false"),
    TAVILY_API_KEY: requiredValue.optional(),
    MODEL_MAX_INPUT_TOKENS: z.coerce
      .number()
      .int()
      .min(256)
      .max(20_000)
      .default(20_000),
    MODEL_MAX_OUTPUT_TOKENS: z.coerce
      .number()
      .int()
      .min(16)
      .max(2_000)
      .default(2_000),
    MODEL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(45_000)
      .default(20_000),
    MODEL_USER_MONTHLY_BUDGET_MICRO_USD: z.coerce
      .number()
      .int()
      .min(1)
      .max(100_000_000)
      .default(30_000),
    MODEL_GLOBAL_MONTHLY_BUDGET_MICRO_USD: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000_000_000)
      .default(30_000),
    PRIVATE_ALLOWED_PHONE_NUMBERS: z
      .string()
      .default("")
      .refine(
        (value) =>
          value === "" ||
          value.split(",").every((phone) => isE164PhoneNumber(phone.trim())),
        "PRIVATE_ALLOWED_PHONE_NUMBERS must contain comma-separated E.164 phone numbers."
      ),
    LINQ_API_KEY: requiredValue.optional(),
    LINQ_WEBHOOK_SIGNING_SECRET: requiredValue.optional(),
    INTERNAL_SERVICE_SECRET: z.string().min(32).optional(),
    GOOGLE_CLIENT_ID: requiredValue.optional(),
    GOOGLE_CLIENT_SECRET: requiredValue.optional(),

    BROWSER_ACTIONS_ENABLED: z.enum(["false", "true"]).default("false"),
    GOOGLE_WORKSPACE_WRITES_ENABLED: z.enum(["false", "true"]).default("false"),
    LINK_CLIENT_ID: requiredValue.optional(),
    LINK_CLIENT_SECRET: requiredValue.optional(),
    STRIPE_PUBLISHABLE_KEY: requiredValue.optional(),
    LINQ_PHONE_NUMBER: requiredValue
      .refine(
        (value) => isE164PhoneNumber(value),
        "LINQ_PHONE_NUMBER must use E.164 format"
      )
      .optional(),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("production"),
    VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
  },
  experimental__runtimeEnv: {},
  emptyStringAsUndefined: true,
});

const authHostname = env.BETTER_AUTH_URL
  ? new URL(env.BETTER_AUTH_URL).hostname
  : undefined;

export const localPhoneAuthBypassEnabled =
  localDevelopment &&
  (authHostname === "localhost" ||
    authHostname?.endsWith(".localhost") === true ||
    authHostname === "127.0.0.1" ||
    authHostname === "[::1]");

function hasValue(value: string | undefined) {
  return value !== undefined && value.trim().length > 0;
}

function isLoopbackDevelopmentOrigin(value: string | undefined) {
  if (!value?.trim()) return true;
  const url = URL.parse(value);
  return (
    url !== null &&
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    (url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]")
  );
}
