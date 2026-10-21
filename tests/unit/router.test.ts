import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../../src/domain/router.js';
import type { NormalizedMessage, RouteRecord } from '../../src/domain/types.js';

const CONFIGURED_CHAT = '15551234567@s.whatsapp.net';
const ALLOWED_EMAIL = 'user@example.com';

const DEFAULT_ROUTES: RouteRecord[] = [
  {
    id: 'route-wa-email',
    sourceChannel: 'whatsapp',
    sourceIdentity: CONFIGURED_CHAT,
    destinationChannel: 'email',
    destinationIdentity: ALLOWED_EMAIL,
    enabled: true,
  },
  {
    id: 'route-email-wa',
    sourceChannel: 'email',
    sourceIdentity: ALLOWED_EMAIL,
    destinationChannel: 'whatsapp',
    destinationIdentity: CONFIGURED_CHAT,
    enabled: true,
  },
];

function makeRouter(overrides: Partial<ConstructorParameters<typeof Router>[0]> = {}) {
  return new Router(
    {
      whatsappToEmail: true,
      emailToWhatsapp: true,
      allowedEmailSenders: [ALLOWED_EMAIL],
      ...overrides,
    },
    (channel, identity) =>
      DEFAULT_ROUTES.filter(
        (r) => r.sourceChannel === channel && r.sourceIdentity === identity && r.enabled
      )
  );
}

