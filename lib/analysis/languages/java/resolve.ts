/**
 * Java import resolution.
 *
 * Java and Kotlin share one resolver - a fully-qualified-name -> file index built
 * from each file's `declares` - so a Java file can import a Kotlin class and vice
 * versa. See `../jvm/resolve.ts` for the rules; this module only gives the Java
 * analyzer its usual entry points.
 */
export {
  indexJvmDeclarations as indexJavaDeclarations,
  jvmExternalPackage as javaExternalPackage,
  prepareJvm as prepareJava,
  resolveJvmImportPaths as resolveJavaImportPaths,
} from "../jvm/resolve";
