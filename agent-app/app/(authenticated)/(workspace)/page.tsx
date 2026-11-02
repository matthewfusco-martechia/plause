import {
  BotIcon,
  CloudIcon,
  ImageIcon,
  MailIcon,
  WalletIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@web/components/ui/alert";
import { Badge } from "@web/components/ui/badge";
import { Button } from "@web/components/ui/button";
import { getOpenAIModel } from "@db/services/settings";
import { linkConfigured } from "@db/services/auth/link";
import { env } from "@shared/environment";
import { readGoogleWorkspaceConnection } from "@db/services/google-workspace";
import { isR2StorageConfigured } from "@shared/storage/r2";
import { requireRequestScope } from "@web/auth/request-scope";
import { GoogleWorkspaceAction } from "./_components/google-workspace-action";
import { ModelSelector } from "./_components/model-selector";
import { ChannelsSection } from "./_components/channels-section";
import { WorkspaceSection } from "./_components/workspace-section";

export default async function Page({ searchParams }: PageProps<"/">) {
  const google = (await searchParams).google;
  const scope = await requireRequestScope();
  const [googleWorkspace, openAIModel] = await Promise.all([
    readGoogleWorkspaceConnection(scope),
    getOpenAIModel(scope),
  ]);
  const browserReady = true;
  const imageStorageReady = isR2StorageConfigured();

  return (
    <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-8 px-4 py-6 sm:px-6 sm:py-8">
      <h1 className="sr-only">Workspace</h1>

      {google === "unavailable" ? (
        <Alert>
          <MailIcon />
          <AlertTitle>Google Workspace unavailable</AlertTitle>
          <AlertDescription>
            This deployment does not have a configured direct Google OAuth
            client yet.
          </AlertDescription>
        </Alert>
      ) : null}

      {env.LIVE_MODEL_ENABLED !== "true" || !env.OPENAI_API_KEY ? (
        <Alert>
          <BotIcon />
          <AlertTitle>Model replies are disabled</AlertTitle>
          <AlertDescription>
            Connections and account controls remain available. Your
            administrator must enable model access before Plause can respond.
          </AlertDescription>
        </Alert>
      ) : null}

      <ChannelsSection
        browserReady={browserReady}
        linqConfigured={Boolean(
          env.LINQ_API_KEY &&
          env.LINQ_PHONE_NUMBER &&
          env.LINQ_WEBHOOK_SIGNING_SECRET
        )}
        linqPhoneNumber={env.LINQ_PHONE_NUMBER}
      />
      <ConnectionsSection
        connection={googleWorkspace}
        linkEnabled={linkConfigured()}
      />

      <WorkspaceSection headingId="connectors-heading" title="Infrastructure">
        <div className="divide-y divide-border/50 border-y border-border/50">
          <ConnectorRow
            action={<Badge variant="success">Configured</Badge>}
            description={
              env.BROWSER_ACTIONS_ENABLED === "true"
                ? "Browser actions require your approval."
                : "Browser actions are disabled. Saved browser sessions remain available."
            }
            icon={<CloudIcon />}
            label="Kernel browser"
          />
          <ConnectorRow
            action={
              <Badge variant={imageStorageReady ? "success" : "secondary"}>
                {imageStorageReady ? "Configured" : "Setup required"}
              </Badge>
            }
            description={
              imageStorageReady
                ? "Store browser images and durable profile memory in private Cloudflare R2."
                : "Configure a dedicated private Cloudflare R2 bucket for images and memory."
            }
            icon={<ImageIcon />}
            label="Cloudflare R2"
          />
          <ConnectorRow
            action={<ModelSelector modelId={openAIModel} />}
            description={openAIModel}
            icon={<BotIcon />}
            label="OpenAI model"
          />
        </div>
      </WorkspaceSection>
    </div>
  );
}

function ConnectionsSection({
  connection,
  linkEnabled,
}: {
  readonly connection?: GoogleWorkspaceConnection;
  readonly linkEnabled: boolean;
}) {
  const state = connection?.state;
  const description =
    state === "connected"
      ? (connection?.accountLabel ??
        "Gmail, Calendar, Contacts and Drive connected.")
      : state === "unavailable"
        ? "Configure a direct Google Web OAuth client to enable this."
        : "Gmail, Calendar, Contacts and read-only Drive through your Google account.";

  return (
    <WorkspaceSection headingId="connections-heading" title="Connections">
      <div className="divide-y divide-border/50 border-y border-border/50">
        <ConnectorRow
          action={
            <GoogleWorkspaceAction
              state={state}
              revocationPending={connection?.revocationPending}
            />
          }
          description={description}
          icon={<MailIcon />}
          label="Google Workspace"
        />
        {linkEnabled ? (
          <ConnectorRow
            action={
              <Button
                nativeButton={false}
                render={<Link href="/link" />}
                variant="outline"
                aria-label="Open Link wallet"
              >
                Open
              </Button>
            }
            description="Manage your wallet connection. Link purchases are unavailable."
            icon={<WalletIcon />}
            label="Link wallet"
          />
        ) : null}
      </div>
    </WorkspaceSection>
  );
}

type GoogleWorkspaceConnection = Awaited<
  ReturnType<typeof readGoogleWorkspaceConnection>
>;

function ConnectorRow({
  action,
  description,
  icon,
  label,
}: {
  readonly action: ReactNode;
  readonly description: string;
  readonly icon: ReactNode;
  readonly label: string;
}) {
  return (
    <div className="flex items-center gap-3 py-4">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-muted-foreground">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="type-label">{label}</p>
        <p className="truncate type-caption text-muted-foreground">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}
