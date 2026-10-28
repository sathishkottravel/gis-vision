import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { RegisteredDetector } from '../detectors/detector-registry.js';
import { UnprocessableError, type FieldIssue } from '../errors.js';

/** Request-body path of an Ajv error, e.g. `attributes.state` or `attributes.tags.1`. */
function issuePath(error: ErrorObject): string {
  const segments = error.instancePath
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  const params = error.params as { missingProperty?: string; additionalProperty?: string };
  const property = params.missingProperty ?? params.additionalProperty;
  if (property !== undefined) {
    segments.push(property);
  }
  return ['attributes', ...segments].join('.');
}

/**
 * Validates detection attributes against the detector's output schema (design D6) with Ajv.
 * Compiled validators are cached per detector id and version: a detector's schema must not
 * change without a new version.
 */
export class AttributeValidator {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: true });
  private readonly compiled = new Map<string, ValidateFunction>();

  constructor() {
    addFormats.default(this.ajv);
  }

  /** Throws a 422 `invalid_attributes` error listing each violation with its path. */
  validate(detector: RegisteredDetector, attributes: Record<string, unknown>): void {
    const validate = this.validatorFor(detector);
    if (validate(attributes)) {
      return;
    }
    const issues: FieldIssue[] = (validate.errors ?? []).map((error) => ({
      path: issuePath(error),
      message: error.message ?? 'is invalid',
    }));
    throw new UnprocessableError('invalid_attributes', issues);
  }

  private validatorFor(detector: RegisteredDetector): ValidateFunction {
    const key = `${detector.id}@${String(detector.version)}`;
    let validate = this.compiled.get(key);
    if (!validate) {
      validate = this.ajv.compile(detector.outputSchema);
      this.compiled.set(key, validate);
    }
    return validate;
  }
}
