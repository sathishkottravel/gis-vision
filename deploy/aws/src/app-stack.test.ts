import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { AppStack } from './app-stack.js';

/** Synthesizes the stack without bundling (no esbuild run), as CI does. */
function synth(apiReservedConcurrency = 10): Template {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new AppStack(app, 'GisVisionApp', {
    env: { account: '123456789012', region: 'eu-central-1' },
    apiReservedConcurrency,
  });
  return Template.fromStack(stack);
}

/** All IAM actions granted by the stack's policies. */
function grantedActions(template: Template): string[] {
  const policies = template.findResources('AWS::IAM::Policy');
  return Object.values(policies).flatMap((policy) => {
    const statements = (
      policy as { Properties: { PolicyDocument: { Statement: { Action: string | string[] }[] } } }
    ).Properties.PolicyDocument.Statement;
    return statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
  });
}

// Design D2, D3; task 1.2.
describe('GisVisionApp stack, API part (FD.1)', () => {
  const template = synth();

  it('runs the API on Node.js 22 arm64 with production settings and one pooled connection', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      MemorySize: 512,
      Timeout: 10,
      ReservedConcurrentExecutions: 10,
      Handler: 'index.handler',
      Environment: {
        Variables: Match.objectLike({
          NODE_ENV: 'production',
          DATABASE_POOL_MAX: '1',
          S3_REGION: 'eu-central-1',
          DATABASE_SECRET_ARN: { Ref: Match.stringLikeRegexp('DatabaseSecret') },
          S3_BUCKET: { Ref: Match.stringLikeRegexp('Captures') },
        }),
      },
    });
  });

  it('never puts database settings in the function environment', () => {
    const fn = Object.values(template.findResources('AWS::Lambda::Function'))[0] as {
      Properties: { Environment: { Variables: Record<string, unknown> } };
    };
    const names = Object.keys(fn.Properties.Environment.Variables);

    expect(names).not.toContain('DATABASE_URL');
    expect(names).not.toContain('DATABASE_SSL_CA');
    expect(names).not.toContain('WORKER_TOKEN');
  });

  it('keeps logs for 14 days', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 14 });
  });

  it('reserves no concurrency when the context asks for 0', () => {
    const fn = Object.values(synth(0).findResources('AWS::Lambda::Function'))[0] as {
      Properties: Record<string, unknown>;
    };

    expect(fn.Properties).not.toHaveProperty('ReservedConcurrentExecutions');
  });

  it('serves every route through one HTTP API default route', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'HTTP' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: '$default' });
    template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
      IntegrationType: 'AWS_PROXY',
      PayloadFormatVersion: '2.0',
    });
  });

  it('keeps the captures bucket private, encrypted, TLS-only and retained', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
    });
    template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('creates the secret with a generated placeholder, not a value in the template', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: { SecretStringTemplate: '{}', GenerateStringKey: 'placeholder' },
    });
    const secret = Object.values(template.findResources('AWS::SecretsManager::Secret'))[0] as {
      Properties: Record<string, unknown>;
    };
    expect(secret.Properties).not.toHaveProperty('SecretString');
  });

  it('grants only image read/put, bucket listing and reading its own secret', () => {
    const actions = grantedActions(template);

    expect(actions).toEqual(
      expect.arrayContaining([
        's3:GetObject*',
        's3:List*',
        's3:PutObject',
        'secretsmanager:GetSecretValue',
      ]),
    );
    expect(actions.some((a) => a.startsWith('s3:DeleteObject'))).toBe(false);
    expect(actions.some((a) => a === 's3:*' || a === '*')).toBe(false);
  });

  it('outputs the API URL, bucket name and secret ARN for the runbook', () => {
    expect(Object.keys(template.findOutputs('*')).sort()).toEqual([
      'ApiUrl',
      'CapturesBucketName',
      'DatabaseSecretArn',
    ]);
  });
});
