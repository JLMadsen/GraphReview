// Stand-in values for the before/after preview (DESIGN.md §6.9): what a
// component reads from a context nobody provided, and the auth libraries a
// preview can't sign in to. Copied next to node-harness.mjs into /job and
// loaded by it; the bundled repo code reaches the same instance through
// `globalThis.__graphreviewFakes`.
//
// Everything is plainly fake — "Preview User", preview@example.com — so a
// preview is never mistaken for real data, and the harness says in the case
// log what it stood in for.

/** The signed-in user every fake auth library and context reports. */
export const PREVIEW_USER = Object.freeze({
  id: "preview-user",
  name: "Preview User",
  firstName: "Preview",
  lastName: "User",
  fullName: "Preview User",
  username: "preview-user",
  email: "preview@example.com",
  image: null,
  role: "user",
});

const FAR_FUTURE = "2099-01-01T00:00:00.000Z";
const SESSION = Object.freeze({ user: PREVIEW_USER, expires: FAR_FUTURE });

/** What the fakes were used for in this run: "AuthContext", "next-auth", … */
export const used = new Set();

// ---------------------------------------------------------------------------
// Fake values by key name
// ---------------------------------------------------------------------------

const TRUE_FLAGS = /^(is|has)?(authenticated|authed|loggedin|signedin|ready|loaded|initialized|initialised|mounted|hydrated|enabled|open|visible|online|connected|valid|verified|active)$/;
const NAME_KEYS = /^(name|fullname|displayname|username|nickname|title|label)$/;
const OBJECT_PLURALS = /^(settings|options|params|preferences|prefs|details|stats|credentials|props|metadata|address|status|access|progress|alias|canvas|class|series|news|bounds|dimensions|coords|headers|claims|attributes)$/;
const VERB = /^(set|get|on|handle|update|toggle|open|close|show|hide|log(in|out)|sign(in|out|up)|register|refresh|refetch|fetch|load|reload|dispatch|add|remove|delete|create|save|reset|clear|select|deselect|subscribe|unsubscribe|navigate|push|replace|submit|send|change|confirm|cancel|invalidate|mutate|track|emit|notify|start|stop|play|pause|switch|apply|connect|disconnect|upload|download|copy|init|destroy|enable|disable|increment|decrement|check|validate|format|translate|t)([A-Z_]|$)/;

/**
 * A plausible leaf for a key, or `undefined` when the key looks like a nested
 * object (which gets another fake). Booleans default to false — "not loading,
 * no error" — except the ones that mean signed in or ready.
 */
function leafFor(key, style = DEFAULT_STYLE) {
  const k = key.replace(/[-_]/g, "").toLowerCase();
  if (TRUE_FLAGS.test(k)) return { value: true };
  if (k === "status") return { value: "authenticated" };
  if (k === "user" || k === "currentuser" || k === "me" || k === "profile" || k === "viewer" || k === "account") return { value: PREVIEW_USER };
  if (k === "session") return { value: SESSION };
  // Before the name checks: `update`, `login`, `formatDate` are functions.
  if (VERB.test(key)) return { value: fakeFunction(key) };
  if (NAME_KEYS.test(k)) return { value: "Preview User" };
  if (k === "firstname" || k === "givenname") return { value: "Preview" };
  if (k === "lastname" || k === "familyname" || k === "surname") return { value: "User" };
  if (k.endsWith("email")) return { value: "preview@example.com" };
  if (k === "role") return { value: "user" };
  if (k === "locale" || k === "lang" || k === "language") return { value: "en" };
  if (k === "theme" || k === "mode" || k === "colorscheme") return { value: "light" };
  if (k.endsWith("token")) return { value: "preview-token" };
  if (/^(id|uuid|key|slug)$/.test(k) || /(Id|ID|_id)$/.test(key)) return { value: "preview-id" };
  if (/^(image|avatar|avatarurl|picture|photo|photourl|imageurl|icon)$/.test(k)) return { value: "" };
  if (/(url|href|link|path|route|pathname)$/.test(k)) return { value: "/" };
  if (/(At|Date|Time|Timestamp)$/.test(key) || /^(date|time|timestamp|expires|expiry)$/.test(k)) return { value: FAR_FUTURE };
  if (/^(count|total|length|size|index|page|pages|amount|price|balance|quantity|qty|offset|limit|step|value|progress|percent|score|width|height)$/.test(k)) {
    return { value: 0 };
  }
  if (/^(is|has|can|should|was|will|did)[a-z]/.test(k) || /(loading|pending|fetching|disabled|busy|submitting|saving)$/.test(k)) return { value: false };
  if (k === "error" || k.endsWith("error")) return { value: null };
  if ((/s$/.test(k) && !/ss$/.test(k) && !OBJECT_PLURALS.test(k)) || /(list|items|ids|entries|rows|results)$/.test(k)) {
    return { value: emptyList(key, style) };
  }
  return undefined;
}

