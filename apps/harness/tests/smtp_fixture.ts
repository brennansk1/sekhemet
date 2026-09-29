import { type Socket, createServer } from "node:net";

/**
 * A small SMTP server in this process, on 127.0.0.1 unless a test names another
 * of this machine's own addresses (no network): enough
 * of RFC 5321 for a real client — nodemailer — to authenticate and deliver,
 * so the email channel is tested against the protocol rather than a mock.
 * It offers AUTH PLAIN and LOGIN, no STARTTLS, and keeps every message.
 */
export interface ReceivedMail {
  from: string;
  to: string[];
  /** The message as sent: headers, a blank line, the body (dot-unstuffed). */
  data: string;
  auth?: { user: string; pass: string };
}

export interface SmtpFixture {
  port: number;
  mails: ReceivedMail[];
  /** Every line the client sent, for asserting what crossed the wire. */
  transcript: string[];
  close: () => Promise<void>;
}

const b64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

export async function startSmtpFixture(opts: { host?: string } = {}): Promise<SmtpFixture> {
  const mails: ReceivedMail[] = [];
  const transcript: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    let auth: ReceivedMail["auth"];
    let mail: Omit<ReceivedMail, "data"> | undefined;
    let data: string[] | undefined;
    let loginStep: "user" | "pass" | undefined;
    let plainPending = false;
    let loginUser = "";
    const say = (line: string) => socket.write(`${line}\r\n`);
    say("220 fixture.localhost ESMTP ready");
    const onLine = (line: string) => {
      transcript.push(line);
      if (data) {
        if (line === ".") {
          mails.push({ ...(mail as Omit<ReceivedMail, "data">), data: data.join("\r\n") });
          data = undefined;
          mail = undefined;
          say("250 2.0.0 queued");
        } else data.push(line.startsWith("..") ? line.slice(1) : line);
        return;
      }
      if (plainPending) {
        plainPending = false;
        const [, user = "", pass = ""] = b64(line).split("\0");
        auth = { user, pass };
        say("235 2.7.0 accepted");
        return;
      }
      if (loginStep === "user") {
        loginUser = b64(line);
        loginStep = "pass";
        say("334 UGFzc3dvcmQ6");
        return;
      }
      if (loginStep === "pass") {
        auth = { user: loginUser, pass: b64(line) };
        loginStep = undefined;
        say("235 2.7.0 accepted");
        return;
      }
      const [verb = "", ...rest] = line.split(" ");
      const arg = rest.join(" ");
      switch (verb.toUpperCase()) {
        case "EHLO":
          say("250-fixture.localhost");
          say("250-AUTH PLAIN LOGIN");
          say("250 8BITMIME");
          return;
        case "HELO":
          say("250 fixture.localhost");
          return;
        case "AUTH": {
          const [method = "", initial] = arg.split(" ");
          if (method.toUpperCase() === "PLAIN") {
            if (initial) {
              const [, user = "", pass = ""] = b64(initial).split("\0");
              auth = { user, pass };
              say("235 2.7.0 accepted");
            } else {
              plainPending = true;
              say("334 ");
            }
          } else if (method.toUpperCase() === "LOGIN") {
            loginStep = "user";
            say("334 VXNlcm5hbWU6");
          } else say("504 5.5.4 unrecognised");
          return;
        }
        case "MAIL":
          mail = {
            from: /<([^>]*)>/.exec(arg)?.[1] ?? "",
            to: [],
            ...(auth ? { auth } : {}),
          };
          say("250 2.1.0 ok");
          return;
        case "RCPT":
          mail?.to.push(/<([^>]*)>/.exec(arg)?.[1] ?? "");
          say("250 2.1.5 ok");
          return;
        case "DATA":
          data = [];
          say("354 end with <CRLF>.<CRLF>");
          return;
        case "RSET":
          mail = undefined;
          say("250 2.0.0 ok");
          return;
        case "NOOP":
          say("250 2.0.0 ok");
          return;
        case "QUIT":
          say("221 2.0.0 bye");
          socket.end();
          return;
        default:
          say("502 5.5.2 not implemented");
      }
    };
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let at = buffer.indexOf("\r\n"); at !== -1; at = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        onLine(line);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, opts.host ?? "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    mails,
    transcript,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A header of a received message, unfolded (`Subject`, `To`). */
export function header(mail: ReceivedMail, name: string): string | undefined {
  const head = mail.data.split("\r\n\r\n")[0] ?? "";
  const unfolded = head.replace(/\r\n[ \t]+/g, " ");
  const re = new RegExp(`^${name}:\\s*(.*)$`, "im");
  return re.exec(unfolded)?.[1];
}

/** A received message's body, its quoted-printable soft breaks and escapes undone. */
export function body(mail: ReceivedMail | undefined): string {
  if (!mail) return "";
  const text = mail.data.split("\r\n\r\n").slice(1).join("\r\n\r\n");
  if (!/content-transfer-encoding:\s*quoted-printable/i.test(mail.data)) return text;
  return Buffer.from(
    text
      .replace(/=\r\n/g, "")
      .replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16))),
    "latin1",
  ).toString("utf8");
}
