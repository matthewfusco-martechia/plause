import Link from "next/link";
import { readGoogleWorkspaceConnection } from "@db/services/google-workspace";
import { requireRequestScope } from "@web/auth/request-scope";
import { Alert, AlertDescription, AlertTitle } from "@web/components/ui/alert";
import { Button } from "@web/components/ui/button";

export const metadata = { title: "Google Workspace permissions" };

export default async function Page({
  searchParams,
}: PageProps<"/connections/google">) {
  const connection = await readGoogleWorkspaceConnection(
    await requireRequestScope()
  );
  const result = (await searchParams).result;
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
      <div className="space-y-2">
        <h1 className="type-page-title">Connect Google Workspace</h1>
        <p className="type-body text-muted-foreground">
          Choose the Google account Plause may use for your tasks. This connects
          it to your signed-in Plause phone account; it does not merge accounts
          or change how you sign in.
        </p>
      </div>
      {result === "failed" ? (
        <Alert>
          <AlertTitle>Connection was not completed</AlertTitle>
          <AlertDescription>
            No new Google connection was enabled. Review the permissions and
            start again. A cancelled, expired or previously used authorization
            cannot be resumed.
          </AlertDescription>
        </Alert>
      ) : null}
      {connection.state === "connected" ? (
        <Alert>
          <AlertTitle>Google account connected</AlertTitle>
          <AlertDescription>
            {connection.accountLabel ??
              "Your selected Google account is connected."}
          </AlertDescription>
        </Alert>
      ) : null}
      <section
        className="space-y-3"
        aria-labelledby="google-permissions-heading"
      >
        <h2 className="type-section-title" id="google-permissions-heading">
          Permissions you will review at Google
        </h2>
        <ul className="type-supporting-body list-disc space-y-2 pl-5 text-muted-foreground">
          <li>
            Read Gmail messages; Google also grants permission to send mail and
            modify message labels.
          </li>
          <li>
            View and manage Calendar events and read free/busy availability.
          </li>
          <li>Read your Google Contacts.</li>
          <li>
            View and download files across your Google Drive. Plause currently
            supports text reads and Google Docs export, not file changes.
          </li>
          <li>
            Read basic Google identity information to identify the connected
            account.
          </li>
        </ul>
        <p className="type-supporting-body text-muted-foreground">
          Gmail and Calendar write tools remain disabled by default. Enabling
          them also requires a separate approval for each call. A Google grant
          is not permission to perform a particular action. Background tasks may
          use the connected account until you disconnect it.
        </p>
        <p className="type-supporting-body text-muted-foreground">
          Disconnect removes local tokens and fences new tool results first,
          then requests revocation from Google. It cannot recall data already
          returned, erase conversation history or undo earlier changes.
        </p>
      </section>
      {connection.revocationPending ? (
        <Alert>
          <AlertTitle>Google revocation needs reconciliation</AlertTitle>
          <AlertDescription>
            Local access is removed, but the provider revocation outcome is
            unconfirmed. Revoke Plause in your Google account connections and
            ask the deployment operator to reconcile the status before
            reconnecting. Plause will not automatically retry revocation or
            start a new grant.
          </AlertDescription>
        </Alert>
      ) : connection.state === "unavailable" ? (
        <Alert>
          <AlertTitle>Setup required</AlertTitle>
          <AlertDescription>
            The deployment operator must configure a dedicated Google Web OAuth
            client before an account can connect.
          </AlertDescription>
        </Alert>
      ) : connection.state === "connected" ? (
        <Link className="type-supporting-body underline" href="/">
          Manage or disconnect this account in your workspace
        </Link>
      ) : (
        <form
          action="/api/connections/google/start"
          method="post"
          className="space-y-4"
        >
          <label className="type-supporting-body flex items-start gap-3">
            <input
              type="checkbox"
              required
              name="reviewedPermissions"
              value="yes"
              className="mt-1"
            />
            <span>
              I reviewed these permissions and want to connect the Google
              account I choose to this Plause account.
            </span>
          </label>
          <Button type="submit">Continue to Google</Button>
        </form>
      )}
      <Link className="type-supporting-body underline" href="/">
        Back to workspace
      </Link>
    </main>
  );
}