/**
 * `items`, `notifications`: an empty array — `.map`, `.length` and
 * `Array.isArray` behave — that still answers a named read like an object
 * (`theme.colors.primary`), since a plural key isn't always a list.
 */
function emptyList(label, style) {
  const cache = new Map();
  return new Proxy([], {
    get(t, key, receiver) {
      if (typeof key === "symbol" || key in t || /^\d+$/.test(key)) return Reflect.get(t, key, receiver);
      if (key === "then" || key === "$$typeof" || key === "toJSON") return undefined;
      if (!cache.has(key)) cache.set(key, leafFor(key, style)?.value ?? nested(`${label}.${key}`, style));
      return cache.get(key);
    },
  });
}

/** A function a context exposes (`login`, `setOpen`): does nothing and resolves, so `await` and `.then` both work. */
function fakeFunction(label) {
  const fn = function () {
    return Promise.resolve(undefined);
  };
  Object.defineProperty(fn, "name", { value: label });
  return fn;
}

/**
 * How a family of fakes behaves: what it prints as, and whether values
 * nested in it can be called. A theme's can't — styled-components and
 * emotion call any function in a style rule, and a fake that returns a fake
 * would never end.
 */
const DEFAULT_STYLE = Object.freeze({ primitive: "Preview", callableNested: true });

function nested(label, style) {
  return fakeValue(label, { ...style, callable: style.callableNested });
}

/**
 * A stand-in for a value nobody provided: any property read gives a
 * plausible leaf by its name (see `leafFor`) or another fake, so
 * `ctx.user.name`, `const { login } = ctx` and `state.cart.items.map` all
 * work. `callable` fakes can also be called (an unknown nested key may be a
 * function); the top of a context value is a plain object.
 */
export function fakeValue(label, options = {}) {
  const style = {
    primitive: options.primitive ?? DEFAULT_STYLE.primitive,
    callableNested: options.callableNested ?? DEFAULT_STYLE.callableNested,
  };
  const { primitive } = style;
  const callable = options.callable ?? false;
  const cache = new Map();
  const target = callable ? function () {} : {};
  return new Proxy(target, {
    get(t, key) {
      if (key === Symbol.toPrimitive) return (hint) => (hint === "number" ? 0 : primitive);
      if (key === Symbol.iterator) return function* () {};
      if (key === Symbol.toStringTag) return "Object";
      if (typeof key === "symbol") return undefined;
      // Not a promise, not a React element, not a module.
      if (key === "then" || key === "$$typeof" || key === "__esModule" || key === "_owner" || key === "prototype") return undefined;
      if (key === "toString" || key === "valueOf") return () => primitive;
      if (key === "toJSON") return () => ({});
      if (key === "constructor") return Object;
      if (cache.has(key)) return cache.get(key);
      const leaf = leafFor(key, style);
      const value = leaf ? leaf.value : nested(`${label}.${key}`, style);
      cache.set(key, value);
      return value;
    },
    has(t, key) {
      return typeof key === "string";
    },
    apply() {
      return nested(`${label}()`, style);
    },
    construct() {
      return fakeValue(`new ${label}`, style);
    },
  });
}

