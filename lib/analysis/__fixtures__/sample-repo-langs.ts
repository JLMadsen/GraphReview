/**
 * A small Go + Java + Rust repo used to exercise the v2 language analyzers end
 * to end (see `smoke-test-langs.ts`).
 *
 * Like `sample-repo.ts` it is kept as data (path -> contents) and materialized
 * into a temp directory on demand: the sources are deliberately broken/partial
 * (syntax-error files, imports of things that do not exist), so checking them in
 * as real `.go`/`.java`/`.rs` files would put them in the project's tooling scope.
 *
 * Layout:
 *   gosvc/      Go module `example.com/svc` + a nested module `example.org/gen`
 *   javaapp/    Maven-style layout: two modules, main + test source sets
 *   rustcrate/  crate `my-app` (lib + bin + integration tests) + a workspace crate
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;

const GO_FILES: Record<string, string> = {
  "gosvc/go.mod": lines(
    "module example.com/svc // the service",
    "",
    "go 1.21",
    "",
    "require (",
    "\tgithub.com/gin-gonic/gin v1.9.1",
    "\tgithub.com/lib/pq v1.10.9",
    "\tgolang.org/x/sync v0.5.0 // indirect",
    "\tgopkg.in/yaml.v3 v3.0.1",
    ")",
  ),

  "gosvc/main.go": lines(
    "package main",
    "",
    '// import "example.com/svc/internal/secret"',
    'import "fmt"',
    "import (",
    '\t"net/http"',
    '\t"os"',
    '\tstore "example.com/svc/internal/store"',
    '\t. "strings"',
    '\t_ "github.com/lib/pq"',
    '\t"github.com/gin-gonic/gin"',
    '\t"github.com/gin-gonic/gin/binding"',
    '\t"example.com/svc/pkg/util"',
    '\t"example.com/svc/missing/pkg"',
    "\t`example.org/gen`",
    ")",
    'import "C"',
    "",
    'var note = "import \\"example.com/svc/internal/secret\\""',
    "",
    "func main() {",
    "\tfmt.Println(store.Name, util.Name, note, gin.Version, binding.JSON, http.StatusOK, os.Args, ToUpper(\"x\"))",
    "}",
  ),

  "gosvc/cmd/tool/main.go": lines(
    "package main",
    "",
    "import (",
    '\t"example.com/svc/internal/store"',
    '\t"example.org/gen/internal/emit"',
    ")",
    "",
    "func main() { _ = store.Name; _ = emit.X }",
  ),

  "gosvc/internal/store/store.go": lines(
    "package store",
    "",
    'import "example.com/svc/pkg/util"',
    "",
    "var Name = util.Name",
  ),
  "gosvc/internal/store/store_memory.go": lines("package store", "", "var mem = map[string]string{}"),
  // Test files are analysed as importers but are never link targets.
  "gosvc/internal/store/store_test.go": lines(
    "package store",
    "",
    "import (",
    '\t"testing"',
    '\t"example.com/svc/pkg/util"',
    ")",
    "",
    "func TestName(t *testing.T) { _ = util.Name }",
  ),

  "gosvc/pkg/util/util.go": lines(
    "package util",
    "",
    "import (",
    '\t"encoding/json"',
    '\t"golang.org/x/sync/errgroup"',
    '\t"gopkg.in/yaml.v3"',
    '\t"go.uber.org/zap/zapcore"',
    '\t"github.com/spf13/cobra/doc"',
    ")",
    "",
    'var Name = "util"',
  ),
  "gosvc/pkg/util/strings.go": lines("package util", "", "func Up(s string) string { return s }"),
  // An empty file is still a node.
  "gosvc/internal/empty/empty.go": "",

  // A nested module with an unrelated module path: only the nearest go.mod's
  // `module` line explains what `example.org/gen/...` means.
  "gosvc/tools/gen/go.mod": lines("module example.org/gen", "", "go 1.21"),
  "gosvc/tools/gen/gen.go": lines(
    "package gen",
    "",
    'import "example.com/svc/pkg/util"',
    "",
    "var X = util.Name",
  ),
  "gosvc/tools/gen/internal/emit/emit.go": lines("package emit", "", "var X = 1"),

  // Syntax error: must not fail the run; the file is still a node.
  "gosvc/internal/broken/broken.go": lines(
    "package broken",
    "",
    "import (",
    '\t"os',
    '\t"example.com/svc/pkg/util',
    "func ( {{{",
  ),

  // vendor/ is skipped by the walker.
  "gosvc/vendor/github.com/gin-gonic/gin/gin.go": lines(
    "package gin",
    "",
    'import "example.com/svc/pkg/util"',
  ),
};

const JAVA_MAIN = "javaapp/core/src/main/java/com/acme";
const JAVA_TEST = "javaapp/core/src/test/java/com/acme";

const JAVA_FILES: Record<string, string> = {
  [`${JAVA_MAIN}/app/Main.java`]: lines(
    "package com.acme.app;",
    "",
    "// import com.acme.secret.Hidden;",
    "/* import com.acme.secret.Block; */",
    "import java.util.List;",
    "import java.util.concurrent.atomic.AtomicInteger;",
    "import com.acme.model.User;",
    "import com.acme.model.Outer.Inner;",
    "import com.acme.util.*;",
    "import static com.acme.util.Strings.capitalize;",
    "import static com.acme.util.Numbers.*;",
    "import com.acme.cfg.Settings;",
    "import com.acme.gen.Generated;",
    "import org.springframework.boot.SpringApplication;",
    "import org.springframework.web.bind.annotation.GetMapping;",
    "import static org.junit.Assert.assertEquals;",
    "import com.google.common.collect.ImmutableList;",
    "import javax.inject.Inject;",
    "import lombok.Data;",
    "",
    "public class Main {",
    '  String s = "import com.acme.secret.InString;";',
    "}",
  ),
  [`${JAVA_MAIN}/model/User.java`]: lines("package com.acme.model;", "", "public class User {}"),
  [`${JAVA_MAIN}/model/Outer.java`]: lines(
    "package com.acme.model;",
    "",
    "public class Outer { public static class Inner {} }",
  ),
  [`${JAVA_MAIN}/model/package-info.java`]: lines("package com.acme.model;"),
  [`${JAVA_MAIN}/util/Strings.java`]: lines(
    "package com.acme.util;",
    "",
    "import com.acme.model.User;",
    "",
    "public class Strings { static String capitalize(String s) { return s; } }",
  ),
  [`${JAVA_MAIN}/util/Numbers.java`]: lines("package com.acme.util;", "", "public class Numbers {}"),
  [`${JAVA_MAIN}/util/package-info.java`]: lines("package com.acme.util;"),
  [`${JAVA_MAIN}/cfg/Settings.java`]: lines("package com.acme.cfg;", "", "public class Settings {}"),

  // Same class in the test source set: the importing file's own source set wins.
  [`${JAVA_TEST}/cfg/Settings.java`]: lines("package com.acme.cfg;", "", "public class Settings {}"),
  [`${JAVA_TEST}/app/MainTest.java`]: lines(
    "package com.acme.app;",
    "",
    "import com.acme.app.Main;",
    "import com.acme.cfg.Settings;",
    "import com.acme.model.*;",
    "import org.junit.Test;",
    "import static org.junit.Assert.*;",
    "",
    "public class MainTest {}",
  ),

  // A second Maven module importing across modules.
  "javaapp/client/src/main/java/com/acme/client/Client.java": lines(
    "package com.acme.client;",
    "",
    "import com.acme.model.User;",
    "import com.acme.util.Strings;",
    "import com.acme.client.internal.Http;",
    "",
    "public class Client {}",
  ),
  "javaapp/client/src/main/java/com/acme/client/internal/Http.java": lines(
    "package com.acme.client.internal;",
    "",
    "public class Http {}",
  ),

  // Empty file, and a syntax error: both must be tolerated.
  [`${JAVA_MAIN}/Empty.java`]: "",
  [`${JAVA_MAIN}/Broken.java`]: lines(
    "package com.acme;",
    "",
    "import com.acme.model.;",
    "import static ;",
    "public class {{{ (",
  ),
};

