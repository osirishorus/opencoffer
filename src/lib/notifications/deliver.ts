import { and, eq, gte, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { alerts, notificationChannels } from "@/lib/db/schema";
import { decrypt } from "@/lib/crypto";

export type NotificationKind = "ntfy" | "discord" | "slack" | "webhook" | "pushover";

export const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";

export type NotificationConfig = {
  url: string;
  topic?: string;
  authToken?: string;
  /** Pushover recipient user (or group) key. */
  userKey?: string;
  /** Opt-in: also receive scheduled digest summaries on this channel. */
  digest?: boolean;
};

export type NotificationAlert = {
  id: string;
  title: string;
  body: string | null;
  kind?: string;
  createdAt: Date;
};

export type NotificationRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

export function buildAlertText(alert: Pick<NotificationAlert, "title" | "body">): string {
  return alert.body ? `${alert.title}\n${alert.body}` : alert.title;
}

export function buildNotificationRequest(
  channel: { kind: NotificationKind; config: NotificationConfig },
  alert: NotificationAlert,
): NotificationRequest {
  const text = buildAlertText(alert);
  if (channel.kind === "ntfy") {
    const url = channel.config.topic
      ? `${channel.config.url.replace(/\/+$/, "")}/${encodeURIComponent(channel.config.topic)}`
      : channel.config.url;
    return {
      url,
      headers: {
        Title: alert.title,
        ...(channel.config.authToken ? { Authorization: `Bearer ${channel.config.authToken}` } : {}),
      },
      body: alert.body ?? alert.title,
    };
  }
  if (channel.kind === "discord") {
    return {
      url: channel.config.url,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text }),
    };
  }
  if (channel.kind === "slack") {
    return {
      url: channel.config.url,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    };
  }
  if (channel.kind === "pushover") {
    return {
      url: channel.config.url || PUSHOVER_API_URL,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: channel.config.authToken,
        user: channel.config.userKey,
        title: alert.title,
        message: alert.body ?? alert.title,
      }),
    };
  }
  return {
    url: channel.config.url,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: alert.title,
      body: alert.body,
      severity: alert.kind,
      alertId: alert.id,
      createdAt: alert.createdAt.toISOString(),
    }),
  };
}

export async function sendNotificationRequest(request: NotificationRequest): Promise<void> {
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
}

export async function deliverPendingAlerts(userId: string): Promise<{ alerts: number; attempts: number }> {
  const since = new Date(Date.now() - 7 * 86400_000);
  const pending = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.userId, userId), isNull(alerts.notifiedAt), gte(alerts.createdAt, since)))
    .limit(100);

  if (pending.length === 0) return { alerts: 0, attempts: 0 };

  const channels = await db
    .select()
    .from(notificationChannels)
    .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.enabled, true)));

  let attempts = 0;
  for (const alert of pending) {
    for (const channel of channels) {
      try {
        const config = JSON.parse(decrypt(channel.configCipher)) as NotificationConfig;
        // Digest summaries are per-channel opt-in; regular alerts go everywhere.
        if (alert.kind === "digest" && config.digest !== true) continue;
        attempts++;
        await sendNotificationRequest({
          ...buildNotificationRequest({ kind: channel.kind as NotificationKind, config }, alert),
        });
        await db
          .update(notificationChannels)
          .set({ lastSuccessAt: new Date(), lastError: null })
          .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.id, channel.id)));
      } catch (error) {
        await db
          .update(notificationChannels)
          .set({ lastError: (error as Error).message.slice(0, 500) })
          .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.id, channel.id)));
      }
    }
    await db
      .update(alerts)
      .set({ notifiedAt: new Date() })
      .where(and(eq(alerts.userId, userId), eq(alerts.id, alert.id)));
  }

  return { alerts: pending.length, attempts };
}

export async function sendTestNotification(channel: typeof notificationChannels.$inferSelect): Promise<void> {
  const config = JSON.parse(decrypt(channel.configCipher)) as NotificationConfig;
  await sendNotificationRequest(
    buildNotificationRequest(
      { kind: channel.kind as NotificationKind, config },
      {
        id: "test",
        title: "OpenCoffer test notification",
        body: `Test message for ${channel.label}.`,
        kind: "test",
        createdAt: new Date(),
      },
    ),
  );
}
