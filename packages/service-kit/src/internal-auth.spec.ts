import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  createInternalVerifier,
  generateSigningKeys,
  importSigningKey,
  INTERNAL_ALG,
  INTERNAL_ISSUER,
  parsePublicKeys,
  signInternalToken,
} from './internal-auth.js';

const buyer = {
  userId: '0199f0a4-7a5b-7c1e-9f00-0000000000b1',
  role: 'buyer' as const,
  shopId: null,
};
const seller = {
  userId: '0199f0a4-7a5b-7c1e-9f00-0000000000c1',
  role: 'seller' as const,
  shopId: '0199f0a4-7a5b-7c1e-9f00-0000000000c2',
};

async function keys(kid = 'k1') {
  const { privateJwk, publicJwk } = await generateSigningKeys(kid);
  return {
    signing: await importSigningKey(JSON.stringify(privateJwk)),
    publicKeys: parsePublicKeys(JSON.stringify([publicJwk])),
    privateJwk,
  };
}

describe('internal tokens', () => {
  it('carry the actor from the gateway to the service they are meant for', async () => {
    const { signing, publicKeys } = await keys();
    const verify = createInternalVerifier({ audience: 'orders', publicKeys });

    await expect(verify(await signInternalToken(signing, 'orders', buyer))).resolves.toEqual(buyer);
    await expect(verify(await signInternalToken(signing, 'orders', seller))).resolves.toEqual(
      seller,
    );
    await expect(
      verify(
        await signInternalToken(signing, 'orders', { userId: null, role: 'visitor', shopId: null }),
      ),
    ).resolves.toEqual({ userId: null, role: 'visitor', shopId: null });
  });

  it('are refused by another service', async () => {
    const { signing, publicKeys } = await keys();
    const token = await signInternalToken(signing, 'catalog', buyer);

    await expect(
      createInternalVerifier({ audience: 'payments', publicKeys })(token),
    ).rejects.toThrow();
  });

  it('are refused when signed with another key, even with the same kid', async () => {
    const legit = await keys('k1');
    const attacker = await keys('k1');
    const token = await signInternalToken(attacker.signing, 'orders', buyer);

    await expect(
      createInternalVerifier({ audience: 'orders', publicKeys: legit.publicKeys })(token),
    ).rejects.toThrow();
  });

  it('accept the previous key during a rotation', async () => {
    const previous = await keys('2026-09');
    const current = await keys('2026-10');
    const verify = createInternalVerifier({
      audience: 'orders',
      publicKeys: [...current.publicKeys, ...previous.publicKeys],
    });

    await expect(
      verify(await signInternalToken(previous.signing, 'orders', buyer)),
    ).resolves.toEqual(buyer);
  });

  it('expire within a minute', async () => {
    const { signing, publicKeys } = await keys();
    const verify = createInternalVerifier({ audience: 'orders', publicKeys });
    const stale = await new SignJWT({ role: 'buyer', shopId: null })
      .setProtectedHeader({ alg: INTERNAL_ALG, kid: 'k1', typ: 'JWT' })
      .setIssuer(INTERNAL_ISSUER)
      .setAudience('orders')
      .setSubject(buyer.userId)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 540)
      .sign(signing.privateKey);

    await expect(verify(stale)).rejects.toThrow();
  });

  it('refuse inconsistent claims: a buyer without subject, a shop for a non-seller', async () => {
    const { signing, publicKeys } = await keys();
    const verify = createInternalVerifier({ audience: 'orders', publicKeys });
    const sign = (claims: Record<string, unknown>, subject?: string) => {
      const token = new SignJWT(claims)
        .setProtectedHeader({ alg: INTERNAL_ALG, kid: 'k1', typ: 'JWT' })
        .setIssuer(INTERNAL_ISSUER)
        .setAudience('orders')
        .setIssuedAt()
        .setExpirationTime('60s');
      if (subject) token.setSubject(subject);
      return token.sign(signing.privateKey);
    };

    await expect(verify(await sign({ role: 'buyer', shopId: null }))).rejects.toThrow(/subject/);
    await expect(
      verify(await sign({ role: 'buyer', shopId: seller.shopId }, buyer.userId)),
    ).rejects.toThrow(/seller/);
    await expect(
      verify(await sign({ role: 'admin', shopId: null }, buyer.userId)),
    ).rejects.toThrow();
  });

  it('never accept a private key among the public keys', async () => {
    const { privateJwk } = await keys();

    expect(() => parsePublicKeys(JSON.stringify([privateJwk]))).toThrow(/private key/);
    expect(() => parsePublicKeys('[]')).toThrow();
    expect(() => parsePublicKeys('[{"kty":"RSA","kid":"x"}]')).toThrow();
  });
});
