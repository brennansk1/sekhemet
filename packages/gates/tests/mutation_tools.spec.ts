import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PROGRAM_ALLOWLIST, resolveProgram } from "@sekhemet/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MutationToolId, mutationToolFor, runMutationTool } from "../src/mutation_tools.js";

// GT-N5-2 (DEC-44): mutmut, cargo-mutants and PIT run as confined subprocesses
// scoped to the diff when installed. None is installed here, so each tool is a
// fake program that writes that tool's real report format, run through the
// real confinement (Seatbelt) like the scanners (scanners_unavailable.spec.ts).

describe("mutationToolFor", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mt-for-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("maps each language to its tool", () => {
    expect(mutationToolFor("src/a.py")).toEqual({ tool: "mutmut", programs: ["mutmut"] });
    expect(mutationToolFor("src/lib.rs")).toEqual({
      tool: "cargo-mutants",
      programs: ["cargo-mutants"],
    });
    expect(mutationToolFor("src/a.ts")).toBeUndefined();
    expect(mutationToolFor("README.md")).toBeUndefined();
  });

  it("picks mvn or gradle for Java and Kotlin by the project's build file", () => {
    expect(mutationToolFor("src/main/java/A.java")).toEqual({
      tool: "pit",
      programs: ["mvn", "gradle"],
    });
    writeFileSync(join(root, "pom.xml"), "<project/>");
    expect(mutationToolFor("src/main/java/A.java", root)).toEqual({
      tool: "pit",
      programs: ["mvn"],
    });
    rmSync(join(root, "pom.xml"));
    writeFileSync(join(root, "build.gradle.kts"), "");
    expect(mutationToolFor("src/main/kotlin/A.kt", root)).toEqual({
      tool: "pit",
      programs: ["gradle"],
    });
    rmSync(join(root, "build.gradle.kts"));
    writeFileSync(join(root, "build.gradle"), "");
    expect(mutationToolFor("src/main/java/A.java", root)).toEqual({
      tool: "pit",
      programs: ["gradle"],
    });
    rmSync(join(root, "build.gradle"));
    expect(mutationToolFor("src/main/java/A.java", root)).toBeUndefined();
  });
});

