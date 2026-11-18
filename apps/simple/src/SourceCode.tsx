// modelXare is open source: where this build's code is (WEXARE_SOURCE_CODE),
// shown in the header on every page, at the end of the front page and in the
// Xare steps. A build without the setting shows no link. Who makes the app
// (WEXARE_MAKER_SITE) is linked from "by weXare" the same way.
import { CLIENT_CONFIG } from '@wexare/web/src/lib/client-config.ts';

/** The maker's site ("https://wexare.com"), or undefined when the build doesn't say. */
export const MAKER_SITE = CLIENT_CONFIG.makerSite;

/** "https://github.com/owner/repo", or undefined when the build doesn't say. */
export const SOURCE_CODE = CLIENT_CONFIG.sourceCode;

const host = SOURCE_CODE ? new URL(SOURCE_CODE).hostname : '';

/** The code is on GitHub, so its mark is the one people recognize. */
export const ON_GITHUB = host === 'github.com' || host === 'www.github.com';

/** Where the code is, in words: "GitHub", or the host's name. */
export const SOURCE_HOST = ON_GITHUB ? 'GitHub' : host;

/** A file in the repository, as its host shows it ("/blob/main/…" works on GitHub and GitLab). */
export const sourceFile = (path: string) => (SOURCE_CODE ? `${SOURCE_CODE}/blob/main/${path}` : undefined);

/** The folder `git clone` makes: the repository's name. */
export const CLONE_DIR = SOURCE_CODE?.split('/').pop() ?? '';

/**
 * GitHub's mark (the Octocat), from GitHub's Octicons, for links to the code on
 * GitHub only. It belongs to GitHub (see NOTICE). Elsewhere: a plain code sign.
 */
export function SourceMark({ className }: { className?: string }) {
  return ON_GITHUB ? (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
      />
    </svg>
  ) : (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16" />
    </svg>
  );
}
