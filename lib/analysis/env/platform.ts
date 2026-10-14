/**
 * Names the platform provides at runtime — never "not set", never a
 * finding (DESIGN.md §6.12 §3, §6.15 §2). Shared by the infra links and the
 * env catalog.
 */
export const RUNTIME_ENV =
  /^(NODE_ENV|HOME|PATH|PWD|HOSTNAME|HOST|USER|SHELL|TMPDIR|TEMP|TMP|CI|TZ|LANG|LC_ALL|TERM|DEBUG|PORT|NOMAD_[A-Z0-9_]+|KUBERNETES_[A-Z0-9_]+|npm_[A-Za-z0-9_]+|VERCEL[A-Z0-9_]*|NEXT_RUNTIME|NEXT_PHASE|JAVA_HOME|PYTHONPATH|GOPATH|GITHUB_[A-Z0-9_]+|RUNNER_[A-Z0-9_]+|CI_[A-Z0-9_]+|MODE|DEV|PROD|SSR|BASE_URL)$/;

export const isPlatformEnv = (name: string) => RUNTIME_ENV.test(name);

/** Prefixes that put a name in the browser bundle, by framework convention. */
export const CLIENT_PREFIXES = ["NEXT_PUBLIC_", "VITE_", "REACT_APP_", "PUBLIC_", "EXPO_PUBLIC_", "NUXT_PUBLIC_", "GATSBY_"];