/** Props for a provider rendered without the ones it expects: what was given, plus a fake for anything else it reads. */
export function fakeProps(props, label) {
  return new Proxy(props, {
    get(t, key) {
      if (key in t || typeof key === "symbol" || key === "then" || key === "$$typeof") return t[key];
      return leafFor(key)?.value ?? fakeValue(`${label}.${key}`, { callable: true });
    },
  });
}

// ---------------------------------------------------------------------------
// Auth libraries: replaced at bundle time with a signed-in stand-in
// ---------------------------------------------------------------------------

const passChildren = ({ children }) => children ?? null;
const nothing = () => null;
const asyncValue = (value) => async () => value;
const noopAsync = async () => undefined;

function nextAuthCore() {
  const auth = (arg) => (typeof arg === "function" ? arg : Promise.resolve(SESSION));
  const handlers = { GET: noopAsync, POST: noopAsync };
  // v5: `export const { auth, handlers } = NextAuth(config)`; v4: `const handler = NextAuth(options)` is the route handler.
  const NextAuth = () => Object.assign(async () => new Response(null), { auth, handlers, signIn: noopAsync, signOut: noopAsync, unstable_update: asyncValue(SESSION) });
  return { NextAuth, auth, handlers };
}

const CLERK_USER = Object.freeze({
  id: PREVIEW_USER.id,
  firstName: PREVIEW_USER.firstName,
  lastName: PREVIEW_USER.lastName,
  fullName: PREVIEW_USER.fullName,
  username: PREVIEW_USER.username,
  imageUrl: "",
  hasImage: false,
  primaryEmailAddress: { emailAddress: PREVIEW_USER.email },
  emailAddresses: [{ emailAddress: PREVIEW_USER.email }],
  publicMetadata: {},
  unsafeMetadata: {},
});

function clerkClient() {
  const authState = {
    isLoaded: true,
    isSignedIn: true,
    userId: PREVIEW_USER.id,
    sessionId: "preview-session",
    orgId: null,
    orgRole: null,
    getToken: asyncValue("preview-token"),
    signOut: noopAsync,
    has: () => true,
  };
  return {
    useUser: () => ({ isLoaded: true, isSignedIn: true, user: CLERK_USER }),
    useAuth: () => authState,
    useSession: () => ({ isLoaded: true, isSignedIn: true, session: { id: "preview-session", user: CLERK_USER } }),
    useClerk: () => ({ user: CLERK_USER, signOut: noopAsync, openSignIn: noopAsync, openUserProfile: noopAsync, redirectToSignIn: noopAsync }),
    useOrganization: () => ({ isLoaded: true, organization: null, membership: null }),
    useOrganizationList: () => ({ isLoaded: true, userMemberships: { data: [] }, setActive: noopAsync }),
    useSignIn: () => ({ isLoaded: true, signIn: fakeValue("signIn"), setActive: noopAsync }),
    useSignUp: () => ({ isLoaded: true, signUp: fakeValue("signUp"), setActive: noopAsync }),
    ClerkProvider: passChildren,
    ClerkLoaded: passChildren,
    ClerkLoading: nothing,
    SignedIn: passChildren,
    SignedOut: nothing,
    Protect: passChildren,
    RedirectToSignIn: nothing,
    RedirectToSignUp: nothing,
    SignIn: nothing,
    SignUp: nothing,
    SignInButton: passChildren,
    SignUpButton: passChildren,
    SignOutButton: passChildren,
    UserButton: nothing,
    UserProfile: nothing,
    OrganizationSwitcher: nothing,
    // @clerk/nextjs/server
    auth: Object.assign(async () => ({ ...authState, protect: noopAsync, redirectToSignIn: noopAsync }), { protect: noopAsync }),
    currentUser: asyncValue(CLERK_USER),
    clerkMiddleware: (handler) => handler ?? (() => undefined),
    createRouteMatcher: () => () => false,
    authMiddleware: () => () => undefined,
  };
}

