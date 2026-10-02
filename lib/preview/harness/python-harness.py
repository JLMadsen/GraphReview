# GraphReview before/after preview: the Python side of the sandbox (DESIGN.md §6.9).
#
# Runs INSIDE a throwaway container, once per side (base or head), the same
# way node-harness.mjs does: the repo at that commit is in /src, the job spec
# in /job/spec.json, and the repo's own dependencies (if any could be
# installed) in /deps. Each requested function is called on every case with
# a deep copy of its arguments; the result is one JSON line on stdout after
# RESULT_MARKER. repr() is the comparison format, so 2 vs 2.0 shows up.

import contextlib
import copy
import importlib
import importlib.util
import io
import json
import os
import signal
import sys
import time
import traceback

RESULT_MARKER = "@@GRAPHREVIEW_PREVIEW_RESULT@@"
MAX_REPR = 4000
MAX_LOG_CHARS = 4000

with open("/job/spec.json", encoding="utf-8") as fh:
    SPEC = json.load(fh)

REAL_STDOUT = sys.stdout


def emit(result):
    REAL_STDOUT.write(RESULT_MARKER + json.dumps(result) + "\n")
    REAL_STDOUT.flush()


def clip(text):
    return text if len(text) <= MAX_REPR else text[:MAX_REPR] + "…"


def safe_repr(value):
    try:
        return clip(repr(value))
    except Exception as error:  # noqa: BLE001 — a broken __repr__ is the user's code
        return f"<unrepresentable {type(value).__name__}: {error}>"


def error_text(error):
    return f"{type(error).__name__}: {error}"


def revive(value):
    """Tagged JSON objects stand in for values JSON can't express."""
    if isinstance(value, list):
        return [revive(v) for v in value]
    if isinstance(value, dict):
        if len(value) == 1:
            (key, inner), = value.items()
            if key == "$tuple":
                return tuple(revive(v) for v in inner)
            if key == "$set":
                return set(revive(v) for v in inner)
            if key == "$bytes":
                return inner.encode("utf-8")
            if key == "$none" or key == "$undefined":
                return None
        return {k: revive(v) for k, v in value.items()}
    return value


class CaseTimeout(Exception):
    pass


def on_alarm(signum, frame):  # noqa: ARG001
    raise CaseTimeout(f"did not finish within {SPEC['caseTimeoutMs']} ms")


signal.signal(signal.SIGALRM, on_alarm)


def module_name_for(rel_path):
    parts = rel_path[:-3].split("/") if rel_path.endswith(".py") else rel_path.split("/")
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def load_module():
    rel = SPEC["file"]
    project = os.path.join("/src", SPEC.get("projectRoot") or ".")
    for extra in ["/deps", project, os.path.join(project, "src"), "/src", os.path.dirname(os.path.join("/src", rel))]:
        if os.path.isdir(extra) and extra not in sys.path:
            sys.path.insert(0, extra)
    os.chdir(project)

    # Import by dotted name relative to the deepest sys.path root that holds
    # the file, so relative imports inside the package work.
    absolute = os.path.join("/src", rel)
    roots = sorted((p for p in sys.path if p and absolute.startswith(p.rstrip("/") + "/")), key=len, reverse=True)
    for root in roots:
        dotted = module_name_for(os.path.relpath(absolute, root).replace(os.sep, "/"))
        if not dotted or "-" in dotted:
            continue
        try:
            return importlib.import_module(dotted)
        except ModuleNotFoundError as error:
            if error.name and dotted.startswith(error.name):
                continue
            raise
    spec = importlib.util.spec_from_file_location("graphreview_target", absolute)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_case(fn, case):
    raw = case.get("input") or {}
    args = revive(raw.get("args") or [])
    kwargs = revive(raw.get("kwargs") or {})
    args = copy.deepcopy(args)
    kwargs = copy.deepcopy(kwargs)
    def describe_args():
        return safe_repr(list(args) if not kwargs else {"args": list(args), "kwargs": kwargs})

    # Recorded so the UI can tell whether the call changed its own arguments.
    outcome = {"label": case.get("label", ""), "argsBefore": describe_args()}
    logs = io.StringIO()
    started = time.monotonic()
    signal.setitimer(signal.ITIMER_REAL, SPEC["caseTimeoutMs"] / 1000)
    try:
        with contextlib.redirect_stdout(logs), contextlib.redirect_stderr(logs):
            value = fn(*args, **kwargs)
            if hasattr(value, "__await__"):
                import asyncio

                value = asyncio.run(value) if asyncio.iscoroutine(value) else value
        outcome["returned"] = safe_repr(value)
    except CaseTimeout as error:
        outcome["threw"] = f"Timeout: {error}"
    except BaseException as error:  # noqa: BLE001 — SystemExit etc. are results too
        outcome["threw"] = error_text(error)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    outcome["argsAfter"] = describe_args()
    outcome["durationMs"] = int((time.monotonic() - started) * 1000)
    text = logs.getvalue()[:MAX_LOG_CHARS]
    outcome["logs"] = [line for line in text.splitlines() if line.strip()][:40]
    return outcome


def main():
    result = {"side": SPEC["side"], "symbols": [], "stubbedModules": [], "warnings": [], "css": ""}
    try:
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            module = load_module()
        if captured.getvalue().strip():
            result["warnings"].append("on import: " + captured.getvalue().strip()[:500])
    except ModuleNotFoundError as error:
        result["fatal"] = f"Could not import {SPEC['file']}: missing module '{error.name}'"
        emit(result)
        return
    except BaseException as error:  # noqa: BLE001
        result["fatal"] = f"Could not import {SPEC['file']}: {error_text(error)}"
        result["warnings"].append(traceback.format_exc()[-800:])
        emit(result)
        return

    for symbol in SPEC["symbols"]:
        entry = {"name": symbol["name"], "kind": symbol["kind"]}
        target = module
        for part in symbol["name"].split("."):
            target = getattr(target, part, None)
            if target is None:
                break
        if target is None:
            entry["error"] = f"'{symbol['name']}' was not found in {SPEC['file']}."
        elif isinstance(target, type):
            entry["error"] = f"'{symbol['name']}' is a class; only plain functions are run."
        elif not callable(target):
            entry["error"] = f"'{symbol['name']}' is a {type(target).__name__}, not a function."
        else:
            entry["cases"] = [run_case(target, case) for case in symbol["cases"]]
        result["symbols"].append(entry)
    emit(result)


try:
    main()
except BaseException as error:  # noqa: BLE001
    emit({"side": SPEC.get("side"), "symbols": [], "fatal": error_text(error), "warnings": []})
os._exit(0)
