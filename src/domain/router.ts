import type { Channel, NormalizedMessage, RouteRecord } from './types.js';

export interface RoutingPolicyConfig {
  whatsappToEmail: boolean;
  emailToWhatsapp: boolean;
  allowedEmailSenders: readonly string[];
}

export type RouteDecision =
  | {
      allowed: true;
      destinationChannel: Channel;
      destinationId: string;
      routeId: string;
    }
  | {
      allowed: false;
      reason: string;
    };

export function isGroupWhatsAppChat(chatId: string): boolean {
  return chatId.endsWith('@g.us') || chatId.endsWith('@broadcast') || chatId === 'status@broadcast';
}

export class Router {
  private readonly policy: RoutingPolicyConfig;
  private readonly allowedEmailSendersSet: ReadonlySet<string>;
  private readonly getEnabledRoutes: (sourceChannel: Channel, sourceIdentity: string) => RouteRecord[];

  constructor(
    policy: RoutingPolicyConfig,
    getEnabledRoutes: (sourceChannel: Channel, sourceIdentity: string) => RouteRecord[]
  ) {
    this.policy = policy;
    this.allowedEmailSendersSet = new Set(
      policy.allowedEmailSenders.map((s) => s.toLowerCase().trim())
    );
    this.getEnabledRoutes = getEnabledRoutes;
  }

  public evaluate(message: NormalizedMessage, targetChatId?: string): RouteDecision {
    if (message.sourceChannel === 'whatsapp') {
      if (!this.policy.whatsappToEmail) {
        return { allowed: false, reason: 'whatsapp_to_email_disabled' };
      }

      if (isGroupWhatsAppChat(message.conversationId)) {
        return { allowed: false, reason: 'group_or_broadcast_chat_not_allowed' };
      }

      const routes = this.getEnabledRoutes('whatsapp', message.conversationId);
      let matchingRoute = routes.find((r) => r.enabled && r.destinationChannel === 'email');
      if (!matchingRoute) {
        const wildcardRoutes = this.getEnabledRoutes('whatsapp', '*');
        matchingRoute = wildcardRoutes.find((r) => r.enabled && r.destinationChannel === 'email');
      }
      if (!matchingRoute) {
        return { allowed: false, reason: 'unconfigured_whatsapp_chat' };
      }

      return {
        allowed: true,
        destinationChannel: matchingRoute.destinationChannel,
        destinationId: matchingRoute.destinationIdentity,
        routeId: matchingRoute.id,
      };
    }

    if (message.sourceChannel === 'email') {
      if (!this.policy.emailToWhatsapp) {
        return { allowed: false, reason: 'email_to_whatsapp_disabled' };
      }

      const rawSender = message.senderId.toLowerCase().trim();
      const senderEmail = rawSender.match(/<([^>]+)>/)?.[1]?.trim() ?? rawSender;
      if (!this.allowedEmailSendersSet.has(senderEmail)) {
        return { allowed: false, reason: 'unauthorized_email_sender' };
      }

      const targetChat = targetChatId ?? message.targetChatId ?? message.conversationId;

      let routes = this.getEnabledRoutes('email', message.senderId);
      let matchingRoute = routes.find(
        (r) =>
          r.enabled &&
          r.destinationChannel === 'whatsapp' &&
          (!targetChat || r.destinationIdentity === targetChat || r.destinationIdentity === '*')
      );

      if (!matchingRoute && targetChat) {
        routes = this.getEnabledRoutes('email', targetChat);
        matchingRoute = routes.find(
          (r) => r.enabled && r.destinationChannel === 'whatsapp'
        );
      }

      if (!matchingRoute) {
        const wildcardRoutes = this.getEnabledRoutes('email', '*');
        matchingRoute = wildcardRoutes.find(
          (r) => r.enabled && r.destinationChannel === 'whatsapp'
        );
      }

      if (!matchingRoute) {
        return { allowed: false, reason: 'no_enabled_route_for_email_sender' };
      }

      const destinationId =
        matchingRoute.destinationIdentity === '*' ? targetChat : matchingRoute.destinationIdentity;

      if (!destinationId) {
        return { allowed: false, reason: 'missing_destination_chat' };
      }

      if (isGroupWhatsAppChat(destinationId)) {
        return { allowed: false, reason: 'group_destination_not_allowed' };
      }

      return {
        allowed: true,
        destinationChannel: matchingRoute.destinationChannel,
        destinationId,
        routeId: matchingRoute.id,
      };
    }

    return { allowed: false, reason: 'unknown_source_channel' };
  }
}
