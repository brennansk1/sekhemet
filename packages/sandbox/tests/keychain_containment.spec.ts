import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ProcessSandbox, type SandboxEngine } from "../src/executor.js";
import { generateSeatbeltProfile, keychainRules } from "../src/seatbelt.js";
import {
  KEYCHAIN_FILE_SUFFIXES,
  KEYCHAIN_MACH_SERVICES,
  SYSTEM_KEYCHAIN_PATHS,
  keychainFileDenies,
} from "../src/secret_paths.js";
import { srtReset, srtWrap, withKeychainRules } from "../src/srt_engine.js";

/**
 * W2b finding (SEC-23b): a sandboxed command could read the items Sekhemet
 * keeps in the macOS keychain (the Slack webhook, the push token, the SMTP
 * password), under both engines. `mach-lookup` of `com.apple.SecurityServer`
 * was allowed, and an item written by `security add-generic-password` with no
 * `-T` — as `keychain.ts` writes them — trusts `/usr/bin/security`, so
 * `security find-generic-password -w` inside the sandbox printed it.
 *
 * Asserted by trying, under both engines, with the network off and on: a
 * throwaway keychain (never the person's login keychain) holds a canary, and
 * the sandboxed command tries every route found to it — the `security` tool
 * with the keychain's path, the same after unlocking it with its password, a
 * keychain file under a name no pattern matches (only the refused mach
 * service stops that one), and the database file itself, read, copied or
 * hard-linked into the writable root. None may yield the canary. The tools a
 * card runs still work: TLS through the system's own SecureTransport (curl)
 * and ad-hoc code signing (what the linker does for every arm64 binary).
 */
const darwin = platform() === "darwin";
const ENGINES: SandboxEngine[] = ["native", "srt"];
const SECURITY = "/usr/bin/security";
const SERVICE = "sekhemet-containment-probe";
const PASSWORD = "test";

