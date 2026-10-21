import { generateSigningKeys } from '@soukconnect/service-kit';

/**
 * Prints a new Ed25519 key pair as environment lines: the private key for the gateway only, the
 * public key for every service. During a rotation, the services list the new key and the old one.
 */
const kid = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const { privateJwk, publicJwk } = await generateSigningKeys(kid);
process.stdout.write(
  [
    '# Gateway only: keep it secret.',
    `INTERNAL_JWT_PRIVATE_KEY='${JSON.stringify(privateJwk)}'`,
    '# Every service.',
    `INTERNAL_JWT_PUBLIC_KEYS='${JSON.stringify([publicJwk])}'`,
    '',
  ].join('\n'),
);