const RUST_FILES: Record<string, string> = {
  "rustcrate/Cargo.toml": lines(
    "[package]",
    'name = "my-app"',
    'version = "0.1.0"',
    "",
    "[dependencies]",
    'serde = { version = "1", features = ["derive"] } # derive macros',
    'serde_json = "1"',
    "tokio.workspace = true",
    'anyhow = "1"',
    'clap = "4"',
    'helper-lib = { path = "crates/helper" }',
    "",
    "[dependencies.reqwest]",
    'version = "0.11"',
    "",
    "[dev-dependencies]",
    'pretty_assertions = "1"',
  ),

  "rustcrate/src/lib.rs": lines(
    "//! crate root",
    "// mod ghost;",
    "pub mod config;",
    "pub mod net;",
    "mod util;",
    '#[path = "legacy/old_impl.rs"]',
    "#[cfg(unix)]",
    "mod legacy;",
    "mod missing;",
    "mod inline_only { pub fn f() {} }",
    "extern crate serde;",
    "extern crate helper_lib;",
    "use std::collections::HashMap;",
    "use serde::{Deserialize, Serialize};",
    "use crate::config::Settings;",
    "pub use net::{client::Client, server};",
    'const NOTE: &str = "use fake::crate_in_string; mod not_a_module;";',
    "pub type Result<T> = std::result::Result<T, String>;",
  ),

  "rustcrate/src/config.rs": lines(
    "use super::util::helper;",
    "use crate::net::client::Client;",
    "use std::{fs, io::{self, Read}};",
    "use serde_json::Value;",
    "",
    "pub struct Settings;",
    "",
    "#[cfg(test)]",
    "mod tests;",
    "",
    "mod inline_tests {",
    "    use super::*;",
    "    use super::Settings;",
    "    use pretty_assertions::assert_eq;",
    "}",
  ),
  "rustcrate/src/config/tests.rs": lines("use super::Settings;", "use crate::util::*;"),

  "rustcrate/src/util.rs": lines(
    "pub mod inner;",
    "use crate::config::*;",
    "pub fn helper() {}",
  ),
  "rustcrate/src/util/inner.rs": lines(
    "use super::helper;",
    "use super::super::config::Settings;",
    "use crate::net::server::Server;",
  ),

  "rustcrate/src/net/mod.rs": lines(
    "pub mod client;",
    "pub mod server;",
    "use crate::config::Settings;",
  ),
  "rustcrate/src/net/client.rs": lines(
    "use super::server::Server;",
    "use reqwest::Client as Http;",
  ),
  "rustcrate/src/net/server.rs": lines(
    "use crate::Result;",
    "use tokio::net::TcpListener;",
    "use anyhow::Result as R;",
    "pub struct Server;",
  ),

  "rustcrate/src/legacy/old_impl.rs": lines("use crate::config::Settings;"),

  "rustcrate/src/main.rs": lines(
    "mod cli;",
    "use my_app::config::Settings;",
    "use cli::Args;",
    "use clap::Parser;",
    "use helper_lib::h;",
    "enum Mode { A, B }",
    "use Mode::A;",
    "fn main() {}",
  ),
  "rustcrate/src/cli.rs": lines("use super::Mode;", "use clap::Parser;"),

  "rustcrate/tests/integration.rs": lines(
    "mod common;",
    "use common::setup;",
    "use my_app::net::client::Client;",
    "use pretty_assertions::assert_eq;",
  ),
  "rustcrate/tests/common/mod.rs": lines("use my_app::config::Settings;"),

  "rustcrate/crates/helper/Cargo.toml": lines(
    "[package]",
    'name = "helper-lib"',
    'version = "0.1.0"',
    "",
    "[dependencies]",
    'rand = "0.8"',
  ),
  "rustcrate/crates/helper/src/lib.rs": lines("pub mod deep;", "pub fn h() {}"),
  "rustcrate/crates/helper/src/deep.rs": lines("use crate::h;", "use rand::Rng;"),

  // Empty file, and a syntax error: both must be tolerated.
  "rustcrate/src/empty.rs": "",
  "rustcrate/src/broken.rs": lines("fn ( {{{", "mod ;", "use ;", "}}}"),
};

export const SAMPLE_LANGS_REPO_FILES: Record<string, string> = {
  ...GO_FILES,
  ...JAVA_FILES,
  ...RUST_FILES,
};

/** Write {@link SAMPLE_LANGS_REPO_FILES} under `rootDir` (created fresh). */
export async function materializeSampleLangsRepo(rootDir: string): Promise<void> {
  await rm(rootDir, { recursive: true, force: true });
  for (const [relative, contents] of Object.entries(SAMPLE_LANGS_REPO_FILES)) {
    const absolute = path.join(rootDir, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
}
