import { auth } from "@googleapis/gmail";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { scopeFromPrincipal } from "@agent/lib/principal-scope";
import { assertEnrolledWorkspaceUser } from "@db/services/auth/phone-user";
import {
  GoogleActionApprovalError,
  GoogleActionUnknownError,
} from "@db/services/google-actions";
import {
  assertGoogleWorkspaceVersion,
  getGoogleWorkspaceAccessToken,
  GoogleWorkspaceConnectionRequiredError,
  invalidateGoogleWorkspaceConnection,
} from "@db/services/google-workspace";

export async function withGoogleAuth<T>(
  ctx: ToolContext,
  execute: (authClient: InstanceType<typeof auth.OAuth2>) => Promise<T>,
  expectedGrantVersion?: number
) {
  const caller = ctx.session.auth.current;
  if (caller?.principalType !== "user")
    throw new GoogleWorkspaceConnectionRequiredError();
  const scope = scopeFromPrincipal(caller);
  await assertEnrolledWorkspaceUser(scope);
  const { token, version } = await getGoogleWorkspaceAccessToken(
    scope,
    ctx.abortSignal
  );
  ctx.abortSignal.throwIfAborted();
  if (expectedGrantVersion !== undefined && version !== expectedGrantVersion)
    throw new GoogleActionApprovalError();
  await assertGoogleWorkspaceVersion(scope, version);
  await assertEnrolledWorkspaceUser(scope);
  const authClient = new auth.OAuth2({
    transporterOptions: {
      retry: false,
      retryConfig: { retry: 0 },
      redirect: "manual",
      timeout: 15_000,
      maxContentLength: 1024 * 1024,
    },
  });
  authClient.setCredentials({ access_token: token });

  try {
    const result = await execute(authClient);
    ctx.abortSignal.throwIfAborted();
    await assertGoogleWorkspaceVersion(scope, version);
    await assertEnrolledWorkspaceUser(scope);
    return result;
  } catch (error) {
    ctx.abortSignal.throwIfAborted();
    if (googleApiErrorStatus(error) === 401) {
      await invalidateGoogleWorkspaceConnection(scope, version);
      throw new GoogleWorkspaceConnectionRequiredError();
    }
    if (error instanceof GoogleWorkspaceConnectionRequiredError) throw error;
    if (
      error instanceof GoogleActionApprovalError ||
      error instanceof GoogleActionUnknownError
    )
      throw error;
    // oxlint-disable-next-line eslint/preserve-caught-error -- Provider errors can include tokens and signed request configuration.
    throw new Error(
      "Google Workspace operation failed. Review the connected account before retrying."
    );
  }
}

const googleApiErrorSchema = z.object({
  response: z.object({ status: z.number() }),
});

function googleApiErrorStatus(cause: unknown) {
  const result = googleApiErrorSchema.safeParse(cause);
  return result.success ? result.data.response.status : undefined;
}
