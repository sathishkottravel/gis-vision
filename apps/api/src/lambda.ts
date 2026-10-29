// AWS Lambda entry point (design D2), bundled by the CDK app in deploy/aws. Initialization runs
// once per execution environment, before the first invocation.
import { createLambdaHandler } from './lambda-handler.js';

export const handler = await createLambdaHandler();
