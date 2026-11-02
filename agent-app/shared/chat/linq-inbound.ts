import { z } from "zod";

export const linqInboundEnvelopeSchema = z.object({
  webhook_version: z.literal("2026-02-03"),
  event_type: z.literal("message.received"),
  event_id: z.string().min(1).max(200),
  data: z.object({
    id: z.string().min(1).max(200),
    direction: z.literal("inbound"),
    sender_handle: z.object({
      handle: z.string().min(1).max(256),
      is_me: z.literal(false),
    }),
    chat: z.object({
      id: z.string().min(1).max(200),
      is_group: z.literal(false),
      owner_handle: z.object({ handle: z.string(), is_me: z.literal(true) }),
    }),
    reconciled_at: z.string().optional(),
  }),
});

export type LinqInboundEnvelope = z.infer<typeof linqInboundEnvelopeSchema>;
