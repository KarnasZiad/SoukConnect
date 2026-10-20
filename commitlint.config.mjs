/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      1,
      'always',
      [
        'web',
        'gateway',
        'catalog',
        'orders',
        'payments',
        'notifications',
        'contracts',
        'messaging',
        'service-kit',
        'e2e',
        'infra',
        'k8s',
        'ci',
        'deps',
        'docs',
      ],
    ],
  },
};
