import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function createIdentity({ ownerId, endpointId, kind = 'human' }) {
  const keys = crypto.generateKeyPairSync('ed25519');
  return {
    owner_id: ownerId,
    endpoint_id: endpointId,
    key_id: `key_${endpointId}`,
    kind,
    status: 'active',
    public_key_pem: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    private_key_pem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    relay_token: crypto.randomBytes(24).toString('base64url'),
    connector_token: crypto.randomBytes(24).toString('base64url')
  };
}

export function loadIdentity(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`No identity file at ${filePath}. Run "sigil init" first.`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function saveIdentity(filePath, identity) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(identity, null, 2));
}

export function identityKeys(identity) {
  return {
    privateKey: crypto.createPrivateKey(identity.private_key_pem),
    publicKey: crypto.createPublicKey(identity.public_key_pem)
  };
}