const sec = (...args: string[]) =>
  execFileSync(SECURITY, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

let store: string;
let dbKeychain: string;
let plainKeychain: string;
const canary = `SEK-KC-CANARY-${randomBytes(8).toString("hex")}`;

beforeAll(() => {
  if (!darwin) return;
  store = mkdtempSync(join(tmpdir(), "sek-kc-store-"));
  dbKeychain = join(store, "probe.keychain-db");
  // A keychain file may carry any name: this one matches no file pattern.
  plainKeychain = join(store, "plain.store");
  for (const kc of [dbKeychain, plainKeychain]) {
    sec("create-keychain", "-p", PASSWORD, kc);
    sec("unlock-keychain", "-p", PASSWORD, kc);
    // No -T: the default access list trusts /usr/bin/security, as keychain.ts's items do.
    sec("add-generic-password", "-s", SERVICE, "-a", "acct", "-w", canary, kc);
    // The planted item is readable outside the sandbox, or the probe proves nothing.
    expect(sec("find-generic-password", "-s", SERVICE, "-w", kc).trim()).toBe(canary);
  }
});

afterAll(() => {
  if (!darwin) return;
  for (const kc of [dbKeychain, plainKeychain]) {
    try {
      sec("delete-keychain", kc);
    } catch {
      // Already gone.
    }
  }
  rmSync(store, { recursive: true, force: true });
});

describe.runIf(darwin).each(ENGINES)(
  "the keychain from inside the sandbox (%s engine)",
  (engine) => {
    const sandbox = new ProcessSandbox({ engine });
    let work: string;

    const run = (script: string, allowNetwork: boolean) =>
      sandbox.execute("/bin/sh", ["-c", script], {
        allowedPaths: [work],
        allowNetwork,
        timeoutMs: 30_000,
        cwd: work,
      });

    const expectNoCanary = (r: { stdout: string; stderr: string }) => {
      expect(r.stdout).not.toContain(canary);
      expect(r.stderr).not.toContain(canary);
    };

    afterEach(async () => {
      rmSync(work, { recursive: true, force: true });
      if (engine === "srt") await srtReset();
    });

    for (const allowNetwork of [false, true]) {
      const net = `network ${allowNetwork ? "on" : "off"}`;

      it(`the security tool cannot read a planted item (${net})`, async () => {
        work = mkdtempSync(join(tmpdir(), "sek-kc-work-"));
        const r = await run(
          `${SECURITY} find-generic-password -s ${SERVICE} -w '${dbKeychain}'; echo "exit=$?"`,
          allowNetwork,
        );
        expectNoCanary(r);
        expect(r.stdout).toMatch(/exit=[1-9]/);
      });

      it(`nor after unlocking the keychain with its password (${net})`, async () => {
        work = mkdtempSync(join(tmpdir(), "sek-kc-work-"));
        const r = await run(
          `${SECURITY} unlock-keychain -p ${PASSWORD} '${dbKeychain}'; ${SECURITY} find-generic-password -s ${SERVICE} -w '${dbKeychain}'; echo "exit=$?"`,
          allowNetwork,
        );
        expectNoCanary(r);
        expect(r.stdout).toMatch(/exit=[1-9]/);
      });

      it(`nor from a keychain file under a name no pattern matches (${net})`, async () => {
        work = mkdtempSync(join(tmpdir(), "sek-kc-work-"));
        const r = await run(
          `${SECURITY} unlock-keychain -p ${PASSWORD} '${plainKeychain}'; ${SECURITY} find-generic-password -s ${SERVICE} -w '${plainKeychain}'; echo "exit=$?"`,
          allowNetwork,
        );
        expectNoCanary(r);
        expect(r.stdout).toMatch(/exit=[1-9]/);
      });

      it(`the keychain database file cannot be read, copied or linked (${net})`, async () => {
        work = mkdtempSync(join(tmpdir(), "sek-kc-work-"));
        const r = await run(
          [
            `cat '${dbKeychain}' > /dev/null 2>&1; echo "cat=$?"`,
            `cp '${dbKeychain}' copy.keychain-db 2>&1; echo "cp=$?"`,
            `ln '${dbKeychain}' linked 2>&1; echo "ln=$?"`,
            // clonefile(2), a separate Seatbelt operation from a read.
            `cp -c '${dbKeychain}' cloned.bin 2>&1; echo "clone=$?"`,
            `cat cloned.bin > /dev/null 2>&1; echo "readclone=$?"`,
            `${SECURITY} find-generic-password -s ${SERVICE} -w copy.keychain-db; echo "copied=$?"`,
            `${SECURITY} find-generic-password -s ${SERVICE} -w linked; echo "linked=$?"`,
          ].join("\n"),
          allowNetwork,
        );
        expectNoCanary(r);
        expect(r.stdout).toMatch(/cat=[1-9]/);
        expect(r.stdout).toMatch(/cp=[1-9]/);
        expect(r.stdout).toMatch(/ln=[1-9]/);
        expect(r.stdout).toMatch(/clone=[1-9]/);
        expect(r.stdout).toMatch(/readclone=[1-9]/);
        expect(r.stdout).toMatch(/copied=[1-9]/);
        expect(r.stdout).toMatch(/linked=[1-9]/);
      });

      // The rule judges a file by its name, so these stand-in keychains hold
      // the canary in plain text: any route that yields their bytes shows it.
      it(`a keychain file inside the writable root cannot be renamed, swapped or cloned away from its name (${net})`, async () => {
        work = mkdtempSync(join(tmpdir(), "sek-kc-work-"));
        writeFileSync(join(work, "inroot.keychain-db"), canary);
        mkdirSync(join(work, "sub"));
        writeFileSync(join(work, "sub", "nested.KEYCHAIN"), canary);
        writeFileSync(join(work, "other.bin"), "other");
        const r = await run(
          [
            `mv inroot.keychain-db moved.bin 2>&1; echo "mv=$?"`,
            "cat moved.bin 2>&1",
            `cp -c inroot.keychain-db cloned.bin 2>&1; echo "clone=$?"`,
            "cat cloned.bin 2>&1",
            // clonefile(2) of the directory succeeds, but the copy keeps the name.
            "cp -cR sub sub2 2>&1",
            "cat sub2/nested.KEYCHAIN 2>&1",
            `mv sub2/nested.KEYCHAIN sub2/plain.bin 2>&1; echo "mvclone=$?"`,
            "cat sub2/plain.bin 2>&1",
            `ln inroot.keychain-db hard.bin 2>&1; echo "ln=$?"`,
            "cat hard.bin 2>&1",
            // A swap needs a write to the keychain's name.
            `/bin/mv -f other.bin inroot.keychain-db 2>&1; echo "over=$?"`,
          ].join("\n"),
          allowNetwork,
        );
        expectNoCanary(r);
        expect(r.stdout).toMatch(/mv=[1-9]/);
        expect(r.stdout).toMatch(/clone=[1-9]/);
        expect(r.stdout).toMatch(/mvclone=[1-9]/);
        expect(r.stdout).toMatch(/ln=[1-9]/);
        expect(r.stdout).toMatch(/over=[1-9]/);
        // Outside the sandbox the planted file is intact.
        expect(readFileSync(join(work, "inroot.keychain-db"), "utf8")).toBe(canary);
      });

      it(`securityd's save files and the keychain SEKHEMET_KEYCHAIN_FILE names, under any name, cannot be read (${net})`, async () => {
        work = mkdtempSync(join(tmpdir(), "sek-kc-work-"));
        const shadow = join(store, "probe.keychain-db.sb-1a2b3c4d-XyZ012");
        const own = join(store, "sekhemet-items.store");
        const ownShadow = `${own}.sb-5e6f7a8b-AbC345`;
        for (const f of [shadow, own, ownShadow]) writeFileSync(f, canary);
        vi.stubEnv("SEKHEMET_KEYCHAIN_FILE", own);
        try {
          const r = await run(
            [shadow, own, ownShadow]
              .map(
                (f, i) =>
                  `cat '${f}' 2>&1; echo "read${i}=$?"; cp -c '${f}' c${i}.bin 2>&1; cat c${i}.bin 2>&1`,
              )
              .join("\n"),
            allowNetwork,
          );
          expectNoCanary(r);
          for (const i of [0, 1, 2]) expect(r.stdout).toMatch(new RegExp(`read${i}=[1-9]`));
        } finally {
          vi.unstubAllEnvs();
          for (const f of [shadow, own, ownShadow]) rmSync(f, { force: true });
        }
      });
    }

    it("TLS through the system's SecureTransport and ad-hoc signing still work", async () => {
      work = mkdtempSync(join(tmpdir(), "sek-kc-work-"));
      // A self-signed certificate for localhost, made outside the sandbox.
      execFileSync(
        "/usr/bin/openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=DNS:localhost",
          "-keyout",
          join(work, "key.pem"),
          "-out",
          join(work, "cert.pem"),
        ],
        { stdio: "ignore" },
      );
      const server = createServer(
        { key: readFileSync(join(work, "key.pem")), cert: readFileSync(join(work, "cert.pem")) },
        (_req, res) => res.end("TLS-OK"),
      );
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      try {
        const r = await sandbox.execute(
          "/bin/sh",
          [
            "-c",
            [
              `/usr/bin/curl -sS --noproxy '*' --cacert cert.pem https://localhost:${port}/; echo; echo "curl=$?"`,
              `cp /bin/echo ./signed && /usr/bin/codesign --force -s - ./signed 2>&1; echo "codesign=$?"`,
              "./signed ran",
            ].join("\n"),
          ],
          {
            allowedPaths: [work],
            allowNetwork: false,
            localPorts: [port],
            timeoutMs: 30_000,
            cwd: work,
          },
        );
        expect(r.stdout).toContain("TLS-OK");
        expect(r.stdout).toContain("curl=0");
        expect(r.stdout).toContain("codesign=0");
        expect(r.stdout).toContain("ran");
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    // Security item 11a's measured cost, backed here (fix round F1 review): a
    // program listing the system's trust settings in its own process, as
    // rustls-native-certs does, gets none inside the sandbox; trust evaluation
    // of a system root still passes under the native engine (srt's own
    // allowlist leaves out trustd, so there it fails with or without these
    // rules); code-signature verification still works.
    it("the cost: trust-settings roots listed in-process are gone; system-root evaluation and codesign --verify stay", async () => {
      work = mkdtempSync(join(tmpdir(), "sek-kc-work-"));
      const pem = execFileSync(
        SECURITY,
        [
          "find-certificate",
          "-a",
          "-p",
          "/System/Library/Keychains/SystemRootCertificates.keychain",
        ],
        { encoding: "utf8" },
      );
      const first = pem.slice(0, pem.indexOf("-----END CERTIFICATE-----") + 25);
      writeFileSync(join(work, "root.pem"), `${first}\n`);
      const roots =
        '/usr/bin/osascript -l JavaScript -e \'ObjC.import("Security"); var r = Ref(); var st = $.SecTrustSettingsCopyCertificates(2, r); "roots=" + (st == 0 ? ObjC.castRefToObject(r[0]).count : 0)\'';
      const outside = execFileSync("/bin/sh", ["-c", roots], { encoding: "utf8" });
      expect(Number(/roots=(\d+)/.exec(outside)?.[1])).toBeGreaterThan(0);
      const r = await run(
        [
          `${roots} 2>&1`,
          `${SECURITY} verify-cert -c root.pem -L -l -p basic > /dev/null 2>&1; echo "root=$?"`,
          `cp /bin/echo ./signed && /usr/bin/codesign --force -s - ./signed 2>/dev/null && /usr/bin/codesign --verify --strict ./signed; echo "verify=$?"`,
        ].join("\n"),
        false,
      );
      expect(r.stdout).toContain("roots=0");
      expect(r.stdout).toContain("verify=0");
      if (engine === "native") expect(r.stdout).toContain("root=0");
    });
  },
);

describe("SEC-23b: one keychain table, last in both engines' profiles", () => {
  const opts = { allowedPaths: ["/private/tmp/w"], allowNetwork: false, timeoutMs: 1000, cwd: "/" };

  it("names the keychain's services, the System keychain and keychain files, each with a reason", () => {
    const names = KEYCHAIN_MACH_SERVICES.map((s) => s.name);
    expect(names).toContain("com.apple.SecurityServer");
    // Keychain sharing, escrow backup and the authentication prompts (fix round F1 review).
    for (const n of [
      "com.apple.keychainsharingmessagingd",
      "com.apple.SecureBackupDaemon",
      "com.apple.LocalAuthentication.",
      "com.apple.CoreAuthentication.",
    ]) {
      expect(names).toContain(n);
    }
    // srt's allowlist names com.apple.securityd.xpc; the prefix covers it and secd's others.
    expect(KEYCHAIN_MACH_SERVICES.find((s) => s.name === "com.apple.securityd.")?.prefix).toBe(
      true,
    );
    expect(SYSTEM_KEYCHAIN_PATHS.map((e) => e.path)).toContain("/Library/Keychains");
    expect([...KEYCHAIN_FILE_SUFFIXES].sort()).toEqual([".keychain", ".keychain-db"]);
    for (const e of [...KEYCHAIN_MACH_SERVICES, ...SYSTEM_KEYCHAIN_PATHS]) {
      expect(e.why.length).toBeGreaterThan(5);
    }
    // Certificate trust stays reachable: TLS needs it.
    expect(names.some((n) => n.includes("trustd"))).toBe(false);
  });

  it("the rules deny every service and file of the table, keychain names in any case", () => {
    const rules = keychainRules();
    expect(rules).toContain('(deny mach-lookup (global-name "com.apple.SecurityServer"))');
    expect(rules).toContain('(deny mach-lookup (global-name-prefix "com.apple.securityd."))');
    for (const s of KEYCHAIN_MACH_SERVICES) expect(rules).toContain(`"${s.name}"`);
    expect(rules).toContain('(deny file-read-data (subpath "/Library/Keychains"))');
    // A keychain name, and securityd's save file beside it, neither read nor written (renamed).
    const dbName = "[.][Kk][Ee][Yy][Cc][Hh][Aa][Ii][Nn]-[Dd][Bb]([.][Ss][Bb]-[^/]*)?$";
    expect(rules).toContain(`(deny file-read-data (regex #"${dbName}"))`);
    expect(rules).toContain(`(deny file-write* (regex #"${dbName}"))`);
    // Named as well: srt's own allow names these two, and a named rule outranks a wildcard.
    expect(rules).toContain(`(deny file-write-create file-write-unlink (regex #"${dbName}"))`);
    expect(rules).not.toContain("'");
  });

  it("the keychain SEKHEMET_KEYCHAIN_FILE names is denied by its path, whatever its name", () => {
    expect(keychainFileDenies({})).toEqual([]);
    expect(keychainFileDenies({ SEKHEMET_KEYCHAIN_FILE: "  /x/items.store " })).toEqual([
      "/x/items.store",
    ]);
    const rules = keychainRules({ SEKHEMET_KEYCHAIN_FILE: "/x/it(1).store" });
    expect(rules).toContain('(deny file-read-data (literal "/x/it(1).store"))');
    expect(rules).toContain('(deny file-write* (literal "/x/it(1).store"))');
    expect(rules).toContain(
      '(deny file-write-create file-write-unlink (literal "/x/it(1).store"))',
    );
    expect(rules).toContain(
      '(deny file-read-data (regex #"^/x/it\\(1\\)\\.store[.][Ss][Bb]-[^/]*$"))',
    );
    expect(keychainRules({})).not.toContain("literal");
  });

  it("the native profile ends with them, after its broad mach-lookup and every allow", () => {
    for (const extra of [{}, { allowNetwork: true }, { browser: true, denyHomeReads: true }]) {
      const profile = generateSeatbeltProfile({ ...opts, ...extra });
      expect(profile.trimEnd().endsWith(keychainRules())).toBe(true);
      expect(profile.indexOf("(allow mach-lookup)")).toBeLessThan(profile.indexOf(keychainRules()));
    }
  });

  it("srt's profile gets them last, inside its quoted word, quotes of either escape skipped", () => {
    const cmd = (body: string) =>
      `env A='x' /usr/bin/sandbox-exec -p '(version 1)\n${body}' /bin/bash -c 'exec '"'"'/bin/echo'"'"''`;
    const out = withKeychainRules(
      cmd(
        `(allow mach-lookup (global-name "com.apple.SecurityServer"))\n(regex #"it'"'"'s")\n(allow x '\\''y'\\'')`,
      ),
    );
    const at = out.indexOf(keychainRules());
    expect(at).toBeGreaterThan(out.indexOf("(allow x"));
    expect(out.slice(at + keychainRules().length)).toBe(
      `\n' /bin/bash -c 'exec '"'"'/bin/echo'"'"''`,
    );
    expect(out.slice(0, at)).toContain(`it'"'"'s`);
  });

  it("refuses a command with no profile, or one whose profile never ends", () => {
    expect(() => withKeychainRules("/bin/bash -c 'exec x'")).toThrow(
      /did not hand Seatbelt a profile/,
    );
    expect(() => withKeychainRules("/usr/bin/sandbox-exec -p '(version 1)")).toThrow(/did not end/);
  });

  it.runIf(darwin)("srt's real command carries them after its own keychain allow", async () => {
    for (const allowNetwork of [false, true]) {
      const { argv } = await srtWrap("/bin/echo", ["hi"], { ...opts, allowNetwork });
      const cmd = argv[1] as string;
      const allow = cmd.indexOf('(allow mach-lookup (global-name "com.apple.SecurityServer"))');
      expect(allow).toBeGreaterThan(0);
      expect(cmd.indexOf(keychainRules())).toBeGreaterThan(allow);
      expect(cmd.indexOf(keychainRules())).toBeGreaterThan(cmd.lastIndexOf("(allow "));
    }
    await srtReset();
  });
});
