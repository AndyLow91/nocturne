import type { Chat } from "chat";
import { AcknowledgedCard, ActiveAlertsCard } from "../cards/alert.js";
import { createLogger } from "../lib/logger.js";
import { getApi } from "../lib/request-context.js";
import { requireLink, requireLinkForAction } from "../lib/require-link.js";
import { decodeActionValue } from "../lib/action-value.js";
import type { AcknowledgementOutcome } from "../types.js";

const logger = createLogger();

const failed = (action: string) => `Failed to ${action}. Please try again.`;

/**
 * What the thread is told about an acknowledgement. A mute is named as one:
 * the tapping user stopped the alert only for themselves, so nobody reading
 * the thread may take it as handled.
 */
function confirmation(
  outcome: AcknowledgementOutcome,
  acknowledgedBy: string,
  wholeTenant: boolean,
): { title: string; detail: string } {
  switch (outcome) {
    case "acknowledged":
      return {
        title: "Alert acknowledged",
        detail: wholeTenant
          ? `All alerts acknowledged for everyone by ${acknowledgedBy}.`
          : `Acknowledged for everyone by ${acknowledgedBy}. Any other active alerts are untouched.`,
      };
    case "muted":
      return {
        title: wholeTenant ? "Alerts muted for you" : "Alert muted for you",
        detail: `Muted for ${acknowledgedBy} only. Everyone else is still alerted, because acknowledging for everyone needs permission to manage alerts.`,
      };
    case "closed":
      return {
        title: "Nothing to acknowledge",
        detail: wholeTenant
          ? "There are no active alerts."
          : "This alert has already ended.",
      };
  }
}

export function registerAlertCommands(bot: Chat) {
  bot.onAction("ack_alert", async (event) => {
    await requireLinkForAction(event, async (link) => {
      const { excursionId, unreadableExcursion } = decodeActionValue(event.value);
      if (unreadableExcursion) {
        await event.thread?.post(
          "Couldn't tell which alert this button is for. Nothing was acknowledged.",
        );
        return;
      }

      const acknowledgedBy = event.user.fullName ?? "Unknown";
      let outcome: AcknowledgementOutcome;

      try {
        // A value that names no excursion at all addresses the whole tenant.
        outcome = await getApi().alerts.acknowledgeAsLinkedMember(link.id, {
          platform: event.adapter.name,
          platformUserId: event.user.userId,
          excursionId,
          acknowledgedBy,
        });
      } catch (err) {
        logger.error("Error acknowledging alert:", err);
        await event.thread?.post(failed("acknowledge"));
        return;
      }

      // The acknowledge has landed, so a confirmation that cannot be posted is
      // not a failure to report back as one.
      try {
        await event.thread?.post(
          AcknowledgedCard(confirmation(outcome, acknowledgedBy, !excursionId)),
        );
      } catch (err) {
        logger.error("Acknowledged, but could not confirm in the thread:", err);
      }
    });
  });

  bot.onSlashCommand("/alerts", async (event) => {
    await requireLink(event, async (link) => {
      try {
        const excursions = (await getApi().alerts.getActiveAlerts()) ?? [];

        if (!excursions.length) {
          await event.channel.post(`No active alerts for ${link.displayName}.`);
          return;
        }

        await event.channel.post(ActiveAlertsCard({ excursions }));
      } catch (err) {
        logger.error("Error handling /alerts command:", err);
        await event.channel.post(failed("fetch alerts"));
      }
    });
  });
}
