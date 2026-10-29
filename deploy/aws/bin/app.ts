// CDK app for the public deployment (design D3). `pnpm --filter @gis-vision/deploy-aws cdk ...`
import { App } from 'aws-cdk-lib';
import { AppStack } from '../src/app-stack.js';

const app = new App();

const apiReservedConcurrency = Number(app.node.tryGetContext('apiReservedConcurrency') ?? 10);
if (!Number.isInteger(apiReservedConcurrency) || apiReservedConcurrency < 0) {
  throw new Error('Context apiReservedConcurrency must be a non-negative integer');
}

// eu-central-1 sits next to the droplet in DigitalOcean fra1 (Deploy v0 design D1).
new AppStack(app, 'GisVisionApp', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'eu-central-1' },
  apiReservedConcurrency,
});
