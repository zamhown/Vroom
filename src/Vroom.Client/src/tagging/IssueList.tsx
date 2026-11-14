import { t as appText } from '../i18n';
import { useApp } from '../context';
import { localize } from './i18n';

export interface AnnotationIssue {
  subject?: { kind: string; id: string };
  tagKey?: string;
  code?: string;
}

/** Localized list of incompatible annotations instead of raw JSON. */
export function IssueList({ issues, limit = 100 }: { issues?: AnnotationIssue[]; limit?: number }) {
  const app = useApp();
  const pack = app.data.tagging.package;
  if (!issues?.length) return <p className="form-help">{appText('IssueList.none')}</p>;
  return (
    <>
      <ul className="issue-list">
        {issues.slice(0, limit).map((issue, index) => {
          const field = pack.definitions.find(d => d.key === issue.tagKey);
          return (
            <li key={index}>
              <span>{field ? localize(field.label, app.locale, pack) : issue.tagKey}</span>
              <span className="form-help">
                {appText('IssueList.subject', { kind: issue.subject?.kind ?? '', id: issue.subject?.id ?? '' })}
              </span>
              <span>{issue.code ? appText('error.' + issue.code) : ''}</span>
            </li>
          );
        })}
      </ul>
      {issues.length > limit && (
        <p className="form-help">{appText('IssueList.more', { count: issues.length - limit })}</p>
      )}
    </>
  );
}