function auth0Client() {
  const getSession = asyncValue({ user: PREVIEW_USER, accessToken: "preview-token" });
  return {
    useUser: () => ({ user: PREVIEW_USER, isLoading: false, error: undefined, checkSession: noopAsync }),
    useAuth0: () => ({
      user: PREVIEW_USER,
      isAuthenticated: true,
      isLoading: false,
      error: undefined,
      loginWithRedirect: noopAsync,
      loginWithPopup: noopAsync,
      logout: noopAsync,
      getAccessTokenSilently: asyncValue("preview-token"),
    }),
    UserProvider: passChildren,
    Auth0Provider: passChildren,
    withAuthenticationRequired: (component) => component,
    withPageAuthRequired: (arg) => (typeof arg === "function" ? arg : async () => ({ props: { user: PREVIEW_USER } })),
    withApiAuthRequired: (handler) => handler,
    getSession,
    getAccessToken: asyncValue({ accessToken: "preview-token" }),
    // v4: `export const auth0 = new Auth0Client()`, then `auth0.getSession()`.
    Auth0Client: class Auth0Client {
      getSession = getSession;
      getAccessToken = asyncValue({ token: "preview-token" });
      middleware = async () => undefined;
    },
  };
}

/** Auth packages a preview replaces, by import specifier, and what stands in for them. */
const AUTH_MODULES = {
  "next-auth/react": () => ({
    useSession: () => ({ data: SESSION, status: "authenticated", update: asyncValue(SESSION) }),
    SessionProvider: passChildren,
    signIn: noopAsync,
    signOut: noopAsync,
    getSession: asyncValue(SESSION),
    getCsrfToken: asyncValue("preview-csrf"),
    getProviders: asyncValue({}),
  }),
  "next-auth": () => {
    const core = nextAuthCore();
    return { default: core.NextAuth, getServerSession: asyncValue(SESSION), auth: core.auth, handlers: core.handlers };
  },
  "next-auth/next": () => ({ default: nextAuthCore().NextAuth, getServerSession: asyncValue(SESSION) }),
  "next-auth/jwt": () => ({ getToken: asyncValue({ sub: PREVIEW_USER.id, name: PREVIEW_USER.name, email: PREVIEW_USER.email }) }),
  "next-auth/middleware": () => ({ default: (arg) => (typeof arg === "function" ? arg : () => undefined), withAuth: (arg) => (typeof arg === "function" ? arg : () => undefined) }),
  "@clerk/nextjs": clerkClient,
  "@clerk/nextjs/server": clerkClient,
  "@clerk/clerk-react": clerkClient,
  "@clerk/react": clerkClient,
  "@auth0/nextjs-auth0": auth0Client,
  "@auth0/nextjs-auth0/client": auth0Client,
  "@auth0/nextjs-auth0/server": auth0Client,
  "@auth0/auth0-react": auth0Client,
};

/** The library a replaced specifier belongs to, for the preview's note. */
function authLibrary(specifier) {
  if (specifier.startsWith("next-auth")) return "next-auth";
  if (specifier.startsWith("@clerk/")) return "Clerk";
  return "Auth0";
}

export function isAuthModule(specifier) {
  return Object.hasOwn(AUTH_MODULES, specifier);
}

/** The stand-in module's exports: the known ones, plus a fake for any other name the importer asks for. */
export function authExports(specifier) {
  used.add(`signed in as ${PREVIEW_USER.name} (${authLibrary(specifier)})`);
  const known = AUTH_MODULES[specifier]();
  return new Proxy(known, {
    get(t, key) {
      if (key in t || typeof key === "symbol") return t[key];
      return fakeValue(`${specifier}.${String(key)}`, { callable: true });
    },
  });
}

/** ESM source for a replaced auth module, exporting `names` (what its importer pulls in) and a default. */
export function authModuleSource(specifier, names) {
  const lines = [`const m = globalThis.__graphreviewFakes.authExports(${JSON.stringify(specifier)});`, "export default m.default ?? m;"];
  // The known names too, so `export * from` and namespace imports see them.
  const all = new Set([...names, ...Object.keys(AUTH_MODULES[specifier]())]);
  for (const name of all) {
    if (name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name)) lines.push(`export const ${name} = m[${JSON.stringify(name)}];`);
  }
  return lines.join("\n");
}
