/**
 * A small Gradle multi-module Java + Kotlin repo used to exercise the shared JVM
 * resolver end to end (see `smoke-test-jvm.ts`).
 *
 * Like `sample-repo.ts` / `sample-repo-langs.ts` it is kept as data (path ->
 * contents) and materialized into a temp directory on demand.
 *
 * Layout (`src/main/java` + `src/main/kotlin` siblings, two Gradle modules):
 *   jvmapp/settings.gradle.kts, build.gradle.kts   root Gradle scripts (.kts, tolerated)
 *   jvmapp/core/       module with both `src/main/java` and `src/main/kotlin`, plus
 *                      `src/test/java` (own source set wins over main for a same
 *                      name; a plain lookup crosses source sets when only one
 *                      source set declares that name)
 *   jvmapp/client/     a second module depending on `core` (cross-module,
 *                      cross-language resolution in both directions)
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;

const CORE_JAVA = "jvmapp/core/src/main/java/com/acme";
const CORE_KOTLIN = "jvmapp/core/src/main/kotlin/com/acme";
const CORE_TEST = "jvmapp/core/src/test/java/com/acme";
const CLIENT_KOTLIN = "jvmapp/client/src/main/kotlin/com/acme/client";

const JVM_FILES: Record<string, string> = {
  // --- Gradle scripts (.kts): tolerated, and never pollute declarations. ---
  "jvmapp/settings.gradle.kts": lines(
    'rootProject.name = "jvmapp"',
    'include(":core", ":client")',
  ),
  "jvmapp/build.gradle.kts": lines(
    "plugins {",
    '    kotlin("jvm") version "1.9.22" apply false',
    "}",
  ),
  "jvmapp/core/build.gradle.kts": lines(
    "plugins {",
    '    id("java")',
    '    kotlin("jvm")',
    "}",
    "",
    "dependencies {",
    '    implementation("org.jetbrains.kotlin:kotlin-stdlib")',
    "}",
    "",
    "// import fake.ThisIsNotReal - build-script comments are not code either",
  ),
  "jvmapp/client/build.gradle.kts": lines(
    "plugins { id(\"java\"); kotlin(\"jvm\") }",
    "dependencies { implementation(project(\":core\")) }",
  ),

  // --- core: Java main source set ---
  [`${CORE_JAVA}/model/User.java`]: lines(
    "package com.acme.model;",
    "",
    "public class User {",
    "    public String name;",
    "}",
  ),
  [`${CORE_JAVA}/model/Outer.java`]: lines(
    "package com.acme.model;",
    "",
    "public class Outer {",
    "    public static class Inner {}",
    "}",
  ),
  [`${CORE_JAVA}/app/JavaCaller.java`]: lines(
    "package com.acme.app;",
    "",
    "// import com.acme.secret.Hidden; - comment, must be ignored",
    "import com.acme.util.StringsKt;",
    "import com.acme.util.NumbersKt;",
    "import com.acme.model.User;",
    "",
    "public class JavaCaller {",
    "    public static void call() {",
    "        User u = new User();",
    '        String note = "import com.acme.secret.InString;";',
    "        System.out.println(StringsKt.capitalize(u.name) + note);",
    "        System.out.println(NumbersKt.triple(2));",
    "        Launcher l = new Launcher();  // same-package Kotlin class, no import needed",
    "        Config c = new Config(true);  // same-package Kotlin data class, no import needed",
    "    }",
    "}",
  ),
  [`${CORE_JAVA}/app/WildcardUser.java`]: lines(
    "package com.acme.app;",
    "",
    "import com.acme.model.*;",
    "",
    "public class WildcardUser {",
    "    public User u;",
    "    public Outer.Inner nested;",
    "}",
  ),
  [`${CORE_JAVA}/broken/Broken.java`]: lines(
    "package com.acme.broken;",
    "",
    "import com.acme.model.;",
    "import static ;",
    "public class {{{ (",
  ),

  // --- core: Kotlin main source set ---
  [`${CORE_KOTLIN}/util/Strings.kt`]: lines(
    "package com.acme.util",
    "",
    "import com.acme.model.User",
    "",
    "// import fake.ShouldBeIgnored - line comment",
    "/* import also.fake.Ignored - block comment */",
    "",
    "typealias Name = String",
    "",
    "fun capitalize(s: String): String = s.uppercase()",
    "",
    "object Strings {",
    '    fun greet(u: User): String = "Hello, ${capitalize(u.name)}"',
    "}",
  ),
  [`${CORE_KOTLIN}/util/Numbers.kt`]: lines(
    "package com.acme.util",
    "",
    "object Numbers {",
    "    const val ZERO = 0",
    "}",
    "",
    "fun triple(n: Int) = n * 3",
  ),
  [`${CORE_KOTLIN}/util/Empty.kt`]: "",
  [`${CORE_KOTLIN}/app/Shapes.kt`]: lines(
    "package com.acme.app",
    "",
    "sealed class Shape {",
    "    object Circle : Shape()",
    "    data class Rect(val w: Int, val h: Int) : Shape()",
    "}",
    "",
    "enum class Color { RED, GREEN, BLUE }",
    "",
    "interface Named { fun name(): String }",
  ),
  [`${CORE_KOTLIN}/app/App.kt`]: lines(
    "package com.acme.app",
    "",
    "import com.acme.util.Strings as S",
    "import com.acme.util.*",
    "import com.acme.model.User",
    "",
    "data class Config(val debug: Boolean)",
    "",
    "class Launcher {",
    "    companion object Factory {",
    "        fun create() = Launcher()",
    "    }",
    "",
    "    fun run(u: User) {",
    "        println(S.greet(u))",
    "        println(triple(Numbers.ZERO))",
    "        val shape: Shape = Shape.Circle  // same-package reference, no import",
    "    }",
    "}",
    "",
    "fun main() {",
    "    val l = Launcher()",
    "    l.run(User())",
    "}",
  ),
  [`${CORE_KOTLIN}/broken/Broken.kt`]: lines(
    "package com.acme.broken",
    "",
    "import com.acme.model.",
    "class {{{ (",
    "fun broken(",
  ),

  // --- core: Java test source set (own source set, but crosses to main for a
  //     name only the main source set declares). ---
  [`${CORE_TEST}/app/JavaCallerTest.java`]: lines(
    "package com.acme.app;",
    "",
    "import org.junit.jupiter.api.Test;",
    "import com.acme.model.User;",
    "",
    "public class JavaCallerTest {",
    "    @Test",
    "    void test() {",
    "        User u = new User();",
    "        JavaCaller.call();  // same-package reference into the main source set",
    "    }",
    "}",
  ),

  // --- client module: depends on core; cross-module, cross-language both ways. ---
  [`${CLIENT_KOTLIN}/Client.kt`]: lines(
    "package com.acme.client",
    "",
    "import com.acme.model.User",
    "import com.acme.app.Launcher",
    "",
    "class Client {",
    "    fun connect(): User {",
    "        val l = Launcher()",
    "        return User()",
    "    }",
    "}",
  ),
};

export const SAMPLE_JVM_REPO_FILES: Record<string, string> = { ...JVM_FILES };

/** Write {@link SAMPLE_JVM_REPO_FILES} under `rootDir` (created fresh). */
export async function materializeSampleJvmRepo(rootDir: string): Promise<void> {
  await rm(rootDir, { recursive: true, force: true });
  for (const [relative, contents] of Object.entries(SAMPLE_JVM_REPO_FILES)) {
    const absolute = path.join(rootDir, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents, "utf8");
  }
}
