# Security

Please do not include bearer tokens, pairing tokens, websocket tickets, cookies, API keys, or private repository data in public bug reports.

`t3ctl` deliberately refuses direct database access and uses T3's authenticated HTTP/WebSocket control surfaces. Local automatic authentication uses a temporary T3 auth session and revokes it after the command. Watch operations size that session TTL to the requested watch window plus a small margin, rather than using a long-lived standing credential.

## Reporting

For a suspected security issue, use GitHub's private security-advisory flow once this repository is public rather than opening a public issue.

Useful reports include the t3ctl version, T3 Code version, orchestration protocol version, operating system, command shape with secrets removed, and a minimal reproduction.

Do not upload `.t3ctl/`, T3 state databases, auth stores, environment files, or logs containing credentials.