/**
 * Checks for the preview's stand-in values (lib/preview/harness/preview-fakes.mjs):
 * what a component reading an unprovided context or a replaced auth library gets.
 *
 *   npx tsx lib/preview/smoke-test-preview-fakes.ts
 */
import * as fakes from "./harness/preview-fakes.mjs";

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

console.log("context stand-ins");
const ctx: Any = fakes.fakeValue("AuthContext");
check("user.name is the preview user", ctx.user.name === "Preview User", ctx.user.name);
check("user.email is plainly fake", ctx.user.email === "preview@example.com");
check("signed in", ctx.isAuthenticated === true && ctx.isLoggedIn === true && ctx.status === "authenticated");
check("not loading, no error", ctx.isLoading === false && ctx.loading === false && ctx.error === null);
check("functions can be called and awaited", typeof ctx.login === "function" && ctx.login() instanceof Promise && typeof ctx.setOpen === "function");
check("update is a function, not a date", typeof ctx.update === "function");
check("lists are empty arrays", Array.isArray(ctx.items) && ctx.notifications.length === 0 && Array.isArray(ctx.roleIds));
check("settings stays an object", !Array.isArray(ctx.settings) && typeof ctx.settings.theme === "string");
check("ids look like ids", ctx.userId === "preview-id" && ctx.id === "preview-id");
check("chat isn't a date", typeof ctx.chat !== "string");
check("dates are ISO strings", typeof ctx.createdAt === "string" && !Number.isNaN(Date.parse(ctx.createdAt)));
check("counts are numbers", ctx.count === 0 && ctx.total === 0);
check("deep reads never throw", typeof `${ctx.workspace.owner.plan.title}` === "string");
check("unknown values print as text", `${ctx.workspace.plan}` === "Preview");
check("a context value is an object, not a function", typeof ctx === "object");
check("destructuring works", (({ user, logout }: Any) => user.firstName === "Preview" && typeof logout === "function")(ctx));
check("not a promise", ctx.then === undefined && ctx.workspace.then === undefined);
check("not a React element", ctx.$$typeof === undefined);
check("`in` checks pass", "user" in ctx && "anything" in ctx);
check("JSON-safe", JSON.stringify({ ctx }) === '{"ctx":{}}');
check("spreads to nothing surprising", Object.keys({ ...ctx }).length === 0);
check("the same key gives the same value", ctx.workspace === ctx.workspace);

console.log("provider props");
const props: Any = fakes.fakeProps({ children: "kids" }, "AuthProvider");
check("given props pass through", props.children === "kids");
check("missing props get stand-ins", props.session.user.name === "Preview User" && props.initialUser.email === "preview@example.com");

console.log("theme");
const theme: Any = fakes.fakeValue("theme", { primitive: "inherit", callableNested: false });
check("theme values print as inherit", `${theme.colors.primary}` === "inherit");
check("nothing in a theme is callable (style rules call functions)", typeof theme.colors.primary !== "function" && typeof theme.spacing.md !== "function");

console.log("auth modules");
check("next-auth/react is replaced", fakes.isAuthModule("next-auth/react") && fakes.isAuthModule("@clerk/nextjs/server"));
check("other packages are not", !fakes.isAuthModule("react") && !fakes.isAuthModule("next-auth-extra"));
const nextAuth: Any = fakes.authExports("next-auth/react");
const session = nextAuth.useSession();
check("useSession is signed in", session.status === "authenticated" && session.data.user.name === "Preview User");
check("unknown exports are stand-ins, not undefined", nextAuth.SomethingNew !== undefined);
const nextAuthRoot: Any = fakes.authExports("next-auth");
const configured = nextAuthRoot.default({ providers: [] });
check("NextAuth(config) gives auth and handlers", typeof configured.auth === "function" && typeof configured.handlers.GET === "function");
const middleware = () => "next";
check("auth(fn) wraps middleware", configured.auth(middleware) === middleware);
const clerk: Any = fakes.authExports("@clerk/nextjs");
check("Clerk's useUser is signed in", clerk.useUser().isSignedIn === true && clerk.useUser().user.fullName === "Preview User");
check("SignedOut renders nothing, SignedIn its children", clerk.SignedOut({ children: "x" }) === null && clerk.SignedIn({ children: "x" }) === "x");
const auth0: Any = fakes.authExports("@auth0/nextjs-auth0/client");
check("Auth0's useUser has the user", auth0.useUser().user.email === "preview@example.com");
const source = fakes.authModuleSource("next-auth/react", ["useSession", "type"]);
check("module source exports the asked-for and known names", /export const useSession/.test(source) && /export const signOut/.test(source) && /export default/.test(source));
check("the note says who is signed in", [...fakes.used].some((u) => u.includes("Preview User") && u.includes("next-auth")));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
