# Account linking

Linking always starts on the website and finishes with one command run by your coding Agent.

1. Sign in at https://vibe.fde.fan/app/ (GitHub or email code).
2. Click **Add device** and copy the prompt.
3. Paste the prompt to your coding Agent. It runs one command:

   ```bash
   printf '%s' '<one-time code>' | npx -y @vibe-monitor/setup@latest account link --account '<your account>'
   ```

4. Back on the website, check the device shown (Agent, version) and click **Confirm ownership**.

## What the command does

- Reads the one-time code from stdin. Codes are never accepted as command arguments.
- Asks the account service which account the code belongs to and stops if it is not the `--account` you named.
- Proves this installation:
  - Free/stable: signs `sha256(code)`, installation ID and a timestamp with an Ed25519 key kept in the OS vault (Keychain, DPAPI, Secret Service). The first successful link stores the **public** key; later links must be signed by the same key.
  - Upgraded Beta installations: uses the existing installation credential from the OS vault.
- Sends nothing else: no source, paths, project names, prompts or secrets.

The code expires after 10 minutes and works once. The website confirmation is the final consent; an unconfirmed device never appears in the dashboard.
