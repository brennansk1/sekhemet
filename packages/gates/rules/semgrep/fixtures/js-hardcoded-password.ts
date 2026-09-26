// ruleid: sekhemet.js-hardcoded-password
const DB_PASSWORD = "Sup3rS3cret!2024";
// ruleid: sekhemet.js-hardcoded-password
const config = { apiKey: "a1b2c3d4e5f6g7h8i9j0", region: "eu-west-1" };

export function connect(client: Client) {
  // ruleid: sekhemet.js-hardcoded-password
  return client.login({ user: "admin", password: "hunter2hunter2" });
}

// ok: sekhemet.js-hardcoded-password
const password = process.env.DB_PASSWORD;
// ok: sekhemet.js-hardcoded-password
const passwordLabel = "Enter your password";
// ok: sekhemet.js-hardcoded-password
const field = { inputType: "password", clientSecret: "" };
// ok: sekhemet.js-hardcoded-password
const form = { password: "password", confirm: "<password>" };

export { DB_PASSWORD, config, password, passwordLabel, field, form };
