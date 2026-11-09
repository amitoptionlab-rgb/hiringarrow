// Headers on every bulk email.
//  - List-Unsubscribe(+Post): one-click unsubscribe required by Gmail/Yahoo for bulk senders.
//  - X-Mailin-custom: Brevo echoes this header back in its bounce/complaint webhooks, which is how we match an
//    event to the message. Other providers ignore unknown X- headers.
export function bulkHeaders({ messageId, campaignId, tenantId, unsubUrl }) {
  return {
    'List-Unsubscribe': `<${unsubUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'Feedback-ID': `${campaignId}:${tenantId}:bulk`,
    'Precedence': 'bulk',
    'X-Mailin-custom': messageId,
  };
}
