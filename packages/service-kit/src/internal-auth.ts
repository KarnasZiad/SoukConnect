import { ROLES, type Role } from '@soukconnect/contracts';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importJWK,
  type CryptoKey,
  type JWK,
  jwtVerify,
  SignJWT,
} from 'jose';
import { z } from 'zod';

/** Fully specified JOSE algorithm for Ed25519 signatures (RFC 9864). */
export const INTERNAL_ALG = 'Ed25519';
export const INTERNAL_ISSUER = 'souk-gateway';
const MAX_TTL_SECONDS = 60;

/** Who acts, as asserted by the gateway (ADR 0006). A visitor has no account. */
export interface Actor {
  userId: string | null;
  role: Role | 'visitor';
  shopId: string | null;
}

export interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
}

const claims = z.object({
  sub: z.uuid().optional(),
  role: z.enum([...ROLES, 'visitor']),
  shopId: z.uuid().nullable().default(null),
});

/** Signs the short-lived token the gateway attaches to a request routed to `audience`. */
export async function signInternalToken(
  key: SigningKey,
  audience: string,
  actor: Actor,
  ttlSeconds = MAX_TTL_SECONDS,
): Promise<string> {
  const token = new SignJWT({ role: actor.role, shopId: actor.shopId })
    .setProtectedHeader({ alg: INTERNAL_ALG, kid: key.kid, typ: 'JWT' })
    .setIssuer(INTERNAL_ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${Math.min(ttlSeconds, MAX_TTL_SECONDS)}s`);
  if (actor.userId !== null) token.setSubject(actor.userId);
  return token.sign(key.privateKey);
}

export type TokenVerifier = (token: string) => Promise<Actor>;

/**
 * Verifies tokens for one service. Several public keys may be active (the current one and the
 * previous one during a rotation); the `kid` header picks the key.
 */
export function createInternalVerifier(options: {
  audience: string;
  publicKeys: readonly JWK[];
}): TokenVerifier {
  const keys = createLocalJWKSet({ keys: [...options.publicKeys] });
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, {
      issuer: INTERNAL_ISSUER,
      audience: options.audience,
      algorithms: [INTERNAL_ALG],
      clockTolerance: 5,
      maxTokenAge: MAX_TTL_SECONDS + 5,
      typ: 'JWT',
    });
    const parsed = claims.parse(payload);
    if (parsed.role !== 'visitor' && parsed.sub === undefined) {
      throw new Error('A signed-in actor must have a subject');
    }
    if (parsed.role !== 'seller' && parsed.shopId !== null) {
      throw new Error('Only a seller acts for a shop');
    }
    return { userId: parsed.sub ?? null, role: parsed.role, shopId: parsed.shopId };
  };
}

const publicJwk = z
  .object({
    kty: z.literal('OKP'),
    crv: z.literal('Ed25519'),
    x: z.string().min(1),
    kid: z.string().min(1).max(64),
  })
  .loose()
  .refine((jwk) => !('d' in jwk), { message: 'A private key does not belong in public keys' });

/** Public keys of the gateway, from `INTERNAL_JWT_PUBLIC_KEYS` (a JSON array of JWKs). */
export function parsePublicKeys(json: string): JWK[] {
  return z.array(publicJwk).min(1).max(3).parse(JSON.parse(json));
}

/** Private key of the gateway, from `INTERNAL_JWT_PRIVATE_KEY` (a JWK with its `kid`). */
export async function importSigningKey(json: string): Promise<SigningKey> {
  const jwk = z
    .object({
      kty: z.literal('OKP'),
      crv: z.literal('Ed25519'),
      d: z.string(),
      x: z.string(),
      kid: z.string().min(1),
    })
    .loose()
    .parse(JSON.parse(json)) as JWK & { kid: string };
  return { kid: jwk.kid, privateKey: (await importJWK(jwk, INTERNAL_ALG)) as CryptoKey };
}

/** A new key pair, as JWKs ready to be stored in the environment of the gateway and the services. */
export async function generateSigningKeys(
  kid: string,
): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair(INTERNAL_ALG, { extractable: true });
  const common = { kid, alg: INTERNAL_ALG, use: 'sig' };
  return {
    privateJwk: { ...(await exportJWK(privateKey)), ...common },
    publicJwk: { ...(await exportJWK(publicKey)), ...common },
  };
}
