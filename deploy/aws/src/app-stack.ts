import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

const API_ENTRY = fileURLToPath(new URL('../../../apps/api/src/lambda.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export interface AppStackProps extends StackProps {
  /**
   * Reserved concurrency for the API function (design D2/D11). `0` reserves none, for accounts
   * whose total Lambda concurrency quota is too small to reserve any (new accounts: 10).
   */
  apiReservedConcurrency: number;
}

/**
 * The public application (design D3). FD.1 adds the API: the Lambda function with its HTTP
 * API, the private captures bucket and the database secret. Later features add the web
 * hosting, the detection queue, the worker and the budget.
 */
export class AppStack extends Stack {
  readonly api: HttpApi;
  readonly capturesBucket: Bucket;
  readonly databaseSecret: Secret;
  readonly apiFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    this.capturesBucket = new Bucket(this, 'Captures', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: BucketEncryption.S3_MANAGED,
      // Uploaded images outlive a `cdk destroy`; delete the bucket by hand if wanted.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // JSON {DATABASE_URL, DATABASE_SSL_CA, WORKER_TOKEN}. Created with a random placeholder;
    // the runbook puts the real value from a file, so it never appears in CloudFormation.
    this.databaseSecret = new Secret(this, 'DatabaseSecret', {
      description: 'gis-vision API settings: DATABASE_URL, DATABASE_SSL_CA, WORKER_TOKEN',
      generateSecretString: { secretStringTemplate: '{}', generateStringKey: 'placeholder' },
    });

    const logGroup = new LogGroup(this, 'ApiLogs', {
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.apiFunction = new NodejsFunction(this, 'Api', {
      entry: API_ENTRY,
      handler: 'handler',
      projectRoot: REPO_ROOT,
      depsLockFilePath: `${REPO_ROOT}pnpm-lock.yaml`,
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(10),
      ...(props.apiReservedConcurrency > 0
        ? { reservedConcurrentExecutions: props.apiReservedConcurrency }
        : {}),
      logGroup,
      environment: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
        // One instance serves one request at a time; PgBouncer multiplexes the instances.
        DATABASE_POOL_MAX: '1',
        DATABASE_SECRET_ARN: this.databaseSecret.secretArn,
        S3_BUCKET: this.capturesBucket.bucketName,
        S3_REGION: this.region,
      },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        mainFields: ['module', 'main'],
        // Some CommonJS dependencies call require(); give the ESM bundle one.
        banner:
          "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
        // Optional native binding that `pg` tries to load; not used.
        externalModules: ['pg-native'],
        sourceMap: true,
      },
    });

    // Least privilege (design D3): read and put images (presigned URLs are signed with this
    // role), list the bucket for the /health HeadBucket, and read its own secret.
    this.capturesBucket.grantRead(this.apiFunction);
    this.capturesBucket.grantPut(this.apiFunction);
    this.databaseSecret.grantRead(this.apiFunction);

    this.api = new HttpApi(this, 'HttpApi', {
      description: 'gis-vision API',
      defaultIntegration: new HttpLambdaIntegration('ApiIntegration', this.apiFunction),
    });

    new CfnOutput(this, 'ApiUrl', { value: this.api.apiEndpoint });
    new CfnOutput(this, 'CapturesBucketName', { value: this.capturesBucket.bucketName });
    new CfnOutput(this, 'DatabaseSecretArn', { value: this.databaseSecret.secretArn });
  }
}
