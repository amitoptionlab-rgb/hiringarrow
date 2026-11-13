import { SESv2Client, CreateEmailIdentityCommand, GetEmailIdentityCommand, DeleteEmailIdentityCommand } from '@aws-sdk/client-sesv2';
import { config } from '../config.js';

const c = config.ses;
export const sesEnabled = !!(c.region && c.accessKeyId && c.secretAccessKey);
const client = sesEnabled
  ? new SESv2Client({ region: c.region, credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey } })
  : null;

const view = (r) => ({
  tokens: r.DkimAttributes?.Tokens || [],
  dkimStatus: r.DkimAttributes?.Status || 'NOT_STARTED',
  verifiedForSending: !!r.VerifiedForSendingStatus,
});

export async function getIdentity(domain) {
  try { return view(await client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }))); }
  catch (e) { if (e.name === 'NotFoundException') return null; throw e; }
}

// Idempotent. SES identities are account-wide, so an existing one is reused, never recreated.
export async function ensureIdentity(domain) {
  const have = await getIdentity(domain);
  if (have) return have;
  try {
    const r = await client.send(new CreateEmailIdentityCommand({
      EmailIdentity: domain,
      ...(c.configurationSet ? { ConfigurationSetName: c.configurationSet } : {}),
    }));
    return view(r);
  } catch (e) {
    if (e.name === 'AlreadyExistsException') return getIdentity(domain);
    throw e;
  }
}

export async function deleteIdentity(domain) {
  try { await client.send(new DeleteEmailIdentityCommand({ EmailIdentity: domain })); }
  catch (e) { if (e.name !== 'NotFoundException') throw e; }
}

export const dkimRecords = (domain, tokens) =>
  (tokens || []).map((t) => ({ type: 'CNAME', host: `${t}._domainkey.${domain}`, value: `${t}.dkim.amazonses.com` }));