describe('Router Policy & Restrictions', () => {
  it('allows WhatsApp -> Email for the configured personal chat', () => {
    const router = makeRouter();
    const msg: NormalizedMessage = {
      id: 'm1',
      sourceChannel: 'whatsapp',
      sourceMessageId: 'wa-1',
      senderId: CONFIGURED_CHAT,
      conversationId: CONFIGURED_CHAT,
      text: 'Hello',
      messageType: 'text',
      createdAt: new Date().toISOString(),
    };

    const decision = router.evaluate(msg);
    assert.deepEqual(decision, {
      allowed: true,
      destinationChannel: 'email',
      destinationId: ALLOWED_EMAIL,
      routeId: 'route-wa-email',
    });
  });

  it('rejects WhatsApp messages from unconfigured chats', () => {
    const router = makeRouter();
    const msg: NormalizedMessage = {
      id: 'm2',
      sourceChannel: 'whatsapp',
      sourceMessageId: 'wa-2',
      senderId: '15550000000@s.whatsapp.net',
      conversationId: '15550000000@s.whatsapp.net',
      text: 'Secret',
      messageType: 'text',
      createdAt: new Date().toISOString(),
    };

    const decision = router.evaluate(msg);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'unconfigured_whatsapp_chat');
  });

  it('rejects WhatsApp group chats (@g.us)', () => {
    const router = makeRouter();
    const msg: NormalizedMessage = {
      id: 'm3',
      sourceChannel: 'whatsapp',
      sourceMessageId: 'wa-3',
      senderId: CONFIGURED_CHAT,
      conversationId: '120363025555@g.us',
      text: 'Group message',
      messageType: 'text',
      createdAt: new Date().toISOString(),
    };

    const decision = router.evaluate(msg);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'group_or_broadcast_chat_not_allowed');
  });

  it('allows Email -> WhatsApp from an allowlisted sender to targetChatId', () => {
    const router = makeRouter();
    const msg: NormalizedMessage = {
      id: 'm4',
      sourceChannel: 'email',
      sourceMessageId: 'EM1',
      senderId: ALLOWED_EMAIL,
      conversationId: CONFIGURED_CHAT,
      targetChatId: CONFIGURED_CHAT,
      text: 'Hi back',
      messageType: 'text',
      createdAt: new Date().toISOString(),
    };

    const decision = router.evaluate(msg, CONFIGURED_CHAT);
    assert.deepEqual(decision, {
      allowed: true,
      destinationChannel: 'whatsapp',
      destinationId: CONFIGURED_CHAT,
      routeId: 'route-email-wa',
    });
  });

  it('rejects Email from non-allowlisted sender email addresses', () => {
    const router = makeRouter();
    const msg: NormalizedMessage = {
      id: 'm5',
      sourceChannel: 'email',
      sourceMessageId: 'EM2',
      senderId: 'spammer@example.com',
      conversationId: CONFIGURED_CHAT,
      targetChatId: CONFIGURED_CHAT,
      text: 'Spam',
      messageType: 'text',
      createdAt: new Date().toISOString(),
    };

    const decision = router.evaluate(msg, CONFIGURED_CHAT);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'unauthorized_email_sender');
  });

  it('respects directional enablement toggles', () => {
    const routerNoWaToEmail = makeRouter({ whatsappToEmail: false });
    const waMsg: NormalizedMessage = {
      id: 'm6',
      sourceChannel: 'whatsapp',
      sourceMessageId: 'wa-6',
      senderId: CONFIGURED_CHAT,
      conversationId: CONFIGURED_CHAT,
      text: 'Hello',
      messageType: 'text',
      createdAt: new Date().toISOString(),
    };
    assert.equal(routerNoWaToEmail.evaluate(waMsg).allowed, false);

    const routerNoEmailToWa = makeRouter({ emailToWhatsapp: false });
    const emailMsg: NormalizedMessage = {
      id: 'm7',
      sourceChannel: 'email',
      sourceMessageId: 'EM7',
      senderId: ALLOWED_EMAIL,
      conversationId: CONFIGURED_CHAT,
      targetChatId: CONFIGURED_CHAT,
      text: 'Hello',
      messageType: 'text',
      createdAt: new Date().toISOString(),
    };
    assert.equal(routerNoEmailToWa.evaluate(emailMsg, CONFIGURED_CHAT).allowed, false);
  });

  it('supports wildcard all-chat routing for WhatsApp -> Email and Email -> WhatsApp', () => {
    const wildcardRoutes: RouteRecord[] = [
      {
        id: 'wildcard-wa-email',
        sourceChannel: 'whatsapp',
        sourceIdentity: '*',
        destinationChannel: 'email',
        destinationIdentity: ALLOWED_EMAIL,
        enabled: true,
      },
      {
        id: 'wildcard-email-wa',
        sourceChannel: 'email',
        sourceIdentity: ALLOWED_EMAIL,
        destinationChannel: 'whatsapp',
        destinationIdentity: '*',
        enabled: true,
      },
    ];

    const router = new Router(
      {
        whatsappToEmail: true,
        emailToWhatsapp: true,
        allowedEmailSenders: [ALLOWED_EMAIL],
      },
      (channel, identity) =>
        wildcardRoutes.filter(
          (r) => r.sourceChannel === channel && (r.sourceIdentity === identity || r.sourceIdentity === '*') && r.enabled
        )
    );

    // 1. WhatsApp from Alice (random number 1)
    const aliceMsg: NormalizedMessage = {
      id: 'm-alice',
      sourceChannel: 'whatsapp',
      sourceMessageId: 'wa-alice',
      senderId: '111222333@s.whatsapp.net',
      conversationId: '111222333@s.whatsapp.net',
      text: 'Hey from Alice',
      messageType: 'text',
      createdAt: new Date().toISOString(),
    };
    const aliceDec = router.evaluate(aliceMsg);
    assert.equal(aliceDec.allowed, true);
    if (aliceDec.allowed) {
      assert.equal(aliceDec.destinationId, ALLOWED_EMAIL);
    }

    // 2. WhatsApp from Bob (random number 2)
    const bobMsg: NormalizedMessage = {
      id: 'm-bob',
      sourceChannel: 'whatsapp',
      sourceMessageId: 'wa-bob',
      senderId: '444555666@s.whatsapp.net',
      conversationId: '444555666@s.whatsapp.net',
      text: 'Hey from Bob',
      messageType: 'text',
      createdAt: new Date().toISOString(),
    };
    const bobDec = router.evaluate(bobMsg);
    assert.equal(bobDec.allowed, true);
    if (bobDec.allowed) {
      assert.equal(bobDec.destinationId, ALLOWED_EMAIL);
    }

    // 3. Email reply targeting Bob
    const emailToBob: NormalizedMessage = {
      id: 'm-reply-bob',
      sourceChannel: 'email',
      sourceMessageId: 'em-bob',
      senderId: ALLOWED_EMAIL,
      conversationId: '444555666@s.whatsapp.net',
      targetChatId: '444555666@s.whatsapp.net',
      text: 'Replying to Bob',
      messageType: 'text',
      createdAt: new Date().toISOString(),
    };
    const replyBobDec = router.evaluate(emailToBob, '444555666@s.whatsapp.net');
    assert.equal(replyBobDec.allowed, true);
    if (replyBobDec.allowed) {
      assert.equal(replyBobDec.destinationId, '444555666@s.whatsapp.net');
    }

    // 4. Wildcard still rejects WhatsApp group chats
    const groupMsg: NormalizedMessage = {
      id: 'm-group',
      sourceChannel: 'whatsapp',
      sourceMessageId: 'wa-group',
      senderId: '111222333@s.whatsapp.net',
      conversationId: '987654321@g.us',
      text: 'Group banter',
      messageType: 'text',
      createdAt: new Date().toISOString(),
    };
    assert.equal(router.evaluate(groupMsg).allowed, false);
  });
});
