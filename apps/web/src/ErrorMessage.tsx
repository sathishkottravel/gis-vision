import { ApiError } from './api.js';

/** Shows an error, listing each failing field the API reported (`error.issues`). */
export function ErrorMessage({ error }: { error: unknown }) {
  if (error === undefined) {
    return null;
  }
  const message = error instanceof Error ? error.message : 'Unexpected error';
  const issues = error instanceof ApiError ? error.issues : [];
  return (
    <div className="error" role="alert">
      <p>
        {error instanceof ApiError ? `${String(error.status)} ${error.code}: ` : ''}
        {message}
      </p>
      {issues.length > 0 && (
        <ul>
          {issues.map((issue) => (
            <li key={issue.path}>
              <code>{issue.path}</code> {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
