import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EventLog } from "@sekhemet/kernel";
import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Failure, Identity, SignedIn } from "./identity.js";
import { personEmail, personName } from "./members.js";
import { normalAddress } from "./settings.js";

/**
 * Passkeys (WebAuthn; teams item 12, DEC-38) with SimpleWebAuthn. An Admin
 * turns them on (`[identity] sources` holds "passkeys") and sets
 * `public_url`, whose host is the relying party. A signed-in person
 * registers a passkey; anyone may then sign in with one. The public key
 * lives in the credential store; the ledger records `passkey/registered`
 * with an opaque reference, and each sign-in as `session/started`.
 */
const CHALLENGE_MS = 5 * 60_000;

export class Passkeys {
  private readonly challenges = new Map<string, { principal?: string; expires: number }>();
  public readonly rpID: string;
  public readonly origin: string;

  constructor(
    private readonly identity: Identity,
    private readonly db: DatabaseSync,
    private readonly log: EventLog,
    publicUrl: string,
    private readonly now: () => number = Date.now,
  ) {
    const url = new URL(publicUrl);
    this.rpID = url.hostname;
    this.origin = url.origin;
  }

  private remember(challenge: string, principal?: string): void {
    const t = this.now();
    for (const [c, v] of [...this.challenges]) if (v.expires <= t) this.challenges.delete(c);
    this.challenges.set(challenge, {
      ...(principal ? { principal } : {}),
      expires: t + CHALLENGE_MS,
    });
  }

  /** A challenge is good once, before it expires, for the person it was issued to. */
  private consume(challenge: string, principal?: string): boolean {
    const hit = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    if (!hit || hit.expires <= this.now()) return false;
    return principal === undefined || hit.principal === principal;
  }

  public async registrationOptions(principal: string) {
    const existing = this.identity.store.read().passkeys[principal] ?? [];
    const options = await generateRegistrationOptions({
      rpName: this.identity.settings.workspace,
      rpID: this.rpID,
      userName: personEmail(this.db, principal) ?? principal,
      userDisplayName: personName(this.db, principal) ?? "",
      userID: new TextEncoder().encode(principal),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({
        id: p.id,
        ...(p.transports ? { transports: p.transports } : {}),
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    this.remember(options.challenge, principal);
    return options;
  }

  public async register(
    principal: string,
    response: RegistrationResponseJSON,
  ): Promise<{ ok: true; passkey: string } | Failure> {
    let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verified = await verifyRegistrationResponse({
        response,
        expectedChallenge: (c) => this.consume(c, principal),
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
      });
    } catch (err) {
      return {
        ok: false,
        status: 400,
        error: `The passkey was not accepted: ${(err as Error).message}`,
      };
    }
    if (!verified.verified)
      return { ok: false, status: 400, error: "The passkey was not accepted." };
    const { credential } = verified.registrationInfo;
    const passkey = `pk_${randomBytes(9).toString("hex")}`;
    this.identity.store.update((f) => {
      const list = f.passkeys[principal] ?? [];
      list.push({
        ref: passkey,
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString("base64url"),
        counter: credential.counter,
        ...(credential.transports ? { transports: [...credential.transports] } : {}),
      });
      f.passkeys[principal] = list;
    });
    this.log.appendNow({
      actor: "human",
      type: "passkey/registered",
      payload: { principal, passkey },
      principal,
    });
    return { ok: true, passkey };
  }

  public async signInOptions() {
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: "required",
    });
    this.remember(options.challenge);
    return options;
  }

  public async signIn(
    response: AuthenticationResponseJSON,
    rawAddress: string,
  ): Promise<SignedIn | Failure> {
    const address = normalAddress(rawAddress);
    const store = this.identity.store.read();
    let owner: string | undefined;
    let entry: (typeof store.passkeys)[string][number] | undefined;
    for (const [principal, list] of Object.entries(store.passkeys)) {
      const hit = list.find((p) => p.id === response?.id);
      if (hit) {
        owner = principal;
        entry = hit;
        break;
      }
    }
    const subject = owner ? `acct:${owner}` : `addr:${address}`;
    const verdict = this.identity.limits.check(subject, address);
    if (!verdict.allowed) {
      return {
        ok: false,
        status: verdict.reason === "account_locked" ? 403 : 429,
        error: "Too many attempts, or the account is locked.",
        reason: verdict.reason,
      };
    }
    if (!owner || !entry) {
      this.identity.limits.fail(subject, address, "unknown_account");
      return { ok: false, status: 401, error: "That passkey is not registered here." };
    }
    let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: (c) => this.consume(c),
        expectedOrigin: this.origin,
        expectedRPID: this.rpID,
        credential: {
          id: entry.id,
          publicKey: new Uint8Array(Buffer.from(entry.publicKey, "base64url")),
          counter: entry.counter,
          ...(entry.transports ? { transports: entry.transports as never } : {}),
        },
        requireUserVerification: true,
      });
    } catch {
      result = { verified: false } as typeof result;
    }
    if (!result.verified) {
      this.identity.limits.fail(subject, address, "bad_credentials");
      return { ok: false, status: 401, error: "The passkey did not verify." };
    }
    const signer = owner;
    const credentialId = entry.id;
    this.identity.store.update((f) => {
      const hit = f.passkeys[signer]?.find((p) => p.id === credentialId);
      if (hit) hit.counter = result.authenticationInfo.newCounter;
    });
    this.identity.limits.succeed(subject, address);
    return this.identity.signInAs(signer, "passkey");
  }
}
