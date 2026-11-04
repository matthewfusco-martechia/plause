// This command reports configuration presence only. It never probes a provider,
// prints a credential, creates a resource, or enables model inference.
const groups = [
  [
    "Application",
    [
      "DATABASE_URL",
      "BETTER_AUTH_URL",
      "BETTER_AUTH_SECRET",
      "SECRET_ENCRYPTION_KEY",
      "INTERNAL_SERVICE_SECRET",
      "PRIVATE_ALLOWED_PHONE_NUMBERS",
    ],
  ],
  [
    "Private Cloudflare R2",
    ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"],
  ],
  ["Direct OpenAI", ["OPENAI_API_KEY"]],
  ["Google Workspace", ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]],
  ["Kernel browser", ["KERNEL_API_KEY"]],
] as const;

let missing = false;
for (const [label, keys] of groups) {
  // oxlint-disable-next-line eslint/no-restricted-properties -- standalone operator command reads a fixed list and emits names, never values.
  const absent = keys.filter((key) => !process.env[key]?.trim());
  console.log(
    `${label}: ${absent.length ? `missing ${absent.join(", ")}` : "configured (unverified)"}`
  );
  missing ||= absent.length > 0;
}
// oxlint-disable-next-line eslint/no-restricted-properties -- Fixed non-secret provider selector; malformed values are never echoed.
const provider = process.env.MESSAGING_PROVIDER ?? "disabled";
const messagingKeys =
  provider === "inkbox"
    ? [
        "INKBOX_API_KEY",
        "INKBOX_IDENTITY_ID",
        "INKBOX_AGENT_HANDLE",
        "INKBOX_WEBHOOK_SIGNING_KEY",
      ]
    : provider === "linq"
      ? ["LINQ_API_KEY", "LINQ_PHONE_NUMBER", "LINQ_WEBHOOK_SIGNING_SECRET"]
      : null;
if (messagingKeys) {
  // oxlint-disable-next-line eslint/no-restricted-properties -- Report only missing fixed key names, never credential values.
  const absent = messagingKeys.filter((key) => !process.env[key]?.trim());
  console.log(
    `Messaging (${provider}): ${absent.length ? `missing ${absent.join(", ")}` : "configured (unverified)"}`
  );
  missing ||= absent.length > 0;
} else {
  console.log(
    provider === "disabled"
      ? "Messaging: disabled; hosted phone sign-in and iMessage are unavailable"
      : "Messaging: invalid MESSAGING_PROVIDER; choose disabled, inkbox or linq"
  );
  missing = true;
}
// oxlint-disable-next-line eslint/no-restricted-properties -- standalone operator command reports only the explicit live-call switch.
const inferenceEnabled = process.env.LIVE_MODEL_ENABLED === "true";
console.log(
  `Live model calls: ${inferenceEnabled ? "enabled; configured budgets apply" : "disabled"}`
);
console.log(
  "No connections tested. Run the mock checks before any reviewed live acceptance."
);
process.exitCode = missing ? 1 : 0;
