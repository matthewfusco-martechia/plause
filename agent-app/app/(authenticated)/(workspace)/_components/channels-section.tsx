import { MailIcon, MessageSquareIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@web/components/ui/button";
import { WorkspaceSection } from "./workspace-section";

export function ChannelsSection({
  browserReady,
  linqConfigured,
  linqPhoneNumber,
}: {
  readonly browserReady: boolean;
  readonly linqConfigured: boolean;
  readonly linqPhoneNumber?: string;
}) {
  return (
    <WorkspaceSection headingId="channels-heading" title="Channels">
      <div className="grid gap-2 sm:grid-cols-2">
        {browserReady ? (
          <Button
            nativeButton={false}
            render={<Link href="/chat" />}
            variant="surface"
          >
            <MessageSquareIcon />
            WebChat
          </Button>
        ) : (
          <Button disabled variant="surface">
            <MessageSquareIcon />
            WebChat
          </Button>
        )}
        {linqConfigured && linqPhoneNumber ? (
          <Button
            nativeButton={false}
            render={
              <a aria-label="Open iMessage" href={`sms:${linqPhoneNumber}`} />
            }
            variant="surface"
          >
            <MailIcon />
            iMessage
          </Button>
        ) : (
          <Button disabled variant="surface">
            <MailIcon />
            iMessage
          </Button>
        )}
      </div>
      <p className="type-caption text-muted-foreground">
        {channelAvailabilityMessage({
          browserReady,
          linqConfigured,
          linqPhoneNumber,
        })}
      </p>
    </WorkspaceSection>
  );
}

function channelAvailabilityMessage({
  browserReady,
  linqConfigured,
  linqPhoneNumber,
}: {
  readonly browserReady: boolean;
  readonly linqConfigured: boolean;
  readonly linqPhoneNumber?: string;
}) {
  return [
    browserReady
      ? "Open WebChat to view your conversations."
      : "KERNEL_API_KEY is required to enable WebChat.",
    linqConfigured && linqPhoneNumber
      ? `iMessage opens ${linqPhoneNumber}.`
      : linqConfigured
        ? "Linq is configured. Use its assigned line to start an iMessage."
        : "Set up Linq to enable iMessage.",
  ].join(" ");
}
