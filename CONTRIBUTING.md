# Contributing

Use Node.js 24 and synthetic data only. Install dependencies with `npm ci`, then run `npm run lint`, `npm run build`, and `npm test`. Integration tests must use isolated local services; never link or change a hosted project. Discuss changes to provider behavior, the approval trust boundary, or the ledger recovery protocol in the pull request. Do not include credentials, private paths, or production identifiers in fixtures or logs.
