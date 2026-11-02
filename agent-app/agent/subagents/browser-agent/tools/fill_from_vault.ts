import { defineTool } from "eve/tools";
import { z } from "zod";
import { requireOwnedBrowserSession } from "@agent/subagents/browser-agent/lib/owned-browser";
import { requireWorkerScope } from "@agent/subagents/browser-agent/lib/access";
import { readVaultItem } from "@db/services/vault";
import { kernel } from "@agent/subagents/browser-agent/lib/kernel";
import {
  currentKernelPageOrigin,
  fillWithKernelNativeAutofill,
  nativeAutofillTokens,
} from "../lib/autofill/native";
import { vaultAutofillProvider } from "../lib/autofill/provider";
import { materializeAutofillClaims } from "../lib/autofill/service";
import {
  assertBrowserActionsEnabled,
  browserActionApproval,
  browserActionContextSchema,
  claimBrowserAction,
  dispatchBrowserAction,
} from "../lib/action-authority";

const inputSchema = z.object({
  actionContext: browserActionContextSchema,
  browserSessionId: z.string().trim().min(1).max(500),
  candidateId: z.string().trim().min(1).max(500),
});

const outputSchema = z.object({
  filledClaims: z.number().int().nonnegative(),
  kind: z.enum(["address", "contact", "login", "payment"]),
  origin: z.string(),
  success: z.literal(true),
});

export default defineTool({
  approval: browserActionApproval(),
  description:
    "Fill a login, card, contact, traveler, or address form with an opaque handle returned by list_vault. Requires enabled browser actions, a fresh actionContext from inspect_browser_action, and approval of this exact fill. Focus one control in the intended form first. Never supply vault fields, selectors, or secret values.",
  inputSchema,
  outputSchema,
  async execute(input, context) {
    assertBrowserActionsEnabled(context);
    const scope = await requireWorkerScope(context);

    await requireOwnedBrowserSession(scope, input.browserSessionId);
    const permit = await claimBrowserAction(
      scope,
      input.browserSessionId,
      input.actionContext,
      context
    );
    const item = await readVaultItem(scope, input.candidateId);
    if (!item) throw new Error("The selected vault item was not found.");
    if (
      item.kind !== "address" &&
      item.kind !== "contact" &&
      item.kind !== "login" &&
      item.kind !== "payment"
    ) {
      throw new Error(
        "Native browser autofill currently supports only logins, cards, contacts, and addresses."
      );
    }
    const kind = item.kind;
    if (kind === "login") {
      const browser = await kernel.browsers.retrieve(
        input.browserSessionId,
        {},
        { signal: context.abortSignal }
      );
      if (!browser.profile_save_changes) {
        throw new Error(
          "Login autofill requires a browser created with save_changes: true. Delete this browser, create a writable browser at the same URL, then focus and fill again."
        );
      }
    }

    const origin = await currentKernelPageOrigin({
      browserSessionId: input.browserSessionId,
      signal: context.abortSignal,
    });
    if (origin !== permit.origin)
      throw new Error("The browser origin changed before autofill.");
    const surfaceKind =
      item.kind === "payment"
        ? "payment-card"
        : item.kind === "login"
          ? "credentials"
          : item.kind === "contact"
            ? "contact"
            : "postal-address";
    const tokens = nativeAutofillTokens[item.kind];
    const surface = {
      fields: tokens.map((token) => ({ score: 100, token })),
      id: surfaceKind,
      kind: surfaceKind,
    };

    const claims = await materializeAutofillClaims(
      scope,
      input.candidateId,
      {
        availableTokens: new Set(tokens),
        origin,
        surface,
      },
      vaultAutofillProvider
    );
    const result = await dispatchBrowserAction(
      scope,
      {
        browserSessionId: input.browserSessionId,
        observationId: input.actionContext.observationId,
        arguments: input,
      },
      context,
      async () => {
        await permit.assertCurrent();
        return fillWithKernelNativeAutofill({
          browserSessionId: input.browserSessionId,
          claims,
          expectedOrigin: origin,
          kind,
          signal: permit.signal,
        });
      }
    );

    return {
      filledClaims: result.filledClaims,
      kind: item.kind,
      origin: result.origin,
      success: true as const,
    };
  },
});