describe.runIf(platform() === "darwin")("runMutationTool with fake tools (GT-N5-2)", () => {
  let root: string;
  let bin: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mt-root-"));
    bin = mkdtempSync(join(tmpdir(), "mt-bin-"));
  });
  afterEach(() => {
    for (const d of [root, bin]) rmSync(d, { recursive: true, force: true });
  });

  function script(name: string, body: string): string {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  // ---- mutmut ----------------------------------------------------------------

  // `mutmut junitxml` (junit_xml library): one testcase per mutant with file
  // and line; failure = bad_survived, error = bad_timeout, skipped = untested.
  const mutmutXml = `<?xml version="1.0" ?>
<testsuites disabled="0" errors="1" failures="1" tests="5" time="0.0">
  <testsuite disabled="0" errors="1" failures="1" name="mutmut" skipped="1" tests="5" time="0">
    <testcase name="Mutant #1" file="calc.py" line="2" time="0.0"><system-out>    return a + b</system-out></testcase>
    <testcase name="Mutant #2" file="calc.py" line="2" time="0.0"><failure type="failure" message="bad_survived">--- calc.py
+++ calc.py
-    return a + b
+    return a - b</failure><system-out>    return a + b</system-out></testcase>
    <testcase name="Mutant #3" file="calc.py" line="3" time="0.0"><error type="timeout" message="bad_timeout">...</error></testcase>
    <testcase name="Mutant #4" file="calc.py" line="4" time="0.0"><skipped type="skipped" message="untested"/></testcase>
    <testcase name="Mutant #5" file="calc.py" line="9" time="0.0"><failure type="failure" message="bad_survived">unchanged line</failure></testcase>
  </testsuite>
</testsuites>`;

  function fakeMutmut(runExit: number, report: string): string {
    const reportFile = join(bin, "mutmut-report.xml");
    writeFileSync(reportFile, report);
    return script(
      "mutmut",
      [
        'if [ "$1" = run ]; then',
        '  case "$*" in *"--paths-to-mutate calc.py"*) ;; *) echo "bad args: $*" >&2; exit 9 ;; esac',
        `  exit ${runExit}`,
        "fi",
        `if [ "$1" = junitxml ]; then cat '${reportFile}'; exit 0; fi`,
        "exit 9",
      ].join("\n"),
    );
  }

  const pyLines = () => new Map([["calc.py", new Set([2, 3, 4])]]);

  it("mutmut: statuses map and a mutant on an unchanged line is dropped", async () => {
    const program = fakeMutmut(2, mutmutXml);
    const r = await runMutationTool({
      tool: "mutmut",
      program,
      root,
      files: ["calc.py"],
      lines: pyLines(),
      diff: "",
    });
    expect(r.refused).toBeUndefined();
    expect(r.tool).toBe("mutmut");
    expect(r.files).toEqual(["calc.py"]);
    expect(r.mutants.map((m) => [m.line, m.status])).toEqual([
      [2, "killed"],
      [2, "survived"],
      [3, "timeout"],
      [4, "not_covered"],
    ]);
    expect(r.mutants.every((m) => m.file === "calc.py" && m.description)).toBe(true);
  });

  it("mutmut: a failing baseline (fatal exit bit) is refused, never a pass", async () => {
    const program = fakeMutmut(1, mutmutXml);
    const r = await runMutationTool({
      tool: "mutmut",
      program,
      root,
      files: ["calc.py"],
      lines: pyLines(),
      diff: "",
    });
    expect(r.refused).toBeTruthy();
    expect(r.mutants).toEqual([]);
  });

  for (const [label, report] of [
    ["an empty", ""],
    ["a garbage", "not xml at all <<<"],
  ] as const) {
    it(`mutmut: ${label} report is refused`, async () => {
      const r = await runMutationTool({
        tool: "mutmut",
        program: fakeMutmut(0, report),
        root,
        files: ["calc.py"],
        lines: pyLines(),
        diff: "",
      });
      expect(r.refused).toBeTruthy();
      expect(r.mutants).toEqual([]);
    });
  }

  // ---- cargo-mutants ---------------------------------------------------------

  const rsDiff = [
    "diff --git a/src/lib.rs b/src/lib.rs",
    "--- a/src/lib.rs",
    "+++ b/src/lib.rs",
    "@@ -1,0 +2,3 @@",
    "+pub fn add(a: i32, b: i32) -> i32 {",
    "+    a + b",
    "+}",
    "",
  ].join("\n");
  const mutant = (file: string, line: number, replacement: string, summary: string) => ({
    scenario: {
      Mutant: {
        package: "demo",
        file,
        function: { function_name: "add", return_type: "-> i32" },
        span: { start: { line, column: 5 }, end: { line, column: 10 } },
        replacement,
        genre: "BinaryOperator",
      },
    },
    summary,
  });
  const outcomes = (baseline: string) =>
    JSON.stringify({
      outcomes: [
        { scenario: "Baseline", summary: baseline },
        mutant("src/lib.rs", 3, "-", "CaughtMutant"),
        mutant("src/lib.rs", 3, "*", "MissedMutant"),
        mutant("src/lib.rs", 2, "0", "Unviable"),
        mutant("src/lib.rs", 4, "()", "Timeout"),
        mutant("src/lib.rs", 20, "+", "MissedMutant"),
      ],
      total_mutants: 5,
    });

  function fakeCargoMutants(exit: number, report: string | undefined): string {
    const reportFile = join(bin, "outcomes.json");
    if (report !== undefined) writeFileSync(reportFile, report);
    return script(
      "cargo-mutants",
      [
        'if [ "$1" != mutants ]; then echo "want the cargo subcommand name first" >&2; exit 9; fi',
        'out=""; diff=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in --output) out="$2"; shift ;; --in-diff) diff="$2"; shift ;; esac',
        "  shift",
        "done",
        'if [ -z "$out" ] || [ ! -f "$diff" ]; then echo "missing --output or --in-diff" >&2; exit 9; fi',
        "grep -q 'a + b' \"$diff\" || { echo 'diff not passed' >&2; exit 9; }",
        'mkdir -p "$out/mutants.out"',
        report === undefined ? "" : `cat '${reportFile}' > "$out/mutants.out/outcomes.json"`,
        `exit ${exit}`,
      ].join("\n"),
    );
  }
  const rsLines = () => new Map([["src/lib.rs", new Set([2, 3, 4])]]);

  it("cargo-mutants: statuses map and a mutant on an unchanged line is dropped", async () => {
    const r = await runMutationTool({
      tool: "cargo-mutants",
      program: fakeCargoMutants(2, outcomes("Success")),
      root,
      files: ["src/lib.rs"],
      lines: rsLines(),
      diff: rsDiff,
    });
    expect(r.refused).toBeUndefined();
    expect(r.mutants.map((m) => [m.line, m.status])).toEqual([
      [3, "killed"],
      [3, "survived"],
      [2, "stillborn"],
      [4, "timeout"],
    ]);
    expect(r.mutants[1]?.description).toContain("*");
  });

  it("cargo-mutants: a failing Baseline scenario is refused", async () => {
    const r = await runMutationTool({
      tool: "cargo-mutants",
      program: fakeCargoMutants(4, outcomes("Failure")),
      root,
      files: ["src/lib.rs"],
      lines: rsLines(),
      diff: rsDiff,
    });
    expect(r.refused).toBeTruthy();
    expect(r.mutants).toEqual([]);
  });

  for (const [label, report] of [
    ["a missing", undefined],
    ["an empty", ""],
    ["a garbage", "{not json"],
    ["a shapeless", '{"total_mutants": 3}'],
  ] as const) {
    it(`cargo-mutants: ${label} report is refused`, async () => {
      const r = await runMutationTool({
        tool: "cargo-mutants",
        program: fakeCargoMutants(0, report),
        root,
        files: ["src/lib.rs"],
        lines: rsLines(),
        diff: rsDiff,
      });
      expect(r.refused).toBeTruthy();
      expect(r.mutants).toEqual([]);
    });
  }

  // ---- PIT -------------------------------------------------------------------

  const javaFile = "src/main/java/com/example/Calc.java";
  const pitXml = `<?xml version="1.0" encoding="UTF-8"?>
<mutations partial="false">
<mutation detected='true' status='KILLED' numberOfTestsRun='1'><sourceFile>Calc.java</sourceFile><mutatedClass>com.example.Calc</mutatedClass><mutatedMethod>add</mutatedMethod><methodDescription>(II)I</methodDescription><lineNumber>4</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.MathMutator</mutator><indexes><index>2</index></indexes><blocks><block>0</block></blocks><killingTest>com.example.CalcTest.adds</killingTest><description>Replaced integer addition with subtraction</description></mutation>
<mutation detected='false' status='SURVIVED' numberOfTestsRun='1'><sourceFile>Calc.java</sourceFile><mutatedClass>com.example.Calc$Inner</mutatedClass><mutatedMethod>add</mutatedMethod><methodDescription>(II)I</methodDescription><lineNumber>4</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.returns.PrimitiveReturnsMutator</mutator><indexes><index>3</index></indexes><blocks><block>0</block></blocks><killingTest/><description>replaced int return with 0 for com/example/Calc::add</description></mutation>
<mutation detected='false' status='NO_COVERAGE' numberOfTestsRun='0'><sourceFile>Calc.java</sourceFile><mutatedClass>com.example.Calc</mutatedClass><mutatedMethod>sub</mutatedMethod><methodDescription>(II)I</methodDescription><lineNumber>5</lineNumber><mutator>x</mutator><indexes><index>1</index></indexes><blocks><block>1</block></blocks><killingTest/><description>Replaced integer subtraction with addition</description></mutation>
<mutation detected='true' status='TIMED_OUT' numberOfTestsRun='1'><sourceFile>Calc.java</sourceFile><mutatedClass>com.example.Calc</mutatedClass><mutatedMethod>loop</mutatedMethod><methodDescription>()V</methodDescription><lineNumber>6</lineNumber><mutator>x</mutator><indexes><index>1</index></indexes><blocks><block>1</block></blocks><killingTest/><description>changed conditional boundary</description></mutation>
<mutation detected='false' status='NON_VIABLE' numberOfTestsRun='0'><sourceFile>Calc.java</sourceFile><mutatedClass>com.example.Calc</mutatedClass><mutatedMethod>loop</mutatedMethod><methodDescription>()V</methodDescription><lineNumber>6</lineNumber><mutator>x</mutator><indexes><index>1</index></indexes><blocks><block>1</block></blocks><killingTest/><description>removed call</description></mutation>
<mutation detected='false' status='RUN_ERROR' numberOfTestsRun='0'><sourceFile>Calc.java</sourceFile><mutatedClass>com.example.Calc</mutatedClass><mutatedMethod>loop</mutatedMethod><methodDescription>()V</methodDescription><lineNumber>6</lineNumber><mutator>x</mutator><indexes><index>1</index></indexes><blocks><block>1</block></blocks><killingTest/><description>negated conditional</description></mutation>
<mutation detected='false' status='SURVIVED' numberOfTestsRun='1'><sourceFile>Calc.java</sourceFile><mutatedClass>com.example.Calc</mutatedClass><mutatedMethod>old</mutatedMethod><methodDescription>()V</methodDescription><lineNumber>30</lineNumber><mutator>x</mutator><indexes><index>1</index></indexes><blocks><block>1</block></blocks><killingTest/><description>unchanged line</description></mutation>
<mutation detected='false' status='SURVIVED' numberOfTestsRun='1'><sourceFile>Other.java</sourceFile><mutatedClass>com.example.Other</mutatedClass><mutatedMethod>x</mutatedMethod><methodDescription>()V</methodDescription><lineNumber>4</lineNumber><mutator>x</mutator><indexes><index>1</index></indexes><blocks><block>1</block></blocks><killingTest/><description>a file the card did not change</description></mutation>
</mutations>`;

  function seedJava(): void {
    mkdirSync(join(root, "src/main/java/com/example"), { recursive: true });
    writeFileSync(join(root, javaFile), "package com.example;\n\npublic class Calc {}\n");
  }
  function fakeBuild(name: "mvn" | "gradle", reportDir: string, exit: number, report?: string) {
    const reportFile = join(bin, `${name}-mutations.xml`);
    if (report !== undefined) writeFileSync(reportFile, report);
    const check =
      name === "mvn"
        ? [
            'case "$*" in *"org.pitest:pitest-maven:mutationCoverage"*) ;; *) echo "no goal: $*" >&2; exit 9 ;; esac',
            'case "$*" in *"-DtargetClasses=com.example.Calc*"*) ;; *) echo "no targets: $*" >&2; exit 9 ;; esac',
            'case "$*" in *"-DoutputFormats=XML"*) ;; *) exit 9 ;; esac',
          ]
        : ['case "$*" in *pitest*) ;; *) echo "no task: $*" >&2; exit 9 ;; esac'];
    return script(
      name,
      [
        ...check,
        `mkdir -p '${reportDir}'`,
        report === undefined ? "" : `cat '${reportFile}' > '${reportDir}/mutations.xml'`,
        `exit ${exit}`,
      ].join("\n"),
    );
  }
  const javaLines = () => new Map([[javaFile, new Set([4, 5, 6])]]);

  for (const [name, dir] of [
    ["mvn", "target/pit-reports"],
    ["gradle", "build/reports/pitest"],
  ] as const) {
    it(`pit via ${name}: statuses map, and mutants off the diff are dropped`, async () => {
      seedJava();
      const r = await runMutationTool({
        tool: "pit",
        program: fakeBuild(name, join(root, dir), 0, pitXml),
        root,
        files: [javaFile],
        lines: javaLines(),
        diff: "",
      });
      expect(r.refused).toBeUndefined();
      expect(r.mutants.map((m) => [m.file, m.line, m.status])).toEqual([
        [javaFile, 4, "killed"],
        [javaFile, 4, "survived"],
        [javaFile, 5, "not_covered"],
        [javaFile, 6, "timeout"],
        [javaFile, 6, "stillborn"],
        [javaFile, 6, "stillborn"],
      ]);
      expect(r.mutants[0]?.description).toContain("Replaced integer addition");
    });
  }

  it("pit: a failing build (unmutated tests fail) is refused", async () => {
    seedJava();
    const r = await runMutationTool({
      tool: "pit",
      program: fakeBuild("mvn", join(root, "target/pit-reports"), 1, pitXml),
      root,
      files: [javaFile],
      lines: javaLines(),
      diff: "",
    });
    expect(r.refused).toBeTruthy();
    expect(r.mutants).toEqual([]);
  });

  it("pit: a report left from an earlier run is never read as this run's", async () => {
    seedJava();
    mkdirSync(join(root, "target/pit-reports"), { recursive: true });
    writeFileSync(join(root, "target/pit-reports/mutations.xml"), pitXml);
    const r = await runMutationTool({
      tool: "pit",
      program: fakeBuild("mvn", join(root, "target/pit-reports"), 0, undefined),
      root,
      files: [javaFile],
      lines: javaLines(),
      diff: "",
    });
    expect(r.refused).toBeTruthy();
  });

  for (const [label, report] of [
    ["an empty", ""],
    ["a garbage", "<<< not xml"],
    ["a shapeless", "<?xml version='1.0'?><report/>"],
  ] as const) {
    it(`pit: ${label} report is refused`, async () => {
      seedJava();
      const r = await runMutationTool({
        tool: "pit",
        program: fakeBuild("mvn", join(root, "target/pit-reports"), 0, report),
        root,
        files: [javaFile],
        lines: javaLines(),
        diff: "",
      });
      expect(r.refused).toBeTruthy();
      expect(r.mutants).toEqual([]);
    });
  }

  it("a program that cannot start is refused", async () => {
    const r = await runMutationTool({
      tool: "mutmut",
      program: join(bin, "does-not-exist"),
      root,
      files: ["calc.py"],
      lines: pyLines(),
      diff: "",
    });
    expect(r.refused).toBeTruthy();
  });
});

