import { LinqAPIV3 } from "@linqapp/sdk";
import { env } from "@shared/environment";
import type { AccessScope } from "@shared/identity/access-scope";
import { assertEnrolledWorkspaceUser } from "@db/services/auth/phone-user";

export const LINQ_API_BASE_URL = "https://api.linqapp.com/api/partner";

export const linqCredentials = {
  apiKey() {
    if (!env.LINQ_API_KEY || !env.LINQ_PHONE_NUMBER) {
      throw new Error(
        "Direct Linq credentials and phone number are not configured."
      );
    }
    return env.LINQ_API_KEY;
  },
};

export async function sendNativeLinqMessage(
  chatId: string,
  message: Parameters<LinqAPIV3["chats"]["messages"]["send"]>[1]["message"],
  options: Parameters<LinqAPIV3["chats"]["messages"]["send"]>[2] | undefined,
  scope: AccessScope
) {
  const apiKey = linqCredentials.apiKey();
  await assertEnrolledWorkspaceUser(scope);
  const client = new LinqAPIV3({
    apiKey,
    baseURL: LINQ_API_BASE_URL,
    maxRetries: 0,
    timeout: 10_000,
    fetchOptions: { redirect: "error" },
    logLevel: "off",
    async fetch(input, init) {
      // The SDK may await request preparation; recheck at its actual HTTP boundary.
      await assertEnrolledWorkspaceUser(scope);
      return globalThis.fetch(input, init);
    },
  });
  return client.chats.messages.send(
    chatId,
    { message },
    {
      ...options,
      maxRetries: 0,
    }
  );
}