// ---- the real tools, when installed ------------------------------------------

const installed = (tool: MutationToolId): string | undefined =>
  tool === "pit" ? (resolveProgram("mvn") ?? resolveProgram("gradle")) : resolveProgram(tool);

describe("the allowlist knows the mutation tools", () => {
  it("lists each tool by absolute path, cargo-mutants also under ~/.cargo/bin", () => {
    for (const name of ["mutmut", "cargo-mutants", "mvn", "gradle"]) {
      expect(PROGRAM_ALLOWLIST[name]?.length, name).toBeGreaterThan(0);
      expect(PROGRAM_ALLOWLIST[name]?.every(isAbsolute), name).toBe(true);
    }
    expect(PROGRAM_ALLOWLIST["cargo-mutants"]).toContain(
      join(homedir(), ".cargo", "bin", "cargo-mutants"),
    );
  });
});

describe.runIf(platform() === "darwin" && installed("mutmut") !== undefined)("real mutmut", () => {
  it("mutates a changed Python line and reads its report", async () => {
    const root = mkdtempSync(join(tmpdir(), "mt-real-py-"));
    try {
      writeFileSync(join(root, "calc.py"), "def add(a, b):\n    return a + b\n");
      mkdirSync(join(root, "tests"));
      writeFileSync(
        join(root, "tests", "test_calc.py"),
        "from calc import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
      );
      const r = await runMutationTool({
        tool: "mutmut",
        program: installed("mutmut") as string,
        root,
        files: ["calc.py"],
        lines: new Map([["calc.py", new Set([2])]]),
        diff: "",
        timeoutMs: 300_000,
      });
      expect(r.refused).toBeUndefined();
      expect(r.mutants.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 320_000);
});

describe.runIf(platform() === "darwin" && installed("cargo-mutants") !== undefined)(
  "real cargo-mutants",
  () => {
    it("mutates a changed Rust line and reads outcomes.json", async () => {
      const root = mkdtempSync(join(tmpdir(), "mt-real-rs-"));
      try {
        writeFileSync(
          join(root, "Cargo.toml"),
          '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n',
        );
        mkdirSync(join(root, "src"));
        writeFileSync(
          join(root, "src/lib.rs"),
          "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n#[test]\nfn adds() { assert_eq!(add(2, 3), 5); }\n",
        );
        const diff = [
          "--- a/src/lib.rs",
          "+++ b/src/lib.rs",
          "@@ -0,0 +1,3 @@",
          "+pub fn add(a: i32, b: i32) -> i32 {",
          "+    a + b",
          "+}",
          "",
        ].join("\n");
        const r = await runMutationTool({
          tool: "cargo-mutants",
          program: installed("cargo-mutants") as string,
          root,
          files: ["src/lib.rs"],
          lines: new Map([["src/lib.rs", new Set([1, 2, 3])]]),
          diff,
          timeoutMs: 600_000,
        });
        expect(r.refused).toBeUndefined();
        expect(r.mutants.length).toBeGreaterThan(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 620_000);
  },
);

describe.runIf(platform() === "darwin" && installed("pit") !== undefined)("real PIT", () => {
  // The confinement has no network, so a build that cannot resolve PIT (here:
  // an empty pom) fails, and a failed build is refused, never a pass.
  it("a build that cannot run PIT is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "mt-real-pit-"));
    try {
      const program = installed("pit") as string;
      // An empty build file: the build cannot load the PIT plugin.
      if (program.endsWith("gradle")) writeFileSync(join(root, "build.gradle"), "");
      else writeFileSync(join(root, "pom.xml"), "<project/>");
      mkdirSync(join(root, "src/main/java/demo"), { recursive: true });
      writeFileSync(join(root, "src/main/java/demo/A.java"), "package demo;\npublic class A {}\n");
      const r = await runMutationTool({
        tool: "pit",
        program,
        root,
        files: ["src/main/java/demo/A.java"],
        lines: new Map([["src/main/java/demo/A.java", new Set([2])]]),
        diff: "",
        timeoutMs: 300_000,
      });
      console.info(`real PIT refusal: ${r.refused}`);
      expect(r.refused).toBeTruthy();
      expect(r.mutants).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 320_000);
});
